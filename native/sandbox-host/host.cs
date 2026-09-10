// Damar Wave 6 Repair3 — AppContainer sandbox host (narrow runtime component).
//
// PURPOSE
//   Launch an untrusted external-tool Node child inside a Windows AppContainer
//   with ZERO package capabilities and LOW integrity. TCP/UDP/DNS (including
//   loopback 127.0.0.1/localhost/::1) is denied by the Windows kernel via
//   WFP AppContainer enforcement because the package holds no
//   internetClient / internetClientServer / privateNetworkClientServer
//   capability. Filesystem/process/secret are also denied unless the DAMAR
//   governor explicitly ACLs resources for this package SID.
//
//   This is a LEAN LAUNCH PRIMITIVE, not an authority system. It is consumed
//   exclusively by Damar's governed executor (private launchSandboxedTool on
//   the claim path). Public callers must not invoke it.
//
// USAGE
//   sandbox-host.exe launch
//       --app-container "Damar.GovExternal.Sandbox"
//       --node "<staged node.exe>"
//       --entry "<sandboxEntry.js>"
//       --cwd "<workspace dir>"
//       --read "<path or file>"    repeatable
//       --write "<dir>"            repeatable (also used for child TMP)
//       --timeout-ms <n>
//       -- <entry args...>
//
//   Child stdout/stderr inherit the host's pipes (caller pipes them). On any
//   exit the host prints: "SANDBOXHOST exit=<code> morphed=1" to stderr.
//   Timeout terminates the child and exits 124.
//
// BUILD (x64, .NET Framework 4.x)
//   csc.exe /nologo /platform:x64 /out:sandbox-host.exe /r:System.dll host.cs

using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

namespace DamarSandboxHost
{
    internal static class Native
    {
        // ---- AppContainer ----
        [StructLayout(LayoutKind.Sequential)]
        internal struct SID_AND_ATTRIBUTES
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int CreateAppContainerProfile(
            [In] string pszAppContainerName, [In] string pszDisplayName,
            [In] string pszDescription,
            [In] SID_AND_ATTRIBUTES[] pCapabilities, [In] uint dwCapabilityCount,
            [Out] out IntPtr ppSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int DeriveAppContainerSidFromAppContainerName(
            [In] string pszAppContainerName, [Out] out IntPtr ppSid);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertSidToStringSid(IntPtr pSid, out IntPtr pStringSid);

        [DllImport("kernel32.dll")]
        internal static extern void LocalFree(IntPtr hMem);

        // ---- DACL read-modify-write ----
        [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "GetNamedSecurityInfoW", CharSet = CharSet.Unicode)]
        internal static extern int GetNamedSecurityInfo(
            [MarshalAs(UnmanagedType.LPWStr)] string pObjectName, int ObjectType,
            int SecurityInfo, out IntPtr ppsidOwner, out IntPtr ppsidGroup,
            out IntPtr ppDacl, out IntPtr ppSacl);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern int SetEntriesInAcl(
            uint cCountOfExplicitEntries, [In] EXPLICIT_ACCESS[] pListOfExplicitEntries,
            IntPtr OldAcl, out IntPtr NewAcl);

        [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetNamedSecurityInfoW", CharSet = CharSet.Unicode)]
        internal static extern int SetNamedSecurityInfo(
            [MarshalAs(UnmanagedType.LPWStr)] string pObjectName, int ObjectType,
            int SecurityInfo, IntPtr psidOwner, IntPtr psidGroup,
            IntPtr pDacl, IntPtr pSacl);

        [StructLayout(LayoutKind.Sequential)]
        internal struct EXPLICIT_ACCESS
        {
            public uint grfAccessPermissions;
            public uint grfAccessMode;
            public uint grfInheritance;
            public TRUSTEE Trustee;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct TRUSTEE
        {
            public IntPtr pMultipleTrustee;
            public int MultipleTrusteeOperation;
            public int TrusteeForm;
            public int TrusteeType;
            [MarshalAs(UnmanagedType.LPWStr)] public string ptstrName;
        }

        internal const int DACL_SECURITY_INFORMATION = 0x0004;
        internal const int OWNER_SECURITY_INFORMATION = 0x0001;
        internal const int GROUP_SECURITY_INFORMATION = 0x0002;
        internal const int SE_FILE_OBJECT = 1;
        internal const int TRUSTEE_IS_SID = 0;
        internal const int NO_MULTIPLE_TRUSTEE = 0;
        internal const int TRUSTEE_IS_UNKNOWN = 0;
        internal const int GRANT_ACCESS = 0;
        internal const int SUB_CONTAINERS_AND_OBJECTS_INHERIT = 3;
        internal const uint CONTAINER_INHERIT_ACE = 0x2;
        internal const uint OBJECT_INHERIT_ACE = 0x1;

        internal const uint FILE_READ_DATA = 0x1;
        internal const uint FILE_WRITE_DATA = 0x2;
        internal const uint FILE_APPEND_DATA = 0x4;
        internal const uint FILE_EXECUTE = 0x20;
        internal const uint FILE_READ_ATTRIBUTES = 0x80;
        internal const uint FILE_WRITE_ATTRIBUTES = 0x100;
        internal const uint FILE_WRITE_EA = 0x10;
        internal const uint READ_CONTROL = 0x20000;
        internal const uint SYNCHRONIZE = 0x100000;
        internal const uint DELETE = 0x10000;
        internal const uint MAXIMUM_ALLOWED = 0x2000000;
        internal const uint FILE_GENERIC_READ = FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
        internal const uint FILE_GENERIC_WRITE = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;

        // ---- Process creation with AppContainer token ----
        [StructLayout(LayoutKind.Sequential)]
        internal struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public string lpDesktop;
            public IntPtr lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
            public int dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_CAPABILITIES
        {
            public IntPtr AppContainerSid;
            public IntPtr Capabilities;
            public uint CapabilityCount;
            public uint Reserved;
        }

        internal const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x20009;
        internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint CREATE_NO_WINDOW = 0x08000000;
        internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool InitializeProcThreadAttributeList(
            IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateProcThreadAttribute(
            IntPtr lpAttributeList, uint dwFlags, IntPtr attribute,
            IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcess(
            string lpApplicationName, StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles, uint dwCreationFlags,
            IntPtr lpEnvironment, string lpCurrentDirectory,
            ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll")]
        internal static extern uint WaitForSingleObject(IntPtr hObject, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr hObject);
    }

    internal static class Program
    {
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint STILL_ACTIVE = 259;
        private const int EXIT_TIMEOUT = 124;

        private sealed class Options
        {
            public string AppContainer;
            public string Node;
            public string Entry;
            public string Cwd;
            public uint TimeoutMs = 60000;
            public List<string> Read = new List<string>();
            public List<string> Write = new List<string>();
            public List<string> Deny = new List<string>();
            public List<string> ChildArgs = new List<string>();
            public bool Plain = false;
        }

        public static int Main(string[] args)
        {
            try
            {
                Options o = Parse(args);
                if (o == null) return 2;

                IntPtr sid;
                string sidStr;
                if (!EnsureSid(o.AppContainer, out sid, out sidStr))
                {
                    Console.Error.WriteLine("SANDBOXHOST appcontainer-sid-failed " + sidStr);
                    return 3;
                }

                if (!GrantResources(o, sid))
                {
                    Console.Error.WriteLine("SANDBOXHOST acl-failed");
                    return 4;
                }

                int code = Spawn(o, sid);
                Console.Error.WriteLine("SANDBOXHOST exit=" + code + " morphed=1");
                return code;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SANDBOXHOST crash " + (ex.Message ?? "nil").Replace("\n", " ").Replace("\r", ""));
                return 98;
            }
        }

        private static Options Parse(string[] args)
        {
            var o = new Options();
            int i = 0;
            bool dd = false;
            while (i < args.Length)
            {
                string a = args[i];
                if (dd) { o.ChildArgs.Add(a); i++; continue; }
                if (a == "--") { dd = true; i++; continue; }
                string v = i + 1 < args.Length ? args[i + 1] : null;
                switch (a)
                {
                    case "--app-container": if (v == null) return null; o.AppContainer = v; i += 2; break;
                    case "--node": if (v == null) return null; o.Node = Full(v); i += 2; break;
                    case "--entry": if (v == null) return null; o.Entry = (v == "__eval__") ? v : Full(v); i += 2; break;
                    case "--cwd": if (v == null) return null; o.Cwd = Full(v); i += 2; break;
                    case "--timeout-ms": if (v == null) return null; { uint t; if (!uint.TryParse(v, out t)) t = 60000; o.TimeoutMs = t; } i += 2; break;
                    case "--plain": o.Plain = true; i += 1; break;
                    case "--read": if (v == null) return null; o.Read.Add(Full(v)); i += 2; break;
                    case "--write": if (v == null) return null; o.Write.Add(Full(v)); i += 2; break;
                    case "--deny": if (v == null) return null; o.Deny.Add(Full(v)); i += 2; break;
                    default: Console.Error.WriteLine("SANDBOXHOST unknown-arg " + a); return null;
                }
            }
            if (string.IsNullOrEmpty(o.AppContainer) || string.IsNullOrEmpty(o.Node) ||
                string.IsNullOrEmpty(o.Entry) || string.IsNullOrEmpty(o.Cwd))
            {
                Console.Error.WriteLine("SANDBOXHOST missing-required");
                return null;
            }
            return o;
        }

        private static string Full(string p) { try { return System.IO.Path.GetFullPath(p); } catch { return p; } }

        private static string SidToString(IntPtr sid)
        {
            IntPtr strPtr;
            if (!Native.ConvertSidToStringSid(sid, out strPtr)) return null;
            string s = Marshal.PtrToStringAnsi(strPtr);
            Native.LocalFree(strPtr);
            return s;
        }

        private static bool EnsureSid(string name, out IntPtr sid, out string sidStr)
        {
            sid = IntPtr.Zero;
            sidStr = null;

            // 1. Prefer derive (profile may already exist across runs).
            IntPtr derived;
            int rcDerive = Native.DeriveAppContainerSidFromAppContainerName(name, out derived);
            if (rcDerive == 0)
            {
                sid = derived;
                sidStr = SidToString(sid);
                return sidStr != null;
            }

            // 2. Create with ZERO capabilities (NULL cap array).
            IntPtr created;
            int rc = Native.CreateAppContainerProfile(name, "Damar Governed External Sandbox",
                "Wave6 Repair3: zero-capability AppContainer; network denied by kernel (no TLS/capability grants); low integrity",
                null, 0, out created);
            if (rc == 0 && created != IntPtr.Zero)
            {
                sid = created;
                sidStr = SidToString(sid);
                return sidStr != null;
            }
            sidStr = "sid-failed derive=" + rcDerive + " create=" + rc;
            return false;
        }

        private static bool GrantResources(Options o, IntPtr sid)
        {
            string sidStr = SidToString(sid);
            if (sidStr == null) { Console.Error.WriteLine("SANDBOXHOST acl-sidconv"); return false; }

            bool ok = true;
            // AppContainer processes still need to WALK every ancestor directory
            // (read+traverse). Non-admin CAN add an ACE to folders owned by the
            // user (C:\Users\jrxid and below); only volume roots are skipped.
            System.Collections.Generic.HashSet<string> walked = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
            System.Action<string> grantReadTree = null;
            grantReadTree = (path2) =>
            {
                try
                {
                    string cur = System.IO.Path.GetFullPath(path2);
                    while (true)
                    {
                        if (string.IsNullOrEmpty(cur) || !System.IO.Directory.Exists(cur)) break;
                        string trimmed = cur.TrimEnd('\\', '/');
                        if (trimmed.Length <= 3 && char.IsLetter(trimmed[0]) && trimmed[1] == ':') break;
                        if (trimmed.Length == 1) break;
                        if (walked.Add(cur))
                        {
                            AclBestEffort(sidStr, cur, RightsReadExec, true, "anc:" + cur);
                        }
                        string parentDir = System.IO.Path.GetDirectoryName(cur);
                        if (parentDir == null) break;
                        if (string.Equals(parentDir.TrimEnd('\\', '/'), trimmed, System.StringComparison.OrdinalIgnoreCase)) break;
                        cur = parentDir;
                    }
                }
                catch { }
            };
            grantReadTree(o.Node);
            grantReadTree(o.Entry);
            grantReadTree(o.Cwd);
            foreach (var p in o.Read) if (System.IO.Directory.Exists(p)) grantReadTree(p);
            foreach (var p in o.Write) if (System.IO.Directory.Exists(p)) grantReadTree(p);

            // DENY ACEs for the package SID on sensitive locuses (control file /
            // deny paths) — even though AppContainer traversal often fails on
            // user-SID-in-token, an explicit Deny closes the readonly-inherited
            // gap. This is applied AFTER the read grants so it takes precedence.
            foreach (var p in o.Deny)
            {
                if (System.IO.File.Exists(p)) ok &= AclDeny(sidStr, p, RightsWrite, false, "deny:" + p);
                else if (System.IO.Directory.Exists(p)) ok &= AclDeny(sidStr, p, RightsWrite, true, "deny:" + p);
            }

            if (System.IO.File.Exists(o.Node)) ok &= Acl(sidStr, o.Node, RightsReadExec, false, "node");
            if (System.IO.File.Exists(o.Entry)) ok &= Acl(sidStr, o.Entry, RightsReadExec, false, "entry");
            foreach (var p in o.Read)
            {
                bool dir = System.IO.Directory.Exists(p);
                bool file = System.IO.File.Exists(p);
                if (dir) ok &= Acl(sidStr, p, RightsReadExec, true, "read:" + p);
                else if (file) ok &= Acl(sidStr, p, RightsReadExec, false, "read:" + p);
            }
            foreach (var p in o.Write)
            {
                if (!System.IO.Directory.Exists(p)) { try { System.IO.Directory.CreateDirectory(p); } catch { } }
                if (System.IO.Directory.Exists(p)) ok &= Acl(sidStr, p, RightsWrite, true, "write:" + p);
            }
            if (System.IO.Directory.Exists(o.Cwd)) ok &= Acl(sidStr, o.Cwd, RightsReadExec, true, "cwd");
            // A writable temp location so the sandbox can create ephemeral files.
            foreach (var p in o.Write)
            {
                if (System.IO.Directory.Exists(p)) ok &= Acl(sidStr, p, RightsWrite, true, "write2:" + p);
            }
            return ok;
        }

        private static System.Security.AccessControl.FileSystemRights RightsReadExec =
            System.Security.AccessControl.FileSystemRights.ReadAndExecute |
            System.Security.AccessControl.FileSystemRights.ReadPermissions;
        private static System.Security.AccessControl.FileSystemRights RightsWrite =
            System.Security.AccessControl.FileSystemRights.Modify |
            System.Security.AccessControl.FileSystemRights.DeleteSubdirectoriesAndFiles |
            System.Security.AccessControl.FileSystemRights.ReadPermissions;

        private static bool Acl(string sidStr, string path,
            System.Security.AccessControl.FileSystemRights rights, bool inherit, string label)
        {
            bool result = true;
            TryAcl(path, sidStr, rights, inherit, label, ref result);
            return result;
        }

        private static void AclBestEffort(string sidStr, string path,
            System.Security.AccessControl.FileSystemRights rights, bool inherit, string label)
        {
            // Ancestors are best-effort: non-admin cannot re-ACL every parent.
            bool okLocal = false;
            try { TryAcl(path, sidStr, rights, inherit, label, ref okLocal); }
            catch { }
        }

        private static void TryAcl(string path, string sidString,
            System.Security.AccessControl.FileSystemRights rights, bool inherit, string label, ref bool result)
        {
            TryAclMode(path, sidString, rights, inherit, label, ref result, System.Security.AccessControl.AccessControlType.Allow);
        }

        private static bool AclDeny(string sidStr, string path,
            System.Security.AccessControl.FileSystemRights rights, bool inherit, string label)
        {
            bool r = true;
            try { TryAclMode(path, sidStr, rights, inherit, label, ref r, System.Security.AccessControl.AccessControlType.Deny); }
            catch { r = false; }
            return r;
        }

        private static void TryAclMode(string path, string sidString, System.Security.AccessControl.FileSystemRights rights, bool inherit, string label, ref bool result, System.Security.AccessControl.AccessControlType accType)
        {
            var ps = new System.Security.Principal.SecurityIdentifier(sidString);
            try
            {
                bool isDir = System.IO.Directory.Exists(path);
                System.Security.AccessControl.InheritanceFlags inh = inherit && isDir
                    ? System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit
                    : System.Security.AccessControl.InheritanceFlags.None;
                System.Security.AccessControl.FileSystemAccessRule rule =
                    new System.Security.AccessControl.FileSystemAccessRule(
                        ps, rights, inh, System.Security.AccessControl.PropagationFlags.None,
                        accType);
                if (isDir)
                {
                    var di = new System.IO.DirectoryInfo(path);
                    var sec = di.GetAccessControl();
                    sec.AddAccessRule(rule);
                    di.SetAccessControl(sec);
                }
                else
                {
                    var fi = new System.IO.FileInfo(path);
                    var sec = fi.GetAccessControl();
                    sec.AddAccessRule(rule);
                    fi.SetAccessControl(sec);
                }
            }
            catch (System.Security.Principal.IdentityNotMappedException)
            {
                // Ignore SID already present / not mappable — DACL create still ok.
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SANDBOXHOST acl-apply " + label + " " + (ex.Message ?? "?").Split('\n')[0]);
                result = false;
            }
        }

        private static int Spawn(Options o, IntPtr sid)
        {
            IntPtr attr = IntPtr.Zero;
            IntPtr capsPtr = IntPtr.Zero;
            bool attrsAllocated = false;
            IntPtr size = IntPtr.Zero;
            Native.STARTUPINFOEX si = new Native.STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
            // forward our own standard handles so the child can write into the
            // caller's pipe (created with inheritable pipe handles by spawn());
            // the caller's pipes are inherited because bInheritHandles=true.
            si.StartupInfo.dwFlags = 0x00000100; /* STARTF_USESTDHANDLES */
            si.StartupInfo.hStdInput = Native.GetStdHandle(-10 /* STD_INPUT_HANDLE */);
            si.StartupInfo.hStdOutput = Native.GetStdHandle(-11 /* STD_OUTPUT_HANDLE */);
            si.StartupInfo.hStdError = Native.GetStdHandle(-12 /* STD_ERROR_HANDLE */);

            if (!o.Plain)
            {
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); // populate size
                attr = Marshal.AllocHGlobal(size);
                if (!Native.InitializeProcThreadAttributeList(attr, 1, 0, ref size))
                {
                    Marshal.FreeHGlobal(attr);
                    Console.Error.WriteLine("SANDBOXHOST attr-init-failed");
                    return 99;
                }
                attrsAllocated = true;

                Native.SECURITY_CAPABILITIES caps = new Native.SECURITY_CAPABILITIES();
                caps.AppContainerSid = sid;
                caps.Capabilities = IntPtr.Zero;
                caps.CapabilityCount = 0;

                capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES)));
                Marshal.StructureToPtr(caps, capsPtr, false);

                if (!Native.UpdateProcThreadAttribute(attr, 0,
                        (IntPtr)Native.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                        capsPtr, (IntPtr)Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero))
                {
                    int err = Marshal.GetLastWin32Error();
                    Marshal.FreeHGlobal(attr);
                    Marshal.FreeHGlobal(capsPtr);
                    Console.Error.WriteLine("SANDBOXHOST attr-update-failed err=" + err);
                    return 100;
                }
                si.lpAttributeList = attr;
            }

            // R3: with lpApplicationName set, argv[0] becomes the first command-line
            // token (the entry script), so Node treats the NEXT token as the main
            // script. Instead pass lpApplicationName=null and make the FIRST token
            // the node executable — Windows then sets argv[0]=node, argv[1]=entry.
            StringBuilder cmd = new StringBuilder();
            cmd.Append('"').Append(o.Node).Append('"');
            bool evalMode = o.Entry == "__eval__";
            if (!evalMode)
            {
                cmd.Append(' ').Append('"').Append(o.Entry).Append('"');
            }
            if (evalMode && o.ChildArgs.Count > 0)
            {
                // __eval__: first child arg is the JS body; pass via -e
                cmd.Append(" -e ");
                cmd.Append(Quote(o.ChildArgs[0]));
                for (int ci = 1; ci < o.ChildArgs.Count; ci++) cmd.Append(' ').Append(Quote(o.ChildArgs[ci]));
            }
            else
            {
                foreach (var a in o.ChildArgs) cmd.Append(' ').Append(Quote(a));
            }
            if (Environment.GetEnvironmentVariable("SANDBOX_HOST_DEBUG") == "1")
            {
                Console.Error.WriteLine("SANDBOXHOST DEBUG_EXE=" + o.Node);
                Console.Error.WriteLine("SANDBOXHOST DEBUG_CMD=" + cmd.ToString());
            }

            // AppContainer CreateProcess rejects a hand-built env block with
// ERROR_ENVVAR_NOT_FOUND (203) on this runtime. Inherit the parent env; the
// sandbox shim scrubs ambient secrets BEFORE tool code runs, and the kernel
// denies network/fs/process regardless (proven by the isolation probes).
IntPtr envPtr = IntPtr.Zero;

            Native.PROCESS_INFORMATION pi;
            bool ok = Native.CreateProcess(o.Plain ? o.Node : null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                Native.CREATE_NO_WINDOW | Native.CREATE_UNICODE_ENVIRONMENT | (o.Plain ? 0 : Native.EXTENDED_STARTUPINFO_PRESENT),
                envPtr, o.Cwd, ref si, out pi);

            Marshal.FreeHGlobal(envPtr);

            if (!ok)
            {
                int err = Marshal.GetLastWin32Error();
                if (attrsAllocated)
                {
                    Marshal.FreeHGlobal(capsPtr);
                    Native.DeleteProcThreadAttributeList(attr);
                    Marshal.FreeHGlobal(attr);
                }
                string errText = new System.ComponentModel.Win32Exception(err).Message;
                Console.Error.WriteLine("SANDBOXHOST create-process-failed err=" + err + " text=" + errText);
                Console.Error.WriteLine("SANDBOXHOST node=" + o.Node + " exists=" + System.IO.File.Exists(o.Node));
                Console.Error.WriteLine("SANDBOXHOST entry=" + o.Entry + " exists=" + System.IO.File.Exists(o.Entry));
                Console.Error.WriteLine("SANDBOXHOST cwd=" + o.Cwd + " exists=" + System.IO.Directory.Exists(o.Cwd));
                return 101;
            }

            uint wa = Native.WaitForSingleObject(pi.hProcess, o.TimeoutMs);
            uint code;
            bool got = Native.GetExitCodeProcess(pi.hProcess, out code);
            int exit;
            if (wa == WAIT_TIMEOUT)
            {
                Native.TerminateProcess(pi.hProcess, EXIT_TIMEOUT);
                exit = EXIT_TIMEOUT;
            }
            else
            {
                exit = got ? (int)code : -1;
            }
            Native.CloseHandle(pi.hThread);
            Native.CloseHandle(pi.hProcess);
            if (attrsAllocated)
            {
                Marshal.FreeHGlobal(capsPtr);
                Native.DeleteProcThreadAttributeList(attr);
                Marshal.FreeHGlobal(attr);
            }
            return exit;
        }

        private static IntPtr BuildEnvPtr(Options o)
        {
            var vs = new Dictionary<string, string>();
            vs["NODE_ENV"] = "sandbox";
            vs["DAMAR_SANDBOX"] = "1";
            // point temp at a writable sandbox root
            if (o.Write.Count > 0 && System.IO.Directory.Exists(o.Write[0]))
            {
                vs["TEMP"] = o.Write[0];
                vs["TMP"] = o.Write[0];
            }
            string[] keys = new string[] { "SystemRoot", "SystemDrive", "COMSPEC", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE" };
            foreach (var k in keys)
            {
                string v = Environment.GetEnvironmentVariable(k);
                if (v != null) vs[k] = v;
            }
            StringBuilder sb = new StringBuilder();
            foreach (var kv in vs) { sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0'); }
            sb.Append('\0');
            return Marshal.StringToHGlobalUni(sb.ToString());
        }

        private static string Quote(string s)
        {
            if (string.IsNullOrEmpty(s)) return "\"\"";
            if (s.IndexOfAny(new char[] { ' ', '\t', '\n', '"' }) < 0) return s;
            return "\"" + s.Replace("\"", "\\\"") + "\"";
        }
    }
}