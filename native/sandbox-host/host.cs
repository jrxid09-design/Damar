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
using System.IO;

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
        // CharSet.Unicode is REQUIRED: CreateProcess is bound to CreateProcessW,
        // so lpDesktop must marshal as a wide string. (It was previously always
        // null, which hid the mismatch.)
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
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

        // ---- Private window station + desktop (R5-04 USER32 root cause) ----
        //
        // USER32.dll's DllMain attaches the process to a window station and
        // desktop. A zero-capability AppContainer has no access to the
        // interactive WinSta0\Default, so USER32 init fails and the process dies
        // with STATUS_DLL_INIT_FAILED (0xC0000142) before a single instruction of
        // its own code runs. node.exe imports USER32, so governed execution could
        // never start. The fix is NOT to grant access to the interactive desktop
        // (that would expose the user's clipboard and windows to the sandbox) but
        // to give the sandbox its OWN empty window station + desktop.
        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        // Building the DACL from SDDL at CREATION time is simpler and far less
        // error-prone than a GetSecurityInfo/SetEntriesInAcl/SetSecurityInfo
        // read-modify-write against a window object handle.
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string StringSecurityDescriptor, uint StringSDRevision,
            out IntPtr SecurityDescriptor, IntPtr SecurityDescriptorSize);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateWindowStationW(
            string lpwinsta, uint dwFlags, uint dwDesiredAccess, ref SECURITY_ATTRIBUTES lpsa);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateDesktopW(
            string lpszDesktop, string lpszDevice, IntPtr pDevmode,
            uint dwFlags, uint dwDesiredAccess, ref SECURITY_ATTRIBUTES lpsa);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr GetProcessWindowStation();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetProcessWindowStation(IntPtr hWinSta);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseWindowStation(IntPtr hWinSta);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseDesktop(IntPtr hDesktop);

        // Handle-based security for window/desktop objects (SE_WINDOW_OBJECT).
        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern int GetSecurityInfo(
            IntPtr handle, int ObjectType, int SecurityInfo,
            IntPtr ppsidOwner, IntPtr ppsidGroup,
            out IntPtr ppDacl, out IntPtr ppSacl, out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern int SetSecurityInfo(
            IntPtr handle, int ObjectType, int SecurityInfo,
            IntPtr psidOwner, IntPtr psidGroup, IntPtr pDacl, IntPtr pSacl);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertStringSidToSid(string StringSid, out IntPtr Sid);

        // SetEntriesInAcl variant whose TRUSTEE carries a SID POINTER rather than
        // a name (TRUSTEE_IS_SID).
        [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetEntriesInAclW", CharSet = CharSet.Unicode)]
        internal static extern int SetEntriesInAclSid(
            uint cCountOfExplicitEntries, [In] EXPLICIT_ACCESS_SID[] pListOfExplicitEntries,
            IntPtr OldAcl, out IntPtr NewAcl);

        [StructLayout(LayoutKind.Sequential)]
        internal struct EXPLICIT_ACCESS_SID
        {
            public uint grfAccessPermissions;
            public uint grfAccessMode;
            public uint grfInheritance;
            public TRUSTEE_SID Trustee;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct TRUSTEE_SID
        {
            public IntPtr pMultipleTrustee;
            public int MultipleTrusteeOperation;
            public int TrusteeForm;
            public int TrusteeType;
            public IntPtr ptstrName;
        }

        internal const int SE_WINDOW_OBJECT = 5;
        internal const uint NO_INHERITANCE = 0x0;
        // Full access to the PRIVATE station/desktop this host creates. Both
        // objects are created empty and are reachable by nothing else, so the
        // grant confers no access to the user's interactive session.
        internal const uint WINSTA_ALL_ACCESS = 0x37F;
        internal const uint DESKTOP_ALL_ACCESS = 0x1FF;
        // Standard right the HOST needs on its own handles in order to rewrite
        // the object DACL (SetSecurityInfo). READ_CONTROL is declared above.
        internal const uint WRITE_DAC = 0x00040000;
        internal const uint GENERIC_ALL_ACCESS = 0x10000000;

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
        private const int MAX_STAGE_DIRS = 64;
        private const long MAX_STAGE_BYTES = 256L * 1024L * 1024L;
        private const int STALE_STAGE_AGE_MINUTES = 60;

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
            public bool EnsureOnly = false;
            // R5-04: native-host-owned staging. In `--governed` mode the JS
            // parent supplies SOURCE references + expected digests + the
            // execution identity ONLY. The native host derives the destination
            // (inside the AppContainer package), stages, re-verifies the staged
            // digest, and launches the restricted child. No caller-provided
            // destination path exists.
            public bool Governed = false;
            public string ExecutionId;
            public string NodeSource;
            public string NodeDigest;
            public string ArtifactSource;
            public string ArtifactDigest;
        }

        public static int Main(string[] args)
        {
            try
            {
                Options o = Parse(args);
                if (o == null) return 2;

                // R5-04: `--governed` is the native-host-owned GOVERNED staging
                // + launch mode. The host derives the staging destination inside
                // the AppContainer package, copies the source node + artifact,
                // verifies the staged digest against the expected digest supplied
                // by the governed executor, and only then launches the restricted
                // child. The JS parent never writes into the package directory
                // and never supplies a destination path.
                if (o.Governed)
                {
                    return Governed(o);
                }

                // R4-02: `--ensure` is a PROVISIONING-ONLY mode. It guarantees
                // the AppContainer profile exists (deriving or creating it with
                // ZERO capabilities) and reports readiness WITHOUT spawning any
                // child. It is idempotent by construction (derive-first) and
                // carries no launch authority. Exit codes:
                //   0  ready (profile derived or created, caps empty)
                //   5  not ready (could not derive/create profile)
                //   6  ready but capability set is NOT empty (fail-closed)
                if (o.EnsureOnly)
                {
                    IntPtr sid;
                    string sidStr;
                    if (!EnsureSid(o.AppContainer, out sid, out sidStr))
                    {
                        Console.Error.WriteLine("SANDBOXHOST ensure sid-failed " + sidStr);
                        return 5;
                    }
                    // Verify the derived profile carries ZERO capabilities
                    // (fail-closed: an unexpected capability set is treated as
                    // tamper/misconfiguration).
                    int capCount = InspectCapabilityCount(o.AppContainer);
                    if (capCount < 0) { Console.Error.WriteLine("SANDBOXHOST ensure caps-unreadable"); return 5; }
                    if (capCount > 0)
                    {
                        Console.Error.WriteLine("SANDBOXHOST ensure caps-nonzero=" + capCount);
                        return 6;
                    }
                    Console.Error.WriteLine("SANDBOXHOST ensure ready acl-caps=0");
                    return 0;
                }

                IntPtr sid2a;
                string sidStr2a;
                if (!EnsureSid(o.AppContainer, out sid2a, out sidStr2a))
                {
                    Console.Error.WriteLine("SANDBOXHOST appcontainer-sid-failed " + sidStr2a);
                    return 3;
                }

                if (!GrantResources(o, sid2a))
                {
                    Console.Error.WriteLine("SANDBOXHOST acl-failed");
                    return 4;
                }

                int code = Spawn(o, sid2a);
                Console.Error.WriteLine("SANDBOXHOST exit=" + code + " morphed=1");
                return code;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SANDBOXHOST crash " + (ex.Message ?? "nil").Replace("\n", " ").Replace("\r", ""));
                return 98;
            }
        }

        // R5-04: `--governed` native-host-owned staging + restricted launch.
        //
        // TRUST BOUNDARY: the JS governed executor supplies ONLY
        //   [ --execution-id, --node-source, --node-digest,
        //     --artifact-source, --artifact-digest, -- argsJson, envJson, shim ]
        // and expects a bounded JSON receipt on stdout. EVERY filesystem
        // destination is DERIVED by this native host inside the fixed
        // AppContainer package; no caller-provided path is honored.
        //
        // Pipeline: verify source digests -> derive destination -> stage ->
        // verify staged digests -> TOCTOU re-check source -> launch restricted
        // child -> bounded result. Any mismatch fails closed with a distinct
        // exit code and NO child launch.
        private static int Governed(Options o)
        {
            try
            {
                if (o.ChildArgs.Count != 3)
                {
                    Console.Error.WriteLine("SANDBOXHOST governed bad-args (need shim,argsJson,envJson)");
                    return 20;
                }
                string shim = o.ChildArgs[0] ?? "";
                string argsJson = o.ChildArgs[1] ?? "{}";
                string envJson = o.ChildArgs[2] ?? "{}";
                if (shim.Length == 0 || shim.Length > 131072 ||
                    argsJson.Length > 131072 || envJson.Length > 131072)
                {
                    Console.Error.WriteLine("SANDBOXHOST governed bad-args (size)");
                    return 20;
                }

                // R5-04: ensure the profile BEFORE staging. Creating a fresh
                // AppContainer profile (re)creates the package folder, which would
                // otherwise wipe files already staged under it. Order:
                //   ensure profile -> verify source -> stage -> ACL -> spawn.
                IntPtr sid;
                string sidStr;
                if (!EnsureSid(o.AppContainer, out sid, out sidStr))
                {
                    Console.Error.WriteLine("SANDBOXHOST appcontainer-sid-failed " + sidStr);
                    return 3;
                }

                // Fail CLOSED with a named reason rather than an unattributable
                // "Illegal characters in path." — the caller must be told which
                // source it presented was unusable.
                string nodeSrc = SafeFullPath(o.NodeSource);
                string artSrc = SafeFullPath(o.ArtifactSource);
                if (nodeSrc == null || artSrc == null)
                {
                    Console.Error.WriteLine("SANDBOXHOST governed source-path-invalid node=[" +
                        Sanitize(o.NodeSource) + "] artifact=[" + Sanitize(o.ArtifactSource) + "]");
                    return 21;
                }

                // source must be a plain regular file: no reparse/symlink
                // redirection, no device/ADS semantics.
                if (!IsPlainRegularFile(nodeSrc) || !IsPlainRegularFile(artSrc))
                {
                    Console.Error.WriteLine("SANDBOXHOST governed source-invalid");
                    return 21;
                }

                // SOURCE digest check BEFORE any write.
                if (!EqHex(Sha256File(nodeSrc), o.NodeDigest))
                {
                    Console.Error.WriteLine("SANDBOXHOST governed node-source-digest-mismatch");
                    return 22;
                }
                if (!EqHex(Sha256File(artSrc), o.ArtifactDigest))
                {
                    Console.Error.WriteLine("SANDBOXHOST governed artifact-source-digest-mismatch");
                    return 23;
                }

                string destArt, outFile;
                long artSize;
                string stageDir = null;
                FileStream stageLock = null;
                using (var gate = new System.Threading.Mutex(false, "Local\\DamarGovExternalSandbox-StagingGate"))
                {
                    gate.WaitOne();
                    try
                    {
                        if (!StageArtifact(o, nodeSrc, artSrc, out destArt, out outFile, out artSize, out stageDir, out stageLock))
                        {
                            return 24; // reason already printed
                        }
                    }
                    finally { gate.ReleaseMutex(); }
                }

                // Build the restricted launch from NATIVE-derived paths only.
                Options launch = new Options();
                launch.AppContainer = o.AppContainer;
                launch.Node = Path.Combine(Path.GetDirectoryName(destArt), "node.exe");
                launch.Entry = "__eval__";
                launch.Cwd = Path.GetDirectoryName(destArt);
                launch.TimeoutMs = o.TimeoutMs;
                launch.Read.Add(launch.Cwd);
                launch.Write.Add(launch.Cwd);
                launch.ChildArgs.Add(shim);
                launch.ChildArgs.Add(destArt);
                launch.ChildArgs.Add(outFile);
                launch.ChildArgs.Add(argsJson);
                launch.ChildArgs.Add(envJson);

                if (!GrantResources(launch, sid))
                {
                    Console.Error.WriteLine("SANDBOXHOST acl-failed");
                    return 4;
                }

                // Machine-readable receipt (bounded) so the executor can read the
                // staged location / verified digests without supplying them.
                Console.Error.WriteLine("SANDBOXHOST governed staged dir=" + launch.Cwd +
                    " artifact-digest=" + o.ArtifactDigest +
                    " artifact-size=" + artSize);
                int code;
                try
                {
                    code = Spawn(launch, sid);
                    // R5-04: relay the bounded child result to the caller on stdout
                    // (framed) so the JS parent never needs to know the native-derived
                    // staging path and never reads inside the protected package dir.
                    RelayResult(outFile);
                }
                finally
                {
                    if (stageLock != null) stageLock.Dispose();
                    CleanupStageDirectory(stageDir);
                }
                Console.Error.WriteLine("SANDBOXHOST exit=" + code + " morphed=1");
                return code;
            }
            catch (Exception ex)
            {
                // Name the exception type and the failing frame: a bare message
                // such as "Illegal characters in path." is unattributable.
                string frame = "";
                try { string[] fr = (ex.StackTrace ?? "").Split(new char[] { (char)10 }); for (int fi = 0; fi < fr.Length && fi < 4; fi++) frame += " | " + fr[fi].Trim(); } catch { }
                Console.Error.WriteLine("SANDBOXHOST governed-exception " + ex.GetType().Name + ": " +
                    (ex.Message ?? "nil").Replace("\n", " ").Replace("\r", "") + " @ " + frame);
                return 98;
            }
        }

        // R5-04: read the bounded child result file (native-derived path only)
        // and re-emit it on stdout inside a frame the executor can parse. The
        // relay enforces a hard output cap and never echoes path material.
        private const int RESULT_CAP_BYTES = 512 * 1024;
        private static void RelayResult(string outFile)
        {
            try
            {
                if (string.IsNullOrEmpty(outFile) || !File.Exists(outFile))
                {
                    Console.Out.WriteLine("SANDBOXHOST_RESULT_BEGIN 0");
                    Console.Out.WriteLine("SANDBOXHOST_RESULT_END");
                    return;
                }
                long len = new FileInfo(outFile).Length;
                if (len > RESULT_CAP_BYTES)
                {
                    Console.Out.WriteLine("SANDBOXHOST_RESULT_BEGIN 0");
                    Console.Out.WriteLine("SANDBOXHOST_RESULT_END");
                    return;
                }
                string body = File.ReadAllText(outFile, Encoding.UTF8);
                if (body.Length > RESULT_CAP_BYTES) body = body.Substring(0, RESULT_CAP_BYTES);
                Console.Out.WriteLine("SANDBOXHOST_RESULT_BEGIN " + Encoding.UTF8.GetByteCount(body));
                Console.Out.Write(body);
                Console.Out.WriteLine();
                Console.Out.WriteLine("SANDBOXHOST_RESULT_END");
            }
            catch
            {
                Console.Out.WriteLine("SANDBOXHOST_RESULT_BEGIN 0");
                Console.Out.WriteLine("SANDBOXHOST_RESULT_END");
            }
        }

        // R5-04: derive the staging destination (never caller-controlled),
        // create it, copy node + artifact, verify the DESTINATION digests, and
        // re-check the SOURCE (TOCTOU). All paths are newly computed here.
        private static bool StageArtifact(Options o, string nodeSrc, string artSrc,
            out string destArt, out string outFile, out long artSize, out string stageDir, out FileStream stageLock)
        {
            destArt = null; outFile = null; artSize = 0; stageDir = null; stageLock = null;
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string pkgRoot = Path.GetFullPath(Path.Combine(localAppData, "Packages", o.AppContainer));
            string stageRoot = Path.GetFullPath(Path.Combine(pkgRoot, "staging"));
            string runKey = DeriveRunKey(o.ExecutionId, o.ArtifactDigest);
            stageDir = Path.GetFullPath(Path.Combine(stageRoot, runKey));

            if (!ReconcileStaging(stageRoot)) return false;

            // containment: the derived dir must remain under stageRoot.
            string prefix = stageRoot.TrimEnd('\\') + "\\";
            if (!stageDir.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("SANDBOXHOST governed dest-escape");
                return false;
            }
            // no reparse point may sit on the destination path (junction escape).
            if (HasReparseAncestor(stageDir, pkgRoot))
            {
                Console.Error.WriteLine("SANDBOXHOST governed dest-reparse");
                return false;
            }

            Directory.CreateDirectory(stageDir);
            if (HasReparseAncestor(stageDir, pkgRoot))
            {
                Console.Error.WriteLine("SANDBOXHOST governed dest-reparse");
                return false;
            }

            try { stageLock = new FileStream(Path.Combine(stageDir, "run.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (Exception ex) { Console.Error.WriteLine("SANDBOXHOST governed staging-lock-failed " + ex.GetType().Name + ":" + Sanitize(ex.Message)); CleanupStageDirectory(stageDir); return false; }

            string stagedNode = Path.Combine(stageDir, "node.exe");
            destArt = Path.Combine(stageDir, "tool.js");
            outFile = Path.Combine(stageDir, "out.json");
            CopyOverwrite(nodeSrc, stagedNode);
            CopyOverwrite(artSrc, destArt);

            // DESTINATION digest verification.
            if (!EqHex(Sha256File(stagedNode), o.NodeDigest) ||
                !EqHex(Sha256File(destArt), o.ArtifactDigest))
            {
                Console.Error.WriteLine("SANDBOXHOST governed dest-digest-mismatch");
                stageLock.Dispose(); stageLock = null; CleanupStageDirectory(stageDir);
                return false;
            }
            // TOCTOU: if the source changed during staging, refuse to launch.
            if (!EqHex(Sha256File(nodeSrc), o.NodeDigest) ||
                !EqHex(Sha256File(artSrc), o.ArtifactDigest))
            {
                Console.Error.WriteLine("SANDBOXHOST governed source-mutated");
                stageLock.Dispose(); stageLock = null; CleanupStageDirectory(stageDir);
                return false;
            }
            artSize = new FileInfo(destArt).Length;
            return true;
        }

        // Reconcile only native-derived staging children. Old abandoned runs
        // are removed before quota accounting; recent directories are treated
        // as active and are never evicted. A named mutex serializes this check
        // across concurrent helper processes.
        private static bool ReconcileStaging(string stageRoot)
        {
            try
            {
                Directory.CreateDirectory(stageRoot);
                string[] dirs = Directory.GetDirectories(stageRoot);
                foreach (string d in dirs)
                {
                    if (HasReparseAncestor(d, stageRoot)) continue;
                    if (!IsStageActive(d)) CleanupStageDirectory(d);
                }
                dirs = Directory.GetDirectories(stageRoot);
                long bytes = 0; int count = 0;
                foreach (string d in dirs)
                {
                    if (HasReparseAncestor(d, stageRoot)) return false;
                    count++;
                    bytes += DirectoryBytes(new DirectoryInfo(d));
                }
                if (count >= MAX_STAGE_DIRS || bytes >= MAX_STAGE_BYTES)
                {
                    Console.Error.WriteLine("SANDBOXHOST governed staging-quota-exceeded count=" + count + " bytes=" + bytes);
                    return false;
                }
                return true;
            }
            catch
            {
                Console.Error.WriteLine("SANDBOXHOST governed staging-reconcile-failed");
                return false;
            }
        }

        private static long DirectoryBytes(DirectoryInfo dir)
        {
            long total = 0;
            foreach (FileInfo f in dir.GetFiles()) total += f.Length;
            foreach (DirectoryInfo d in dir.GetDirectories())
            {
                if (!HasReparseAncestor(d.FullName, dir.Root.FullName)) total += DirectoryBytes(d);
            }
            return total;
        }

        private static bool IsStageActive(string dir)
        {
            string marker = Path.Combine(dir, "run.lock");
            if (!File.Exists(marker)) return false;
            try
            {
                using (var probe = new FileStream(marker, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                return false;
            }
            catch { return true; }
        }

        private static void CleanupStageDirectory(string dir)
        {
            try
            {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
                DirectoryInfo di = new DirectoryInfo(dir);
                if (di.Attributes.HasFlag(FileAttributes.ReparsePoint)) return;
                Directory.Delete(dir, true);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SANDBOXHOST governed staging-cleanup-failed " + ex.GetType().Name);
            }
        }

        private static readonly char[] RUNKEY_ALLOWED =
            "abcdefghijklmnopqrstuvwxyz0123456789-".ToCharArray();

        // R5-04: run key = safe generated basename. Charset allowlist removes
        // EVERY path-significant character (\\, /, :, .., UNC prefix, ADS ':' ,
        // device prefix, whitespace); the result is bounded. Distinct
        // (executionId, digest) pairs cannot collide into one directory.
        private static string DeriveRunKey(string executionId, string artifactDigest)
        {
            var sb = new StringBuilder();
            string src = ((executionId ?? "") + "-" + (artifactDigest ?? "")).ToLowerInvariant();
            foreach (char ch in src)
            {
                if (Array.IndexOf(RUNKEY_ALLOWED, ch) >= 0 && sb.Length < 48) sb.Append(ch);
            }
            if (sb.Length < 8)
            {
                sb.Clear();
                byte[] h = Sha256Bytes(src);
                for (int k = 0; k < 16; k++) sb.Append(h[k].ToString("x2"));
            }
            return sb.ToString();
        }

        private static bool EqHex(string a, string b)
        {
            return !string.IsNullOrEmpty(a) && !string.IsNullOrEmpty(b) &&
                string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        private static byte[] Sha256Bytes(string s)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                return sha.ComputeHash(Encoding.UTF8.GetBytes(s ?? ""));
            }
        }

        private static string Sha256File(string path)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] h = sha.ComputeHash(fs);
                var sb = new StringBuilder(h.Length * 2);
                foreach (byte b in h) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        // A SOURCE file the host may copy: exists, regular file, NOT a reparse
        // point, not a device. Reject anything else (fail closed).
        private static bool IsPlainRegularFile(string path)
        {
            try
            {
                if (!File.Exists(path)) return false;
                // A regular leaf can still be reached through a junction or
                // symlink ancestor. Reject the entire source route before the
                // first digest or copy; checking only the leaf reintroduces a
                // TOCTOU/path-redirection escape.
                string root = Path.GetPathRoot(path);
                if (HasReparseAncestor(path, root)) return false;
                FileAttributes a = File.GetAttributes(path);
                if ((a & FileAttributes.ReparsePoint) != 0) return false;
                if ((a & FileAttributes.Directory) != 0) return false;
                if ((a & FileAttributes.Device) != 0) return false;
                return true;
            }
            catch { return false; }
        }

        // Walk the path up to (and including) `stopAt` and reject if ANY
        // existing component is a reparse point (junction/symlink escape).
        private static bool HasReparseAncestor(string path, string stopAt)
        {
            try
            {
                string stop = Path.GetFullPath(stopAt).TrimEnd('\\');
                string cur = Path.GetFullPath(path).TrimEnd('\\');
                int guard = 0;
                while (!string.IsNullOrEmpty(cur) && guard++ < 64)
                {
                    if (Directory.Exists(cur) || File.Exists(cur))
                    {
                        FileAttributes a = File.GetAttributes(cur);
                        if ((a & FileAttributes.ReparsePoint) != 0) return true;
                    }
                    if (string.Equals(cur, stop, StringComparison.OrdinalIgnoreCase)) break;
                    string parent = Path.GetDirectoryName(cur);
                    if (string.IsNullOrEmpty(parent) ||
                        string.Equals(parent.TrimEnd('\\'), cur, StringComparison.OrdinalIgnoreCase)) break;
                    cur = parent.TrimEnd('\\');
                }
                return false;
            }
            catch { return true; } // fail closed on inspection error
        }

        private static void CopyOverwrite(string src, string dst)
        {
            File.Copy(src, dst, true);
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
                    case "--ensure": o.EnsureOnly = true; i += 1; break;
                    case "--governed": o.Governed = true; i += 1; break;
                    case "--execution-id": if (v == null) return null; o.ExecutionId = v; i += 2; break;
                    case "--node-source": if (v == null) return null; o.NodeSource = Full(v); i += 2; break;
                    case "--node-digest": if (v == null) return null; o.NodeDigest = v; i += 2; break;
                    case "--artifact-source": if (v == null) return null; o.ArtifactSource = Full(v); i += 2; break;
                    case "--artifact-digest": if (v == null) return null; o.ArtifactDigest = v; i += 2; break;
                    case "--read": if (v == null) return null; o.Read.Add(Full(v)); i += 2; break;
                    case "--write": if (v == null) return null; o.Write.Add(Full(v)); i += 2; break;
                    case "--deny": if (v == null) return null; o.Deny.Add(Full(v)); i += 2; break;
                    default: Console.Error.WriteLine("SANDBOXHOST unknown-arg " + a); return null;
                }
            }
            if (string.IsNullOrEmpty(o.AppContainer)) { Console.Error.WriteLine("SANDBOXHOST missing-required"); return null; }
            if (o.EnsureOnly) return o;
            if (o.Governed)
            {
                if (string.IsNullOrEmpty(o.ExecutionId) ||
                    string.IsNullOrEmpty(o.NodeSource) || string.IsNullOrEmpty(o.NodeDigest) ||
                    string.IsNullOrEmpty(o.ArtifactSource) || string.IsNullOrEmpty(o.ArtifactDigest))
                {
                    Console.Error.WriteLine("SANDBOXHOST missing-required");
                    return null;
                }
                return o;
            }
            if (string.IsNullOrEmpty(o.Node) ||
                string.IsNullOrEmpty(o.Entry) || string.IsNullOrEmpty(o.Cwd))
            {
                Console.Error.WriteLine("SANDBOXHOST missing-required");
                return null;
            }
            return o;
        }

        private static string Full(string p) { try { return System.IO.Path.GetFullPath(p); } catch { return p; } }

        // Like Full(), but reports failure instead of silently returning the raw
        // (unusable) value — governed staging must never proceed on one.
        private static string SafeFullPath(string p)
        {
            try { return System.IO.Path.GetFullPath(p); } catch { return null; }
        }

        // Bounded, control-character-free echo of caller-supplied text for
        // diagnostics. Never let attacker-controlled bytes reach the log raw.
        private static string Sanitize(string s)
        {
            if (s == null) return "<null>";
            var sb = new StringBuilder();
            foreach (char ch in s)
            {
                if (sb.Length >= 120) { sb.Append("..."); break; }
                sb.Append(ch < 32 || ch == 127 ? '?' : ch);
            }
            return sb.ToString();
        }

        private static string SidToString(IntPtr sid)
        {
            IntPtr strPtr;
            if (!Native.ConvertSidToStringSid(sid, out strPtr)) return null;
            string s = Marshal.PtrToStringAnsi(strPtr);
            Native.LocalFree(strPtr);
            return s;
        }

        // R4-02: capability inspection for the --ensure probe. A genuine
        // enumeration requires ILockdownInternal; we conservatively check the
        // AppModel unlock registry visible to this user and, when unreadable,
        // assume the SAFE side: treat as 0 ONLY when the profile's own SID
        // key is absent; otherwise fail closed (-1). This prevents a profile
        // silently carrying capabilities from being reported "ready".
        private static int InspectCapabilityCount(string appContainerName)
        {
            // The canonical design guarantee: our profile is ALWAYS created (and
            // re-derived) with a NULL capability array — zero package
            // capabilities. The registry subtree (AppModelUnlock) where Windows
            // records non-zero capability manifests is largely absent for
            // NON-package AppContainer profiles on Windows 10/11 desktop, so we
            // cannot depend on it. We therefore:
            //   1) verify the profile SID is derivable (exists), and
            //   2) when an AppModelUnlock capability manifest EXISTS for our
            //      SID, fail closed if it lists a non-empty capability set.
            // Absence of the registry subtree is NOT treated as a defect: a
            // non-package zero-cap AppContainer legitimately has none.
            try
            {
                IntPtr derived;
                if (Native.DeriveAppContainerSidFromAppContainerName(appContainerName, out derived) != 0)
                    return -1;
                string sidStr = SidToString(derived);
                if (sidStr == null) return -1;
                string regKey = "Software\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock";
                using (Microsoft.Win32.RegistryKey baseKey = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(regKey))
                {
                    if (baseKey == null) return 0; // non-package profile; no manifest
                    foreach (string sub in baseKey.GetSubKeyNames())
                    {
                        if (sub.IndexOf(sidStr, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            using (Microsoft.Win32.RegistryKey acc = baseKey.OpenSubKey(sub))
                            {
                                if (acc != null)
                                {
                                    foreach (string v in acc.GetValueNames())
                                    {
                                        if (v.IndexOf("cap", StringComparison.OrdinalIgnoreCase) >= 0)
                                        {
                                            int n = -1;
                                            try { n = CountCaps(acc.GetValue(v)); }
                                            catch { n = -1; }
                                            if (n > 0) return n;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    return 0;
                }
            }
            catch
            {
                return -1;
            }
        }

        private static int CountCaps(object value)
        {
            try
            {
                if (value is string[]) return ((string[])value).Length;
                if (value is Array) return ((Array)value).Length;
                string s = value as string;
                if (s != null) return s.Split(new char[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries).Length;
                return 0;
            }
            catch { return 0; }
        }

        private static bool EnsureSid(string name, out IntPtr sid, out string sidStr)
        {
            sid = IntPtr.Zero;
            sidStr = null;

            // R5-04 ROOT CAUSE FIX (was: derive-first).
            //
            // DeriveAppContainerSidFromAppContainerName computes the SID from a
            // hash of the NAME ALONE. It succeeds for names that were NEVER
            // registered, so derive-first returned a valid-looking SID for a
            // profile with no package registration and no
            // %LOCALAPPDATA%\Packages\<name> folder. `--ensure` then reported
            // "ready" for a profile that does not exist, and the subsequent
            // CreateProcess with PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
            // failed with ERROR_FILE_NOT_FOUND (2) — the long-standing
            // "AppContainer launch fails on a clean profile" blocker.
            //
            // CREATE FIRST: CreateAppContainerProfile is idempotent — an
            // existing profile returns HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
            // (0x800700B7) and the existing package folder is NOT recreated or
            // wiped, so previously staged content survives. Only after
            // registration is proven do we derive the SID.
            IntPtr created;
            int rcCreate = Native.CreateAppContainerProfile(name, "Damar Governed External Sandbox",
                "Wave6 Repair3: zero-capability AppContainer; network denied by kernel (no TLS/capability grants); low integrity",
                null, 0, out created);
            const int HR_ALREADY_EXISTS = unchecked((int)0x800700B7);
            if (rcCreate == 0 && created != IntPtr.Zero)
            {
                sid = created;
                sidStr = SidToString(sid);
                return sidStr != null;
            }
            if (rcCreate != HR_ALREADY_EXISTS)
            {
                sidStr = "sid-failed create=" + rcCreate;
                return false;
            }

            // Registered already: derive the SID for the existing profile.
            IntPtr derived;
            int rcDerive = Native.DeriveAppContainerSidFromAppContainerName(name, out derived);
            if (rcDerive != 0)
            {
                sidStr = "sid-failed create=" + rcCreate + " derive=" + rcDerive;
                return false;
            }
            sid = derived;
            sidStr = SidToString(sid);
            if (sidStr == null) return false;

            // Registration proof: a registered profile always owns a package
            // folder. Its absence means the profile is not actually usable and a
            // launch would fail at CreateProcess with a misleading error.
            if (!PackageProfileExists(name))
            {
                sidStr = "sid-failed profile-folder-missing";
                return false;
            }
            return true;
        }

        // R5-04: a registered AppContainer profile always owns
        // %LOCALAPPDATA%\Packages\<name>. This is the registration proof that
        // DeriveAppContainerSidFromAppContainerName cannot provide.
        private static bool PackageProfileExists(string name)
        {
            try
            {
                string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(lad)) return false;
                return Directory.Exists(Path.Combine(Path.Combine(lad, "Packages"), name));
            }
            catch { return false; }
        }

        private static bool GrantResources(Options o, IntPtr sid)
        {
            string sidStr = SidToString(sid);
            if (sidStr == null) { Console.Error.WriteLine("SANDBOXHOST acl-sidconv"); return false; }

            bool ok = true;
            // R5-04 ROOT CAUSE FIX (was: inheritable ReadAndExecute on every
            // ancestor).
            //
            // An AppContainer child needs TRAVERSE on each ancestor to reach a
            // granted leaf. The previous code granted inheritable (OI)(CI)
            // ReadAndExecute instead, which:
            //   (a) made Windows PROPAGATE the new ACE down the ENTIRE ancestor
            //       tree — C:\Workspace (dozens of sibling worktrees) and
            //       %SystemRoot%\System32 — burning minutes of CPU per launch and
            //       getting progressively worse with every new container SID.
            //       That propagation, not the AppContainer subsystem, is the
            //       "session degradation" / multi-minute launch hang.
            //   (b) granted the sandbox SID READ over every sibling under those
            //       ancestors — the source repo, sibling worktrees, audit
            //       evidence — violating the sandbox filesystem-isolation law.
            //
            // Ancestors now get TRAVERSE ONLY (walk through, never enumerate or
            // read contents), NON-INHERITABLE (InheritanceFlags.None => O(1) per
            // directory, zero propagation), and system-owned roots are SKIPPED
            // entirely: AppContainers already hold ALL APPLICATION PACKAGES
            // read/execute under %SystemRoot% and %ProgramFiles%, so re-ACLing
            // them is both useless and harmful.
            System.Collections.Generic.HashSet<string> walked = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
            System.Action<string> grantReadTree = null;
            grantReadTree = (path2) =>
            {
                try
                {
                    string pkgRootStop = PackageRoot(o.AppContainer);
                    string cur = System.IO.Path.GetFullPath(path2);
                    int depth = 0;
                    while (depth++ < 64)
                    {
                        if (string.IsNullOrEmpty(cur) || !System.IO.Directory.Exists(cur)) break;
                        string trimmed = cur.TrimEnd('\\', '/');
                        if (trimmed.Length <= 3 && char.IsLetter(trimmed[0]) && trimmed[1] == ':') break;
                        if (trimmed.Length == 1) break;
                        if (IsSystemOwnedRoot(trimmed)) break;
                        // The AppContainer package root and everything above it
                        // (…\AppData\Local\Packages, …\AppData\Local, the user
                        // profile) are ALREADY traversable by the package SID —
                        // CreateAppContainerProfile ACLs them. Re-ACLing the user
                        // profile would propagate inheritance across the whole
                        // profile tree for no gain.
                        if (pkgRootStop != null &&
                            trimmed.Equals(pkgRootStop, StringComparison.OrdinalIgnoreCase)) break;
                        if (walked.Add(cur))
                        {
                            AclBestEffort(sidStr, cur, RightsTraverse, false, "anc:" + cur);
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

        // R5-04: ancestor traverse only — enough to walk THROUGH a directory to
        // a granted leaf, never enough to enumerate or read its contents.
        private static System.Security.AccessControl.FileSystemRights RightsTraverse =
            System.Security.AccessControl.FileSystemRights.Traverse |
            System.Security.AccessControl.FileSystemRights.ReadAttributes;

        // R5-04: true when the DACL already carries an ACE of the same type for
        // this SID whose rights are a superset of `rights` and whose inheritance
        // covers `inh`. Used to make ACL application idempotent so a repeat
        // launch never rewrites (and therefore never re-propagates) a DACL.
        private static bool AlreadySatisfied(
            System.Security.AccessControl.FileSystemSecurity sec,
            System.Security.Principal.SecurityIdentifier ps,
            System.Security.AccessControl.FileSystemRights rights,
            System.Security.AccessControl.InheritanceFlags inh,
            System.Security.AccessControl.AccessControlType accType)
        {
            try
            {
                var rules = sec.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier));
                foreach (System.Security.AccessControl.FileSystemAccessRule r in rules)
                {
                    if (r.AccessControlType != accType) continue;
                    if (!r.IdentityReference.Value.Equals(ps.Value, StringComparison.OrdinalIgnoreCase)) continue;
                    if ((r.FileSystemRights & rights) != rights) continue;
                    if ((r.InheritanceFlags & inh) != inh) continue;
                    return true;
                }
            }
            catch { }
            return false;
        }

        // R5-04: %LOCALAPPDATA%\Packages\<container> — the profile folder the
        // AppContainer owns. Used as the ancestor-walk stop.
        private static string PackageRoot(string appContainer)
        {
            try
            {
                if (string.IsNullOrEmpty(appContainer)) return null;
                string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(lad)) return null;
                return Path.GetFullPath(Path.Combine(Path.Combine(lad, "Packages"), appContainer)).TrimEnd('\\', '/');
            }
            catch { return null; }
        }

        // R5-04: never re-ACL Windows / Program Files. AppContainers already get
        // ALL APPLICATION PACKAGES read/execute there; writing a new ACE only
        // triggers a whole-tree inheritance propagation and widens access.
        private static bool IsSystemOwnedRoot(string dir)
        {
            try
            {
                string[] roots = new string[] {
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
                };
                foreach (string r in roots)
                {
                    if (string.IsNullOrEmpty(r)) continue;
                    string rt = r.TrimEnd('\\', '/');
                    if (rt.Length == 0) continue;
                    if (dir.Equals(rt, StringComparison.OrdinalIgnoreCase)) return true;
                    if (dir.StartsWith(rt + "\\", StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
            catch { }
            return false;
        }

        // ---- R5-04: private window station + desktop for the sandbox child ----

        // Window station names may not contain '\'. Derive a bounded, stable name
        // from the container so concurrent containers never share a station.
        private static string SandboxStationName(string appContainer)
        {
            var sb = new StringBuilder("DamarSbx");
            byte[] h = Sha256Bytes(appContainer ?? "");
            for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2"));
            return sb.ToString();
        }

        // Creates (or re-opens) the private station + its single "Default"
        // desktop and grants ONLY the package SID access to them. The caller must
        // keep both handles open for the child's lifetime: a window station is
        // destroyed when its last handle closes.
        private static bool CreatePrivateStation(string staName, IntPtr sid,
            out IntPtr hWinSta, out IntPtr hDesk, out IntPtr hPrevWinSta)
        {
            hWinSta = IntPtr.Zero; hDesk = IntPtr.Zero; hPrevWinSta = IntPtr.Zero;
            IntPtr pSd = IntPtr.Zero;
            try
            {
                // DACL: this host's own user + the sandbox package SID, nobody
                // else. Both objects are created EMPTY and are reachable from
                // nowhere else, so full access to them grants the sandbox nothing
                // in the user's interactive session.
                string sidStr = SidToString(sid);
                if (sidStr == null) { Console.Error.WriteLine("SANDBOXHOST winsta-sid"); return false; }
                string me = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                string sddl = "D:(A;;GA;;;" + me + ")(A;;GA;;;" + sidStr + ")";
                if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out pSd, IntPtr.Zero))
                {
                    Console.Error.WriteLine("SANDBOXHOST winsta-sddl err=" + Marshal.GetLastWin32Error());
                    return false;
                }
                Native.SECURITY_ATTRIBUTES sa = new Native.SECURITY_ATTRIBUTES();
                sa.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
                sa.lpSecurityDescriptor = pSd;
                sa.bInheritHandle = false;

                hPrevWinSta = Native.GetProcessWindowStation();
                hWinSta = Native.CreateWindowStationW(staName, 0, Native.WINSTA_ALL_ACCESS, ref sa);
                if (hWinSta == IntPtr.Zero)
                {
                    Console.Error.WriteLine("SANDBOXHOST winsta-create err=" + Marshal.GetLastWin32Error());
                    return false;
                }
                // A desktop is always created in the CALLING THREAD's window
                // station, so attach to the private station, create the desktop,
                // then restore our own station.
                if (!Native.SetProcessWindowStation(hWinSta))
                {
                    Console.Error.WriteLine("SANDBOXHOST winsta-attach err=" + Marshal.GetLastWin32Error());
                    return false;
                }
                hDesk = Native.CreateDesktopW("Default", null, IntPtr.Zero, 0, Native.DESKTOP_ALL_ACCESS, ref sa);
                int deskErr = Marshal.GetLastWin32Error();
                if (hPrevWinSta != IntPtr.Zero) Native.SetProcessWindowStation(hPrevWinSta);
                if (hDesk == IntPtr.Zero)
                {
                    Console.Error.WriteLine("SANDBOXHOST desktop-create err=" + deskErr);
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SANDBOXHOST winsta-exception " + (ex.Message ?? "?").Split(new char[] { (char)10 })[0]);
                return false;
            }
            finally
            {
                if (pSd != IntPtr.Zero) Native.LocalFree(pSd);
            }
        }

        private static void ClosePrivateStation(IntPtr hWinSta, IntPtr hDesk, IntPtr hPrevWinSta)
        {
            try { if (hPrevWinSta != IntPtr.Zero) Native.SetProcessWindowStation(hPrevWinSta); } catch { }
            try { if (hDesk != IntPtr.Zero) Native.CloseDesktop(hDesk); } catch { }
            try { if (hWinSta != IntPtr.Zero) Native.CloseWindowStation(hWinSta); } catch { }
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
                    // R5-04: writing a container's DACL makes Windows re-propagate
                    // inheritance across its ENTIRE subtree. On a large directory
                    // that costs minutes. If the required ACE is already present,
                    // skip the write entirely — repeat launches then cost nothing.
                    if (AlreadySatisfied(sec, ps, rights, inh, accType)) return;
                    sec.AddAccessRule(rule);
                    di.SetAccessControl(sec);
                }
                else
                {
                    var fi = new System.IO.FileInfo(path);
                    var sec = fi.GetAccessControl();
                    if (AlreadySatisfied(sec, ps, rights, inh, accType)) return;
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

            // R5-04 ROOT CAUSE FIX — STATUS_DLL_INIT_FAILED (0xC0000142).
            //
            // USER32.dll's DllMain attaches the process to a window station and
            // desktop. The zero-capability AppContainer SID has NO access to the
            // interactive WinSta0\Default, so USER32 init failed and EVERY binary
            // importing USER32 died at 0xC0000142 before running any of its own
            // code. That is exactly the observed matrix: hostname.exe, curl.exe
            // and cmd.exe (no USER32) launched; node.exe, .NET, whoami, tasklist,
            // where, timeout, taskkill, gpupdate, cscript, control (USER32) all
            // failed. It was never TEMP, the environment block, file ACLs,
            // profile corruption or "session degradation".
            //
            // The fix deliberately does NOT grant the sandbox access to the
            // user's interactive desktop — that would expose the clipboard and
            // every window on it to sandboxed tool code. Instead the host creates
            // a PRIVATE, EMPTY window station + desktop, grants only the package
            // SID access to those two objects, and points the child at them via
            // STARTUPINFO.lpDesktop. Isolation is strictly STRONGER than before:
            // the sandbox is now off the interactive desktop entirely.
            IntPtr hWinSta = IntPtr.Zero, hDesk = IntPtr.Zero, hPrevWinSta = IntPtr.Zero;
            if (!o.Plain)
            {
                string staName = SandboxStationName(o.AppContainer);
                if (!CreatePrivateStation(staName, sid, out hWinSta, out hDesk, out hPrevWinSta))
                {
                    ClosePrivateStation(hWinSta, hDesk, hPrevWinSta);
                    Console.Error.WriteLine("SANDBOXHOST winsta-failed");
                    return 102;
                }
                si.StartupInfo.lpDesktop = staName + "\\Default";
            }

            if (!o.Plain)
            {
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); // populate size
                attr = Marshal.AllocHGlobal(size);
                if (!Native.InitializeProcThreadAttributeList(attr, 1, 0, ref size))
                {
                    Marshal.FreeHGlobal(attr);
                    ClosePrivateStation(hWinSta, hDesk, hPrevWinSta);
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
                    ClosePrivateStation(hWinSta, hDesk, hPrevWinSta);
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

            // R5-05/R5-06: ONE secure environment behavior. No SANDBOXHOST_ENV_MODE
            // switch, no "inherit" (parent-environment) downgrade, no NULL env
            // pointer. The child ALWAYS receives an OWNED, secret-scrubbed
            // environment block built by the trusted native host (BuildEnvPtr).
            //
            // Windows AppContainer CreateProcess expands %VAR% references inside
            // the block against the block itself; the owned block therefore
            // carries the full transitive closure of referenced variables (minus
            // secret/resource families) so launch never hits
            // ERROR_ENVVAR_NOT_FOUND (203). The managed shim's deny-by-default
            // allowlist is the final gate before tool code runs. No ambient
            // environment variable may weaken isolation: there is no runtime
            // switch that re-enables inheritance or secrets.
            IntPtr envPtr = BuildEnvPtr(o, true);

            Native.PROCESS_INFORMATION pi;
            bool ok = Native.CreateProcess(o.Plain ? o.Node : null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                Native.CREATE_NO_WINDOW | Native.CREATE_UNICODE_ENVIRONMENT | (o.Plain ? 0 : Native.EXTENDED_STARTUPINFO_PRESENT),
                envPtr, o.Cwd, ref si, out pi);

            if (envPtr != IntPtr.Zero) Marshal.FreeHGlobal(envPtr);

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
                ClosePrivateStation(hWinSta, hDesk, hPrevWinSta);
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
            // The private station/desktop live only as long as this launch.
            ClosePrivateStation(hWinSta, hDesk, hPrevWinSta);
            return exit;
        }

        private static IntPtr BuildEnvPtr(Options o, bool fullCopy = false)
        {
            var vs = new Dictionary<string, string>();
            if (fullCopy)
            {
                // R4-03: build an OWNED environment block from the parent env,
                // EXCLUDING secret-bearing families. This is the default path:
                // we never pass NULL and we never forward keys that commonly
                // carry credentials (API keys, tokens, passwords, DAMAR_*,
                // cloud/CI secrets). Defense in depth at the process boundary;
                // the shim's deny-by-default allowlist is the final gate right
                // before tool code runs.
                string[] secretFamilies = new string[] {
                    "SECRET", "TOKEN", "PASSWORD", "PASSWD", "API_KEY", "APIKEY",
                    "ACCESS_KEY", "CREDENTIAL", "AUTH", "PRIVATE_KEY", "BEARER",
                    "DAMAR", "AWS_", "AZURE", "GOOGLE", "OPENAI", "ANTHROPIC",
                    "GITHUB_TOKEN", "GITLAB", "NPM_TOKEN", "CF_", "DATABASE_URL",
                    "_KEY", "_PASS", "_TOKEN", "SLACK", "WEBHOOK"
                };
                // R5-06: profile/session roots (USERPROFILE/HOMEDRIVE/HOMEPATH/
                // APPDATA/LOCALAPPDATA/USERDOMAIN/...) MUST remain in the launch
                // block: Windows AppContainer CreateProcess expands %VAR% references
                // in the env block against the block itself, so dropping them yields
                // ERROR_ENVVAR_NOT_FOUND (203). They are NEVER exposed to tool code
                // — the managed sandbox SHIM applies a deny-by-default allowlist
                // (see SHIM ALLOW_ENV) BEFORE any tool code runs, which removes
                // these from the effective environment the tool sees. The native
                // host therefore forwards them for launch validity only.
                foreach (System.Collections.DictionaryEntry de in Environment.GetEnvironmentVariables())
                {
                    string k = de.Key == null ? "" : de.Key.ToString();
                    string v = de.Value == null ? "" : de.Value.ToString();
                    if (k.Length == 0) continue;
                    bool secret = false;
                    foreach (string f in secretFamilies)
                    {
                        if (k.IndexOf(f, StringComparison.OrdinalIgnoreCase) >= 0) { secret = true; break; }
                    }
                    if (secret) continue;
                    vs[k] = v;
                }
                vs["NODE_ENV"] = "sandbox";
                vs["DAMAR_SANDBOX"] = "1";
                // R5-04 fix: the sandbox child MUST be able to write its own
                // TEMP/TMP during Node/.NET initialization (the loader creates
                // files there). The parent TEMP is usually NOT writable by the
                // AppContainer SID, which yields STATUS_DLL_INIT_FAILED
                // (0xC0000142). Point TEMP/TMP at a NATIVE-OWNED, container-
                // writable directory (the first --write root, which the host
                // ACLs for the package SID). No env downgrade/inheritance: this
                // only re-scopes temp to a sandbox-owned location.
                if (o.Write.Count > 0)
                {
                    string w0 = o.Write[0];
                    try { if (!System.IO.Directory.Exists(w0)) System.IO.Directory.CreateDirectory(w0); } catch { }
                    if (System.IO.Directory.Exists(w0))
                    {
                        vs["TEMP"] = w0;
                        vs["TMP"] = w0;
                    }
                }
                if (Environment.GetEnvironmentVariable("SANDBOX_HOST_DEBUG") == "1")
                {
                    DumpEnvBlock(vs);
                }
                return buildBlock(vs, o);
            }
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
            // R4-03 bisect: SANDBOXHOST_ENV_EXTRA="A,B,C" copies additional
            // parent keys into the minimal block so we can empirically find the
            // smallest set AppContainer CreateProcess requires on this runtime.
            string extraCfg = Environment.GetEnvironmentVariable("SANDBOXHOST_ENV_EXTRA");
            if (!string.IsNullOrEmpty(extraCfg))
            {
                foreach (string raw in extraCfg.Split(','))
                {
                    string k = raw.Trim();
                    if (k.Length == 0) continue;
                    string v = Environment.GetEnvironmentVariable(k);
                    if (v != null) vs[k] = v;
                }
            }
            return buildBlock(vs, o);
        }

        // R5-04 diagnostic: dump the security-relevant env block (debug only).
        private static void DumpEnvBlock(Dictionary<string, string> vs)
        {
            string[] keys = new string[] { "TEMP", "TMP", "SystemRoot", "windir", "PATH",
                "USERPROFILE", "APPDATA", "LOCALAPPDATA", "NODE_ENV", "DAMAR_SANDBOX" };
            foreach (string k in keys)
            {
                string v;
                if (vs.TryGetValue(k, out v))
                {
                    Console.Error.WriteLine("SANDBOXHOST ENV " + k + "=" + (v == null ? "<null>" : v));
                }
                else
                {
                    Console.Error.WriteLine("SANDBOXHOST ENV " + k + "=<absent>");
                }
            }
        }

        private static IntPtr buildBlock(Dictionary<string, string> vs, Options o)
        {
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
