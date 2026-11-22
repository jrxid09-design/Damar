using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Collections.Generic;

// SCM-compatible host. Installation and identity/ACL provisioning are separate.
public sealed class AuthorityService : ServiceBase {
    volatile bool stopping;
    Thread listener;
    NamedPipeServerStream active;
    readonly string configPath;
    Config config;
    volatile bool uncertain;
    string uncertaintyFile;
    FileStream uncertaintyMarker;
    readonly List<SafeFileHandle> deploymentHandles = new List<SafeFileHandle>();
    readonly Dictionary<string, SafeFileHandle> deploymentObjects = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    public sealed class Config {
        public int CoreProcessId;
        public long CoreProcessStartUtcTicks;
        public string ServiceSid, CoreSid, OwnerSid, PipeName, Node, Worker, EngineConfig, Storage;
        public string NodeSha256, WorkerSha256, EngineConfigSha256, AdmissionSha256;
    }
    AuthorityService(string file, bool consoleMode) {
        ServiceName = "DamarProtectedAuthority"; CanStop = true;
        configPath = Path.GetFullPath(file);
    }
    protected override void OnStart(string[] args) {
        config = new JavaScriptSerializer().Deserialize<Config>(ReadBootstrap());
        if (WindowsIdentity.GetCurrent().User.Value != config.ServiceSid) throw new InvalidOperationException("AUTHORITY_IDENTITY_MISMATCH");
        if (config.ServiceSid == config.CoreSid || config.OwnerSid == config.CoreSid || config.ServiceSid == config.OwnerSid) throw new InvalidOperationException("AUTHORITY_ROLE_SEPARATION_REQUIRED");
        if (String.IsNullOrEmpty(config.PipeName) || config.PipeName.Length > 100 || config.PipeName.IndexOfAny(new [] {'\\', '/', ':'}) >= 0) throw new InvalidOperationException("AUTHORITY_PIPE_INVALID");
        foreach (string file in new [] { config.Node, config.Worker, config.EngineConfig }) if (!Path.IsPathRooted(file) || !File.Exists(file)) throw new InvalidOperationException("AUTHORITY_PATH_INVALID");
        uncertaintyFile = Path.Combine(config.Storage, "authority-host.uncertain");
        ValidateDeployment();
        RefuseStartupMarker(config.Storage);
        stopping = false; listener = new Thread(Listen); listener.IsBackground = true; listener.Start();
    }
    // File.Exists reports false for an existing but inaccessible marker (fail-open).
    // Enumeration throws on denied access, and any recovery marker refuses startup.
    public static void RefuseStartupMarker(string storage) {
        foreach (string pattern in new [] {"authority-host.uncertain", "admission.uncertain", "admission.lock"})
            if (Directory.GetFileSystemEntries(storage, pattern).Length != 0) throw new InvalidOperationException("AUTHORITY_RECOVERY_REQUIRED");
    }
    string ReadBootstrap() {
        // The executable directory is the bootstrap boundary, independent of untrusted config fields.
        string bootstrapSid=WindowsIdentity.GetCurrent().User.Value;
        if (!bootstrapSid.StartsWith("S-1-5-80-", StringComparison.Ordinal)) throw new IOException("AUTHORITY_BOOTSTRAP_SERVICE_IDENTITY_REQUIRED");
        string boundary=Path.GetDirectoryName(typeof(AuthorityService).Assembly.Location);
        if (!configPath.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_BOOTSTRAP_BOUNDARY_REQUIRED");
        var paths=new List<string>();
        paths.Add(configPath);
        for (var parent=Directory.GetParent(configPath); parent != null; parent=parent.Parent) paths.Add(parent.FullName);
        paths.Reverse();
        foreach (string path in paths) {
            bool file=String.Equals(path, configPath, StringComparison.OrdinalIgnoreCase);
            var handle=CreateFile(path, file ? 0x80020000u : 0x20080u, file ? 1u : 3u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException("AUTHORITY_BOOTSTRAP_OPEN_FAILED"); }
            deploymentHandles.Add(handle); deploymentObjects.Add(Path.GetFullPath(path), handle);
            FileInformation info;
            if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || (file && info.Links != 1)) throw new IOException("AUTHORITY_BOOTSTRAP_OBJECT_INVALID");
            var final=new StringBuilder(32768);
            if (GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0) == 0 || !String.Equals(final.ToString().TrimEnd('\\'), ("\\\\?\\" + path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_BOOTSTRAP_PATH_MISMATCH");
            var acl=OpenedAcl(path);
            string owner=acl.GetOwner(typeof(SecurityIdentifier)).Value;
            string installer=new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier)).Value;
            if (owner != "S-1-5-18" && owner != "S-1-5-32-544" && (!file && !path.StartsWith(boundary, StringComparison.OrdinalIgnoreCase) ? owner != installer : owner != WindowsIdentity.GetCurrent().User.Value)) throw new IOException("AUTHORITY_BOOTSTRAP_OWNER_UNTRUSTED");
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                if (rule.AccessControlType != AccessControlType.Allow || (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                string sid=rule.IdentityReference.Value;
                if (sid == "S-1-5-18" || sid == "S-1-5-32-544" || sid == installer || sid == WindowsIdentity.GetCurrent().User.Value) continue;
                var forbidden=FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
                if (file || path.StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) forbidden |= FileSystemRights.Write;
                if ((rule.FileSystemRights & forbidden) != 0 || file) throw new IOException("AUTHORITY_BOOTSTRAP_ACL_UNTRUSTED");
            }
        }
        var pinned=deploymentObjects[configPath];
        using (var borrowed=new SafeFileHandle(pinned.DangerousGetHandle(), false))
        using (var stream=new FileStream(borrowed, FileAccess.Read)) {
            if (stream.Length > 65536) throw new IOException("AUTHORITY_BOOTSTRAP_SIZE_INVALID");
            using (var reader=new StreamReader(stream)) return reader.ReadToEnd();
        }
    }
    protected override void OnStop() {
        stopping = true;
        var pipe = active; if (pipe != null) pipe.Dispose();
        // Never terminate a worker with an uncertain durable mutation.
        if (listener != null && !listener.Join(15000)) throw new InvalidOperationException("AUTHORITY_STOP_UNCERTAIN");
    }
    void Listen() {
        while (!stopping) {
            try {
                var acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false);
                acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                foreach (string sid in new [] {config.ServiceSid, config.CoreSid, config.OwnerSid})
                    acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
                using (var pipe = new NamedPipeServerStream(config.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 8192, 8192, acl)) {
                    active = pipe; pipe.WaitForConnection();
                    string sid = null;
                    pipe.RunAsClient(() => { sid = WindowsIdentity.GetCurrent().User.Value; });
                    // ACL plus token identity; never trust a role field in JSON.
                    if (sid != config.CoreSid && sid != config.OwnerSid) continue;
                    var bytes = new MemoryStream(); byte[] one = new byte[1];
                    var deadline = Stopwatch.StartNew(); bool terminated = false;
                    while (bytes.Length <= 8192) {
                        var read = pipe.ReadAsync(one, 0, 1);
                        int remaining = 5000 - (int)deadline.ElapsedMilliseconds;
                        if (remaining <= 0 || !read.Wait(remaining)) throw new IOException("AUTHORITY_READ_TIMEOUT");
                        if (read.Result == 0) break;
                        if (one[0] == 10) { terminated = true; break; } bytes.WriteByte(one[0]);
                    }
                    if (!terminated) throw new IOException("AUTHORITY_FRAME_INVALID");
                    if (bytes.Length > 8192) throw new IOException("AUTHORITY_MESSAGE_TOO_LARGE");
                    string text = Encoding.UTF8.GetString(bytes.ToArray());
                    var request = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(text);
                    string op = request.ContainsKey("operation") ? request["operation"] as string : null;
                    string result;
                    if (op != "status" && sid != config.OwnerSid) result = "{\"success\":false,\"error\":\"AUTHORITY_OWNER_REQUIRED\"}";
                    else if (uncertain) result = "{\"success\":false,\"error\":\"AUTHORITY_RECOVERY_REQUIRED\"}";
                    else { ValidateDeployment(); result = Worker(text); }
                    byte[] reply = Encoding.UTF8.GetBytes(result + "\n");
                    var write = pipe.WriteAsync(reply, 0, reply.Length); if (!write.Wait(5000)) throw new IOException("AUTHORITY_WRITE_TIMEOUT");
                }
            } catch (Exception) {
                // Never log requests, worker output, paths or credentials.
                Trace.TraceError("AUTHORITY_REQUEST_FAILED");
                if (!stopping) Thread.Sleep(100);
            }
            finally { active = null; }
        }
    }
    string Worker(string input) {
        // Durable in-flight marker precedes worker creation, including host crash.
        BeginMarker();
        var start = new ProcessStartInfo(config.Node, "\"" + config.Worker + "\" \"" + config.EngineConfig + "\"");
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        // Prevent inherited Node loader/environment injection across the service boundary.
        start.EnvironmentVariables.Remove("NODE_OPTIONS"); start.EnvironmentVariables.Remove("NODE_PATH");
        using (var process = Process.Start(start)) {
            process.StandardInput.Write(input); process.StandardInput.Close();
            var output = Task.Factory.StartNew(() => ReadBounded(process.StandardOutput, 16384));
            var errors = Task.Factory.StartNew(() => ReadBounded(process.StandardError, 4096));
            try {
                if (!Task.WaitAll(new Task[] {output, errors}, 10000) || !process.WaitForExit(1000)) return LatchUncertain();
                var parsed = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(output.Result);
                if (!parsed.ContainsKey("success") || !(parsed["success"] is bool) || errors.Result.Length != 0 || (process.ExitCode != 0 && (bool)parsed["success"])) return LatchUncertain();
                CompleteMarker();
                return output.Result;
            } catch { return LatchUncertain(); }
        }
    }
    string LatchUncertain() {
        uncertain = true;
        // Do not kill or replay the worker: it may have committed a mutation.
        if (uncertaintyMarker == null) throw new IOException("AUTHORITY_MARKER_HANDLE_REQUIRED");
        uncertaintyMarker.Position=0;
        byte[] value = Encoding.ASCII.GetBytes("AUTHORITY_OUTCOME_UNKNOWN\n");
        uncertaintyMarker.Write(value, 0, value.Length); uncertaintyMarker.SetLength(value.Length); uncertaintyMarker.Flush(true);
        Trace.TraceError("AUTHORITY_RECOVERY_REQUIRED");
        return "{\"success\":false,\"error\":\"AUTHORITY_RECOVERY_REQUIRED\"}";
    }
    void BeginMarker() {
        if (uncertaintyMarker != null) throw new IOException("AUTHORITY_MARKER_ALREADY_OPEN");
        var handle=CreateFile(uncertaintyFile, 0x40030000, 1, IntPtr.Zero, 1, 0x80200000, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("AUTHORITY_MARKER_CREATE_FAILED"); }
        try {
            FileInformation info;
            if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x410) != 0 || info.Links != 1) throw new IOException("AUTHORITY_MARKER_OBJECT_INVALID");
            SafeFileHandle parent;
            if (!deploymentObjects.TryGetValue(Path.GetFullPath(config.Storage), out parent) || parent.IsInvalid || parent.IsClosed) throw new IOException("AUTHORITY_MARKER_PARENT_NOT_PINNED");
            var final=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity || !String.Equals(final.ToString(), "\\\\?\\" + Path.GetFullPath(uncertaintyFile), StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_MARKER_PATH_MISMATCH");
            CheckHandleAcl(handle, true);
            uncertaintyMarker=new FileStream(handle, FileAccess.Write);
            byte[] value=Encoding.ASCII.GetBytes("AUTHORITY_IN_FLIGHT\n");
            uncertaintyMarker.Write(value,0,value.Length); uncertaintyMarker.Flush(true);
        } catch { handle.Dispose(); uncertaintyMarker=null; throw; }
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, ref int information, uint size);
    void CompleteMarker() {
        if (uncertaintyMarker == null) throw new IOException("AUTHORITY_MARKER_HANDLE_REQUIRED");
        uncertaintyMarker.Flush(true);
        int remove=1;
        if (!SetFileInformationByHandle(uncertaintyMarker.SafeFileHandle, 4, ref remove, 4)) throw new IOException("AUTHORITY_MARKER_DELETE_FAILED");
        uncertaintyMarker.Dispose(); uncertaintyMarker=null;
    }
    public static string ReadBounded(TextReader reader, int maximum) {
        var value = new StringBuilder(); int ch;
        while ((ch = reader.Read()) >= 0) { if (value.Length >= maximum) throw new IOException("AUTHORITY_OUTPUT_LIMIT"); value.Append((char)ch); }
        return value.ToString();
    }
    public static void VerifyHash(string file, string expected) {
        if (expected == null || expected.Length != 64) throw new IOException("AUTHORITY_HASH_REQUIRED");
        using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) {
            string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_HASH_MISMATCH");
        }
    }
    void CheckAcl(string location, bool privateRead) {
        if ((File.GetAttributes(location) & FileAttributes.ReparsePoint) != 0) throw new IOException("AUTHORITY_REPARSE_REFUSED");
        SafeFileHandle handle;
        if (!deploymentObjects.TryGetValue(Path.GetFullPath(location), out handle)) throw new IOException("AUTHORITY_OBJECT_NOT_PINNED");
        CheckHandleAcl(handle, privateRead);
    }
    void CheckHandleAcl(SafeFileHandle handle, bool privateRead) {
        FileSystemSecurity acl = OpenedAcl(handle);
        var descriptor=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.DiscretionaryAcl == null || descriptor.Owner == null) throw new IOException("AUTHORITY_ACL_UNTRUSTED");
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            string sid = rule.IdentityReference.Value;
            bool trusted = sid == config.ServiceSid || sid == "S-1-5-18" || sid == "S-1-5-32-544";
            var mutating = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            if (!trusted && (privateRead || (rule.FileSystemRights & mutating) != 0)) throw new IOException("AUTHORITY_ACL_UNTRUSTED");
        }
        string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
        if (owner != config.ServiceSid && owner != "S-1-5-18" && owner != "S-1-5-32-544") throw new IOException("AUTHORITY_OWNER_UNTRUSTED");
    }
    [StructLayout(LayoutKind.Sequential)] public struct GenericMapping { public uint Read, Write, Execute, All; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AccessCheck(byte[] descriptor, IntPtr token, uint desired, ref GenericMapping mapping, IntPtr privileges, ref uint length, out uint granted, out bool allowed);
    public static bool EffectiveAccess(byte[] descriptor, IntPtr token, uint desired) {
        var mapping = new GenericMapping { Read=0x120089, Write=0x120116, Execute=0x1200a0, All=0x1f01ff };
        uint length=4096, granted; bool allowed;
        IntPtr privileges=Marshal.AllocHGlobal((int)length);
        try {
            if (!AccessCheck(descriptor, token, desired, ref mapping, privileges, ref length, out granted, out allowed)) throw new IOException("AUTHORITY_ACCESS_CHECK_FAILED");
            return allowed;
        } finally { Marshal.FreeHGlobal(privileges); }
    }
    public static IntPtr OpenCoreToken(int pid, string sid) {
        return OpenCoreTokenBound(pid, sid, 0);
    }
    public static IntPtr OpenCoreTokenBound(int pid, string sid, long expectedStartUtcTicks) {
        IntPtr process=OpenProcess(0x1000, false, pid), token=IntPtr.Zero, duplicate=IntPtr.Zero;
        if (process == IntPtr.Zero) throw new IOException("AUTHORITY_CORE_PROCESS_REQUIRED");
        try {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || exit != 0) throw new IOException("AUTHORITY_CORE_PROCESS_EXITED");
            if (expectedStartUtcTicks != 0 && DateTime.FromFileTimeUtc(creation).Ticks != expectedStartUtcTicks) throw new IOException("AUTHORITY_CORE_PROCESS_REUSED");
            if (!OpenProcessToken(process, 0x000a, out token)) throw new IOException("AUTHORITY_CORE_TOKEN_REQUIRED");
            using (var identity=new WindowsIdentity(token)) {
                if (identity.User.Value != sid || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new IOException("AUTHORITY_CORE_TOKEN_MISMATCH");
            }
            IntPtr buffer=Marshal.AllocHGlobal(256);
            try {
                int needed;
                if (!GetTokenInformation(token, 20, buffer, 4, out needed) || Marshal.ReadInt32(buffer) != 0) throw new IOException("AUTHORITY_CORE_ELEVATED");
                if (!GetTokenInformation(token, 25, buffer, 256, out needed)) throw new IOException("AUTHORITY_CORE_INTEGRITY_REQUIRED");
                var integrity=new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
                if (integrity != "S-1-16-8192") throw new IOException("AUTHORITY_CORE_MEDIUM_REQUIRED");
            } finally { Marshal.FreeHGlobal(buffer); }
            if (!DuplicateToken(token, 2, out duplicate)) throw new IOException("AUTHORITY_CORE_TOKEN_DUPLICATION_FAILED");
            long finalCreation;
            if (!GetProcessTimes(process, out finalCreation, out exit, out kernel, out user) || exit != 0 || finalCreation != creation) {
                CloseHandle(duplicate); duplicate=IntPtr.Zero;
                throw new IOException("AUTHORITY_CORE_PROCESS_EXITED");
            }
            return duplicate;
        } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }
    public static void CheckAncestor(string location, IntPtr coreToken) {
        if ((File.GetAttributes(location) & FileAttributes.ReparsePoint) != 0) throw new IOException("AUTHORITY_REPARSE_REFUSED");
        var acl=Directory.GetAccessControl(location);
        string owner=acl.GetOwner(typeof(SecurityIdentifier)).Value;
        string installer=new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier)).Value;
        if (owner != "S-1-5-18" && owner != "S-1-5-32-544" && owner != installer) throw new IOException("AUTHORITY_ANCESTOR_OWNER_UNTRUSTED");
        // Child creation alone does not permit replacing an existing protected child.
        // Check each bit independently: asking for their union could hide partial access.
        foreach (uint right in new uint[] {0x10000, 0x40, 0x40000, 0x80000})
            if (EffectiveAccess(acl.GetSecurityDescriptorBinaryForm(), coreToken, right)) throw new IOException("AUTHORITY_ANCESTOR_REPLACEMENT_ACCESS");
    }
    FileSystemSecurity OpenedAcl(string path) {
        SafeFileHandle handle;
        if (!deploymentObjects.TryGetValue(Path.GetFullPath(path), out handle)) throw new IOException("AUTHORITY_OBJECT_NOT_PINNED");
        return OpenedAcl(handle);
    }
    FileSystemSecurity OpenedAcl(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        if (GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new IOException("AUTHORITY_PIN_SECURITY_FAILED");
        try {
            byte[] binary=new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, binary, 0, binary.Length);
            FileSystemSecurity acl=new FileSecurity(); acl.SetSecurityDescriptorBinaryForm(binary); return acl;
        } finally { LocalFree(descriptor); }
    }
    void CheckOpenedAncestor(string path, IntPtr token) {
        var acl=OpenedAcl(path);
        string owner=acl.GetOwner(typeof(SecurityIdentifier)).Value;
        string installer=new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier)).Value;
        if (owner != "S-1-5-18" && owner != "S-1-5-32-544" && owner != installer) throw new IOException("AUTHORITY_ANCESTOR_OWNER_UNTRUSTED");
        foreach (uint right in new uint[] {0x10000,0x40,0x40000,0x80000})
            if (EffectiveAccess(acl.GetSecurityDescriptorBinaryForm(), token, right)) throw new IOException("AUTHORITY_ANCESTOR_REPLACEMENT_ACCESS");
    }
    string ReadPinned(string path, string expected) {
        SafeFileHandle handle;
        if (!deploymentObjects.TryGetValue(Path.GetFullPath(path), out handle)) throw new IOException("AUTHORITY_OBJECT_NOT_PINNED");
        using (var borrowed=new SafeFileHandle(handle.DangerousGetHandle(), false))
        using (var stream=new FileStream(borrowed, FileAccess.Read)) {
            stream.Position=0;
            using (var sha=SHA256.Create()) {
                string actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (expected == null || !String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_HASH_MISMATCH");
            }
            stream.Position=0;
            if (stream.Length > 1048576) return null;
            using (var reader=new StreamReader(stream)) return reader.ReadToEnd();
        }
    }
    void ValidateDeployment() {
        // Never replace the retained handle set during a request: its lifetime spans all worker use.
        if (!deploymentObjects.ContainsKey(Path.GetFullPath(config.Node))) PinDeployment();
        if (!Path.IsPathRooted(config.Storage) || !Directory.Exists(config.Storage)) throw new IOException("AUTHORITY_STORAGE_REQUIRED");
        foreach (string file in new [] {configPath, config.EngineConfig, config.Storage}) CheckAcl(file, true);
        foreach (string file in new [] {config.Node, config.Worker, Path.Combine(Path.GetDirectoryName(config.Worker), "protected-admission.cjs"), typeof(AuthorityService).Assembly.Location}) CheckAcl(file, false);
        string boundary=Directory.GetParent(config.Storage).FullName;
        if (config.CoreProcessStartUtcTicks <= 0) throw new IOException("AUTHORITY_CORE_PROCESS_BINDING_REQUIRED");
        IntPtr coreToken=OpenCoreTokenBound(config.CoreProcessId, config.CoreSid, config.CoreProcessStartUtcTicks);
        try {
            foreach (string file in new [] {configPath, config.EngineConfig, config.Storage, config.Node, config.Worker, typeof(AuthorityService).Assembly.Location}) {
                string full=Path.GetFullPath(file);
                if (!full.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_SUBTREE_REQUIRED");
                for (var parent = Directory.GetParent(file); parent != null; parent = parent.Parent) {
                    if (parent.FullName.Equals(boundary, StringComparison.OrdinalIgnoreCase) || parent.FullName.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) CheckAcl(parent.FullName, false);
                    else CheckOpenedAncestor(parent.FullName, coreToken);
                }
                var acl=OpenedAcl(file);
                foreach (uint right in new uint[] {2,4,0x10,0x40,0x100,0x10000,0x40000,0x80000})
                    if (EffectiveAccess(acl.GetSecurityDescriptorBinaryForm(), coreToken, right)) throw new IOException("AUTHORITY_CORE_MUTATION_ACCESS");
            }
        } finally { CloseHandle(coreToken); }
        foreach (string child in Directory.GetFileSystemEntries(config.Storage)) {
            if (!String.Equals(Path.GetFileName(child), "admission.jsonl", StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_STORAGE_RECONCILIATION_REQUIRED");
            CheckAcl(child, true);
        }
        CheckAcl(Path.Combine(config.Storage,"admission.jsonl"), true);
        ReadPinned(config.Node, config.NodeSha256); ReadPinned(config.Worker, config.WorkerSha256);
        string engineText=ReadPinned(config.EngineConfig, config.EngineConfigSha256);
        ReadPinned(Path.Combine(Path.GetDirectoryName(config.Worker), "protected-admission.cjs"), config.AdmissionSha256);
        var engine = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(engineText);
        if (!engine.ContainsKey("directory") || !String.Equals(Path.GetFullPath((string)engine["directory"]), Path.GetFullPath(config.Storage), StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_STORAGE_MISMATCH");
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    void PinDeployment() {
        var opened=new List<SafeFileHandle>();
        try {
            var paths=new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string file in new [] {configPath, config.EngineConfig, config.Storage, config.Node, config.Worker, Path.Combine(Path.GetDirectoryName(config.Worker), "protected-admission.cjs"), typeof(AuthorityService).Assembly.Location}) {
                string full=Path.GetFullPath(file); paths.Add(full);
                for (var parent=Directory.GetParent(full); parent != null; parent=parent.Parent) paths.Add(parent.FullName);
            }
            // Journal stays the same object across worker launches. Permit data writes by
            // the service worker, but not delete sharing or name replacement.
            string journal=Path.Combine(config.Storage, "admission.jsonl");
            paths.Add(Path.GetFullPath(journal));
            foreach (string path in paths) {
                if (deploymentObjects.ContainsKey(Path.GetFullPath(path))) continue;
                // No DELETE sharing: deny rename/replacement while these handles remain open.
                // Files also deny write sharing. Ancestor directories allow child creation, not replacement.
                bool directory=Directory.Exists(path);
                bool mutableJournal=String.Equals(path, journal, StringComparison.OrdinalIgnoreCase);
                var handle=CreateFile(path, directory ? 0x20080u : 0x80020000u, directory || mutableJournal ? 3u : 1u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); throw new IOException("AUTHORITY_PIN_OPEN_FAILED"); }
                opened.Add(handle);
                FileInformation info;
                if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || (!directory && info.Links != 1)) throw new IOException("AUTHORITY_PIN_OBJECT_INVALID");
                var final=new StringBuilder(32768);
                if (GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0) == 0 || !String.Equals(final.ToString(), "\\\\?\\" + path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) && !String.Equals(final.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase)) throw new IOException("AUTHORITY_PIN_PATH_MISMATCH");
                IntPtr owner, group, dacl, sacl, descriptor;
                if (GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new IOException("AUTHORITY_PIN_SECURITY_FAILED");
                try {
                    byte[] binary=new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, binary, 0, binary.Length);
                    var openedAcl=new RawSecurityDescriptor(binary, 0);
                    if (openedAcl.DiscretionaryAcl == null || openedAcl.Owner == null) throw new IOException("AUTHORITY_PIN_SECURITY_INVALID");
                } finally { LocalFree(descriptor); }
            }
            deploymentHandles.AddRange(opened);
            int index=0;
            foreach (string path in paths) if (!deploymentObjects.ContainsKey(Path.GetFullPath(path))) deploymentObjects.Add(Path.GetFullPath(path), opened[index++]);
        } catch { foreach (var handle in opened) handle.Dispose(); throw; }
    }
    public static void Main(string[] args) {
        if (args.Length != 1) throw new ArgumentException("EXPLICIT_PROTECTED_CONFIG_REQUIRED");
        ServiceBase.Run(new AuthorityService(args[0], false));
    }
}
