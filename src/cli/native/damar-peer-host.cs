// DAMAR UIX-W5 - WINDOWS NATIVE PEER IDENTITY - PHASE B/C/D
//
// damar-peer-host.exe - the native Windows transport owner.
//
// WHY THIS PROCESS EXISTS
//   Node/libuv owns the connected named-pipe instance, so the Node host can
//   never call ImpersonateNamedPipeClient against its own accepted peer: the
//   connected server-side handle is not exposed to JavaScript.  This helper
//   owns the public endpoint, verifies the peer's REAL Windows token, and only
//   then hands the peer to the Node host.
//
// WHAT IT IS ALLOWED TO DO
//   Transport and peer identity verification ONLY:
//     - create the named pipe with a RESTRICTIVE DACL AT CREATION TIME;
//     - obtain the connected peer's token SID through Win32 impersonation;
//     - compare that SID against the authorized principal the host passed in;
//     - relay opaque bytes to/from the host.
//   It never interprets the Damar protocol, never decides authorization, never
//   approves an action and never dispatches a capability.  The Node host
//   re-verifies the SID it is told, and every Damar authorization decision
//   still happens inside the canonical Manager.
//
// HOW THE PEER REACHES THE HOST
//   The host spawns this helper with TWO private, inherited pipes PER CONNECTION
//   SLOT: fd 3+i carries helper -> host, fd 3+slots+i carries host -> helper.
//   Those pipes belong only to the host/helper process pair: no other process
//   can read, write or forge them, and there is no internal listening endpoint
//   to squat.  The verified peer identity travels over that private channel, so
//   peer metadata cannot be forged by anyone outside the pair.
//
// WHY TWO PIPES PER SLOT (measured, not assumed)
//   Windows serialises synchronous I/O per pipe endpoint: a thread parked in a
//   blocking ReadFile on a handle blocks writes on that same handle.  Measured
//   here as an indefinite stall, and again as an ~800 ms/400 ms stall for the
//   slot writes.  With one parked reader per direction on its own handle, no
//   handle ever carries a parked read and a write at the same time.
//
// WHY THE CLIENT PIPE IS OVERLAPPED
//   The client-facing instance cannot be split that way - the client connects to
//   one instance and needs both directions.  This process creates that instance,
//   so it is opened FILE_FLAG_OVERLAPPED and driven with real OVERLAPPED reads
//   (parked, event-signalled) and OVERLAPPED writes.  A thread parked in a
//   blocking read would otherwise stall every write to the client.
//
// SLOT PROTOCOL (binary, per slot, each direction on its own pipe)
//   u8 kind | u32le length | payload
//   host -> helper : 1 = client data, 3 = drop this peer
//   helper -> host : 1 = client data, 2 = metadata JSON, 3 = peer closed
//   stdout         : newline-delimited JSON lifecycle events (ready/fatal/log)
//
// LIFETIME
//   The slot pipes ARE the lifetime link: when the host goes away every
//   upstream read fails and this process exits.  Nothing survives the host.
//
// FAIL CLOSED
//   A missing slot handle, an unusable DACL, a failed impersonation cleanup or
//   any internal inconsistency terminates the process.  There is no fallback
//   and no degraded mode.
//
// BUILD (reproducible, in-box compiler only)
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /platform:anycpu
//     /optimize+ /out:damar-peer-host.exe damar-peer-host.cs
//
// ASCII only on purpose: a non-ASCII source file is one encoding round-trip
// away from being unbuildable.

using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class PeerHost
{
    // ---- framing --------------------------------------------------------

    private const byte K_DATA = 1;
    private const byte K_META = 2;
    private const byte K_CLOSED = 3;
    private const byte U_DATA = 1;
    private const byte U_DROP = 3;

    /** Hard bound on any single relayed frame (client protocol bound + slack). */
    private const int MAX_SLOT_FRAME = 1 << 20;

    private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    private const uint PIPE_TYPE_BYTE = 0x00000000;
    private const uint PIPE_READMODE_BYTE = 0x00000000;
    private const uint PIPE_WAIT = 0x00000000;
    private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
    private const uint PIPE_UNLIMITED_INSTANCES = 255;
    private const int ERROR_PIPE_CONNECTED = 535;
    private const int ERROR_IO_PENDING = 997;
    private const int ERROR_BROKEN_PIPE = 109;
    private const int ERROR_NO_DATA = 232;
    private const int ERROR_OPERATION_ABORTED = 995;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint FILE_TYPE_PIPE = 0x0003;
    private const uint SDDL_REVISION_1 = 1;
    private const int SE_KERNEL_OBJECT = 6;
    private const uint SDDL_OWNER_GROUP_DACL = 0x00000007;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenUser = 1;
    private const int TokenImpersonationLevel = 9;
    private const int TokenSessionId = 12;
    private const int TokenIntegrityLevel = 25;
    private const int STD_OUTPUT_HANDLE = -11;
    private const uint PIPE_READ_BUF = 65536;
    private const uint WRITE_TIMEOUT_MS = 30000;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct OVERLAPPED
    {
        public IntPtr Internal;
        public IntPtr InternalHigh;
        public int Offset;
        public int OffsetHigh;
        public IntPtr hEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateNamedPipeW(string lpName, uint dwOpenMode, uint dwPipeMode,
        uint nMaxInstances, uint nOutBufferSize, uint nInBufferSize, uint nDefaultTimeOut,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes);

    [DllImport("kernel32.dll", EntryPoint = "ConnectNamedPipe", SetLastError = true)]
    private static extern bool ConnectNamedPipeOverlapped(IntPtr hNamedPipe, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DisconnectNamedPipe(IntPtr hNamedPipe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(IntPtr hNamedPipe, IntPtr lpBuffer, uint nBufferSize,
        IntPtr lpBytesRead, out uint lpTotalBytesAvail, IntPtr lpBytesLeftThisMessage);

    [DllImport("kernel32.dll", EntryPoint = "ReadFile", SetLastError = true)]
    private static extern bool ReadFileOverlapped(IntPtr hFile, IntPtr lpBuffer, uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", EntryPoint = "WriteFile", SetLastError = true)]
    private static extern bool WriteFileOverlapped(IntPtr hFile, IntPtr lpBuffer, uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetOverlappedResult(IntPtr hFile, IntPtr lpOverlapped,
        out uint lpNumberOfBytesTransferred, bool bWait);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEventW(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ResetEvent(IntPtr hEvent);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CancelIoEx(IntPtr hFile, IntPtr lpOverlapped);

    [DllImport("kernel32.dll")]
    private static extern uint GetFileType(IntPtr hFile);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentThread();

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr _get_osfhandle(int fd);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ImpersonateNamedPipeClient(IntPtr hNamedPipe);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenThreadToken(IntPtr ThreadHandle, uint DesiredAccess, bool OpenAsSelf,
        out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass,
        IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool RevertToSelf();

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl,
        uint revision, out IntPtr sd, IntPtr size);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr GetSecurityInfo(IntPtr handle, int objectType, uint securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd,
        uint revision, uint securityInfo, out IntPtr text, IntPtr len);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr h);

    private static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

    // ---- host configuration ---------------------------------------------

    private static string g_endpoint;
    private static string g_authorizedSid;
    private static Slot[] g_slots;
    private static IntPtr g_stdout;
    private static readonly object g_stdoutGate = new object();
    private static readonly object g_poolGate = new object();
    private static int g_connCounter = 0;
    private static int g_activeWorkers = 0;
    private static int g_SlotCount = 0;
    private static int g_preAuthMs = 5000;
    private static bool g_trace = false;
    private static int g_startTick = 0;
    private static volatile bool g_running = true;

    /** One private channel to the Node host, plus its current peer. */
    private sealed class Slot
    {
        public int Index;
        public IntPtr HostWriteHandle;        // helper -> host (client bytes downstream)
        public IntPtr HostReadHandle;         // host -> helper (client bytes upstream)
        public readonly object HostWriteGate = new object();
        public readonly object PeerGate = new object();
        public IntPtr Peer = INVALID_HANDLE;  // current connected client pipe instance
        public int ConnId = 0;
        public bool Busy = false;

        // Overlapped resources, one set per slot.  The first peer read, the
        // relay reads and the upstream writes all reuse them on this slot.
        public IntPtr ReadOverlap = IntPtr.Zero;
        public IntPtr ReadEvent = IntPtr.Zero;
        public IntPtr ReadBuffer = IntPtr.Zero;
        public IntPtr WriteOverlap = IntPtr.Zero;
        public IntPtr WriteEvent = IntPtr.Zero;
    }

    private static void Main(string[] args)
    {
        g_startTick = Environment.TickCount;
        try
        {
            // Acquire stdout BEFORE anything that can refuse: a caller must be
            // able to tell "the arguments were rejected" from "it crashed".
            g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            if (!ParseArgs(args))
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"bad_arguments\"}");
                Environment.Exit(2);
            }
            if (g_stdout == INVALID_HANDLE || g_stdout == IntPtr.Zero)
            {
                Environment.Exit(2);
            }
            if (!OpenSlots())
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"slot_unavailable\"}");
                Environment.Exit(2);
            }

            // DACL is applied BY CreateNamedPipeW, from this SDDL, at creation
            // time.  There is no bind-then-harden window to race.
            string sddl = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + g_authorizedSid + ")";
            IntPtr sd;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, out sd, IntPtr.Zero))
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"sddl_invalid\",\"win32\":" + Marshal.GetLastWin32Error() + "}");
                Environment.Exit(2);
            }

            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.lpSecurityDescriptor = sd;
            sa.bInheritHandle = 0;

            // Prove the DACL is live and readable BEFORE accepting anything, so
            // readiness is never published for an endpoint we cannot vouch for.
            IntPtr probe = CreatePipeInstance(ref sa);
            if (probe == INVALID_HANDLE)
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"create_failed\",\"win32\":" + Marshal.GetLastWin32Error() + "}");
                Environment.Exit(2);
            }
            string observed = ReadDacl(probe);
            CloseHandle(probe);
            if (observed == null)
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"acl_unreadable\"}");
                Environment.Exit(2);
            }

            // An instance must exist BEFORE readiness is published, or a client
            // that reacts to `ready` can race into a window with no listener.
            IntPtr first = CreatePipeInstance(ref sa);
            if (first == INVALID_HANDLE)
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"create_failed\",\"win32\":" + Marshal.GetLastWin32Error() + "}");
                Environment.Exit(2);
            }

            Emit("{\"t\":\"ready\",\"v\":1,\"endpoint\":\"" + Json(g_endpoint)
                + "\",\"pid\":" + GetCurrentProcessId()
                + ",\"slots\":" + g_slots.Length
                + ",\"dacl\":\"" + Json(observed) + "\""
                + ",\"expectedDacl\":\"" + Json(sddl) + "\""
                + ",\"authorizedSid\":\"" + Json(g_authorizedSid) + "\""
                + ",\"rejectRemoteClients\":true}");

            // One upstream reader per slot: the host -> peer direction.  These
            // threads also carry the host's lifetime onto this process.
            for (int i = 0; i < g_slots.Length; i++)
            {
                Slot slot = g_slots[i];
                Thread reader = new Thread(UpstreamLoop);
                reader.IsBackground = true;
                reader.Start(slot);
            }

            lock (g_poolGate) { g_activeWorkers++; }
            Thread firstWorker = new Thread(Worker);
            firstWorker.IsBackground = true;
            firstWorker.Start(first);

            AcceptLoop(sa);
            Environment.Exit(0);
        }
        catch (Exception error)
        {
            try { Emit("{\"t\":\"fatal\",\"reason\":\"exception\",\"message\":\"" + Json(error.Message) + "\"}"); }
            catch { /* nothing left to report */ }
            Environment.Exit(3);
        }
    }

    // ---- arguments -------------------------------------------------------

    private static bool ParseArgs(string[] args)
    {
        int slots = 0;
        for (int i = 0; i < args.Length; i++)
        {
            string key = args[i];
            string value = i + 1 < args.Length ? args[i + 1] : null;
            if (key == "--endpoint") { g_endpoint = value; i++; }
            else if (key == "--authorized-sid") { g_authorizedSid = value; i++; }
            else if (key == "--slots")
            {
                if (value == null || !int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out slots)) return false;
                i++;
            }
            else if (key == "--preauth-ms")
            {
                int preAuth;
                if (value == null || !int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out preAuth)) return false;
                if (preAuth < 250 || preAuth > 60000) return false;
                g_preAuthMs = preAuth;
                i++;
            }
            else if (key == "--trace") { g_trace = true; }
            else return false;
        }
        if (slots < 1 || slots > 256) return false;
        if (g_endpoint == null || !IsDamarEndpoint(g_endpoint)) return false;
        if (g_authorizedSid == null || !IsSid(g_authorizedSid)) return false;
        g_SlotCount = slots;
        g_slots = new Slot[slots];
        return true;
    }

    /** Exactly the Damar CLI endpoint shape - never a caller-chosen pipe name. */
    private static bool IsDamarEndpoint(string endpoint)
    {
        const string prefix = "\\\\.\\pipe\\damar-cli-";
        if (!endpoint.StartsWith(prefix, StringComparison.Ordinal)) return false;
        string tail = endpoint.Substring(prefix.Length);
        if (tail.Length != 32) return false;
        foreach (char c in tail)
        {
            bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) return false;
        }
        return true;
    }

    /**
     * An actual SID.  Anchored on the literal S-1- prefix on purpose: SDDL
     * well-known aliases (WD, AN, BU, AU, CO, ...) can never be smuggled in
     * here to widen the DACL.
     */
    private static bool IsSid(string sid)
    {
        if (sid.Length < 5 || sid.Length > 184) return false;
        if (!sid.StartsWith("S-1-", StringComparison.Ordinal)) return false;
        for (int i = 4; i < sid.Length; i++)
        {
            char c = sid[i];
            if (c != '-' && (c < '0' || c > '9')) return false;
        }
        return true;
    }

    // ---- slot handles ----------------------------------------------------

    /**
     * The host passes TWO private pipes per slot as inherited stdio handles:
     * fd 3+i carries helper -> host, fd 3+slots+i carries host -> helper.  A
     * .NET child reaches them through the CRT fd table (measured, not assumed:
     * see the Phase A evidence).
     */
    private static bool OpenSlots()
    {
        for (int i = 0; i < g_SlotCount; i++)
        {
            IntPtr down, up;
            try
            {
                down = _get_osfhandle(3 + i);
                up = _get_osfhandle(3 + g_SlotCount + i);
            }
            catch { return false; }
            if (down == INVALID_HANDLE || down == IntPtr.Zero) return false;
            if (up == INVALID_HANDLE || up == IntPtr.Zero) return false;
            if (GetFileType(down) != FILE_TYPE_PIPE) return false;
            if (GetFileType(up) != FILE_TYPE_PIPE) return false;

            Slot slot = new Slot();
            slot.Index = i;
            slot.HostWriteHandle = down;
            slot.HostReadHandle = up;
            slot.ReadEvent = CreateEventW(IntPtr.Zero, true, false, null);
            slot.WriteEvent = CreateEventW(IntPtr.Zero, true, false, null);
            if (slot.ReadEvent == IntPtr.Zero || slot.WriteEvent == IntPtr.Zero) return false;
            slot.ReadOverlap = MakeOverlapped(slot.ReadEvent);
            slot.WriteOverlap = MakeOverlapped(slot.WriteEvent);
            slot.ReadBuffer = Marshal.AllocHGlobal((int)PIPE_READ_BUF);
            if (slot.ReadOverlap == IntPtr.Zero || slot.WriteOverlap == IntPtr.Zero || slot.ReadBuffer == IntPtr.Zero) return false;
            g_slots[i] = slot;
        }
        return true;
    }

    private static IntPtr MakeOverlapped(IntPtr hEvent)
    {
        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(OVERLAPPED)));
        if (ptr == IntPtr.Zero) return IntPtr.Zero;
        OVERLAPPED ov = new OVERLAPPED();
        ov.hEvent = hEvent;
        Marshal.StructureToPtr(ov, ptr, false);
        return ptr;
    }

    private static IntPtr CreatePipeInstance(ref SECURITY_ATTRIBUTES sa)
    {
        return CreateNamedPipeW(g_endpoint,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES, PIPE_READ_BUF, PIPE_READ_BUF, 0, ref sa);
    }

    // ---- lifecycle reporting (stdout NDJSON) -----------------------------

    private static void Emit(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json + "\n");
        lock (g_stdoutGate)
        {
            uint written;
            WriteFile(g_stdout, body, (uint)body.Length, out written, IntPtr.Zero);
        }
    }

    /** Opt-in latency trace (--trace).  Never carries frame contents. */
    private static void Trace(string reason)
    {
        if (!g_trace) return;
        Emit("{\"t\":\"log\",\"trace\":true,\"reason\":\"" + Json(reason) + "\",\"ms\":" + (Environment.TickCount - g_startTick) + "}");
    }

    private static string ReadDacl(IntPtr handle)
    {
        IntPtr owner, group, dacl, sacl, sd;
        if (GetSecurityInfo(handle, SE_KERNEL_OBJECT, SDDL_OWNER_GROUP_DACL,
                out owner, out group, out dacl, out sacl, out sd) != IntPtr.Zero) return null;
        IntPtr text;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1,
                SDDL_OWNER_GROUP_DACL, out text, IntPtr.Zero)) return null;
        string value = Marshal.PtrToStringUni(text);
        LocalFree(text);
        return value;
    }

    // ---- accept loop -----------------------------------------------------

    private static void AcceptLoop(SECURITY_ATTRIBUTES sa)
    {
        int maxWorkers = g_SlotCount + 4;
        while (g_running)
        {
            bool haveRoom;
            lock (g_poolGate)
            {
                haveRoom = g_activeWorkers < maxWorkers;
                if (haveRoom) g_activeWorkers++;
            }
            if (!haveRoom)
            {
                Thread.Sleep(5);
                continue;
            }

            IntPtr pipe = CreatePipeInstance(ref sa);
            if (pipe == INVALID_HANDLE)
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"create_failed\",\"win32\":" + Marshal.GetLastWin32Error() + "}");
                FailClosed();
                return;
            }
            Thread worker = new Thread(Worker);
            worker.IsBackground = true;
            worker.Start(pipe);
        }
    }

    private static void Worker(object state)
    {
        IntPtr pipe = (IntPtr)state;
        Slot slot = null;
        try
        {
            Trace("worker_begin");
            if (!WaitForClient(pipe)) return;
            Trace("worker_connected");

            // ---- BOUNDED pre-authentication phase --------------------------
            // Impersonation needs client bytes; a client that connects and then
            // says nothing must not hold a worker or a slot forever.
            uint available = 0;
            long deadline = DateTime.UtcNow.Ticks + TimeSpan.TicksPerMillisecond * g_preAuthMs;
            while (g_running)
            {
                if (PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero) && available > 0) break;
                if (DateTime.UtcNow.Ticks >= deadline) break;
                Thread.Sleep(5);
            }
            if (!g_running) return;
            Trace("worker_preauth_done:" + available);
            if (available == 0)
            {
                // Nothing was forwarded and nothing is reported: drop it.
                Emit("{\"t\":\"log\",\"reason\":\"preauth_timeout\"}");
                return;
            }

            slot = AcquireSlot();
            if (slot == null)
            {
                Emit("{\"t\":\"log\",\"reason\":\"slot_pool_exhausted\"}");
                return;
            }

            int firstRead;
            int want = (int)Math.Min((long)available, (long)PIPE_READ_BUF);
            if (!OverlappedRead(slot, pipe, want, out firstRead) || firstRead == 0) return;
            byte[] first = new byte[firstRead];
            Marshal.Copy(slot.ReadBuffer, first, 0, firstRead);

            // ---- the peer gate --------------------------------------------
            PeerIdentity identity;
            string failure;
            if (!VerifyPeer(pipe, out identity, out failure))
            {
                if (failure == null) return; // VerifyPeer already failed the process closed
                Emit("{\"t\":\"log\",\"reason\":\"peer_rejected\",\"detail\":\"" + Json(failure) + "\"}");
                WriteMeta(slot, "{\"t\":\"deny\",\"reason\":\"" + Json(failure) + "\"}");
                return;
            }
            Trace("worker_verified");
            if (!string.Equals(identity.Sid, g_authorizedSid, StringComparison.OrdinalIgnoreCase))
            {
                Emit("{\"t\":\"log\",\"reason\":\"peer_sid_not_authorized\"}");
                WriteMeta(slot, "{\"t\":\"deny\",\"reason\":\"SID_MISMATCH\"}");
                return;
            }

            lock (slot.PeerGate) { slot.Peer = pipe; }
            Trace("meta_write_begin");
            WriteMeta(slot, "{\"t\":\"peer\",\"v\":1"
                + ",\"sid\":\"" + Json(identity.Sid) + "\""
                + ",\"pid\":" + identity.Pid
                + ",\"level\":" + identity.Level
                + ",\"session\":" + identity.SessionId
                + ",\"integrity\":\"" + Json(identity.IntegritySid) + "\""
                + ",\"conn\":" + slot.ConnId
                + ",\"nonce\":\"" + NewNonce() + "\"}");
            Trace("meta_write_end");

            // The peer's first chunk is the request head: it reaches the host
            // only AFTER the SID checks above, never before.
            Trace("head_write_begin");
            if (!WriteSlotFrame(slot, K_DATA, first, firstRead)) return;
            Trace("head_write_end");
            Emit("{\"t\":\"log\",\"reason\":\"peer_verified\",\"conn\":" + slot.ConnId + "}");

            RelayPeerToHost(slot, pipe);
        }
        catch (Exception error)
        {
            try { Emit("{\"t\":\"log\",\"reason\":\"worker_exception\",\"message\":\"" + Json(error.Message) + "\"}"); }
            catch { /* nothing left to report */ }
        }
        finally
        {
            if (slot != null) ReleaseSlot(slot, pipe);
            else { DisconnectNamedPipe(pipe); CloseHandle(pipe); }
            lock (g_poolGate) { g_activeWorkers--; }
        }
    }

    /** Overlapped ConnectNamedPipe, over an idle listening instance. */
    private static bool WaitForClient(IntPtr pipe)
    {
        IntPtr connectEvent = CreateEventW(IntPtr.Zero, true, false, null);
        if (connectEvent == IntPtr.Zero) return false;
        IntPtr connectOverlap = MakeOverlapped(connectEvent);
        if (connectOverlap == IntPtr.Zero) { CloseHandle(connectEvent); return false; }
        try
        {
            if (ConnectNamedPipeOverlapped(pipe, connectOverlap)) return true;
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_PIPE_CONNECTED) return true;
            if (error != ERROR_IO_PENDING) return false;
            // A pending instance IS the steady state of a listening server: wait
            // until a client arrives.  Teardown is process exit, driven by the
            // host-side lifetime link.
            if (WaitForSingleObject(connectEvent, INFINITE) != 0) return false;
            uint moved;
            return GetOverlappedResult(pipe, connectOverlap, out moved, false);
        }
        finally
        {
            Marshal.FreeHGlobal(connectOverlap);
            CloseHandle(connectEvent);
        }
    }

    /**
     * Read the connected peer's REAL token through Win32 impersonation.
     *
     * Returns false with `failure == null` when the process has already been
     * failed closed (a poisoned impersonation); the caller must not continue.
     */
    private static bool VerifyPeer(IntPtr pipe, out PeerIdentity identity, out string failure)
    {
        identity = new PeerIdentity();
        failure = null;
        if (!ImpersonateNamedPipeClient(pipe))
        {
            failure = "IMPERSONATE_FAILED_" + Marshal.GetLastWin32Error();
            return false;
        }
        bool reverted;
        try
        {
            IntPtr token;
            if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, out token))
            {
                failure = "OPEN_THREAD_TOKEN_FAILED_" + Marshal.GetLastWin32Error();
                return false;
            }
            try
            {
                identity.Sid = TokenSid(token, TokenUser);
                if (identity.Sid == null)
                {
                    // No identity could be read: a refusal, never a pass.
                    failure = "TOKEN_USER_UNAVAILABLE";
                    return false;
                }
                identity.Level = TokenInt(token, TokenImpersonationLevel, -1);
                identity.SessionId = TokenInt(token, TokenSessionId, -1);
                identity.IntegritySid = TokenSid(token, TokenIntegrityLevel);
                uint pid;
                identity.Pid = GetNamedPipeClientProcessId(pipe, out pid) ? (int)pid : -1;
            }
            finally { CloseHandle(token); }
        }
        finally
        {
            reverted = RevertToSelf();
        }
        if (!reverted)
        {
            // A thread that still carries a client token must never serve
            // again, and the failure must not be swallowed.
            Emit("{\"t\":\"fatal\",\"reason\":\"revert_to_self_failed\",\"win32\":" + Marshal.GetLastWin32Error() + "}");
            FailClosed();
            failure = null;
            return false;
        }
        return true;
    }

    private sealed class PeerIdentity
    {
        public string Sid;
        public int Level = -1;
        public int SessionId = -1;
        public string IntegritySid;
        public int Pid = -1;
    }

    private static string TokenSid(IntPtr token, int informationClass)
    {
        uint need;
        GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out need);
        if (need == 0) return null;
        IntPtr buffer = Marshal.AllocHGlobal((int)need);
        try
        {
            if (!GetTokenInformation(token, informationClass, buffer, need, out need)) return null;
            IntPtr text;
            if (!ConvertSidToStringSidW(Marshal.ReadIntPtr(buffer), out text)) return null;
            string value = Marshal.PtrToStringUni(text);
            LocalFree(text);
            return value;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static int TokenInt(IntPtr token, int informationClass, int fallback)
    {
        // Both classes used here are single DWORDs, and a zero-length size
        // query does not reliably report a required length for them, so the
        // buffer is fixed-size (the same shape the Phase A probe proved).
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try
        {
            uint need;
            if (!GetTokenInformation(token, informationClass, buffer, 4, out need)) return fallback;
            return Marshal.ReadInt32(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // ---- slot pool -------------------------------------------------------

    private static Slot AcquireSlot()
    {
        lock (g_poolGate)
        {
            for (int i = 0; i < g_SlotCount; i++)
            {
                if (!g_slots[i].Busy)
                {
                    g_slots[i].Busy = true;
                    g_slots[i].ConnId = ++g_connCounter;
                    return g_slots[i];
                }
            }
        }
        return null;
    }

    private static void ReleaseSlot(Slot slot, IntPtr pipe)
    {
        try { CancelIoEx(pipe, IntPtr.Zero); } catch { /* best effort */ }
        lock (slot.PeerGate)
        {
            if (slot.Peer == pipe) slot.Peer = INVALID_HANDLE;
        }
        lock (g_poolGate) { slot.Busy = false; }
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }

    // ---- relay -----------------------------------------------------------

    /** peer -> host, until the peer ends or the host drops it. */
    private static void RelayPeerToHost(Slot slot, IntPtr pipe)
    {
        while (g_running)
        {
            int got;
            if (!OverlappedRead(slot, pipe, (int)PIPE_READ_BUF, out got)) break;
            if (got == 0) break;
            byte[] chunk = new byte[got];
            Marshal.Copy(slot.ReadBuffer, chunk, 0, got);
            if (!WriteSlotFrame(slot, K_DATA, chunk, got)) break;
        }
        WriteSlotFrame(slot, K_CLOSED, null, 0);
        // The disconnect itself is visible to the client as a closed pipe.
    }

    /**
     * One overlapped read on the client pipe.  OVERLAPPED, not a blocking read:
     * a parked blocking read would stall every write to this same client.
     */
    private static bool OverlappedRead(Slot slot, IntPtr pipe, int max, out int got)
    {
        got = 0;
        ResetEvent(slot.ReadEvent);
        uint read;
        if (!ReadFileOverlapped(pipe, slot.ReadBuffer, (uint)max, out read, slot.ReadOverlap))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ERROR_IO_PENDING) return false;
            if (WaitForSingleObject(slot.ReadEvent, INFINITE) != 0) return false;
            if (!GetOverlappedResult(pipe, slot.ReadOverlap, out read, false)) return false;
        }
        got = (int)read;
        return true;
    }

    /** host -> peer, one reader per slot, for the whole process lifetime. */
    private static void UpstreamLoop(object state)
    {
        Slot slot = (Slot)state;
        byte[] header = new byte[5];
        Trace("upstream_loop_ready:" + slot.Index);
        while (g_running)
        {
            if (!ReadExact(slot.HostReadHandle, header, 5))
            {
                // The host is gone: its lifetime is ours.
                FailClosed();
                return;
            }
            int length = header[1] | (header[2] << 8) | (header[3] << 16) | (header[4] << 24);
            Trace("upstream_frame:" + slot.Index + ":" + header[0] + ":" + length);
            if (length < 0 || length > MAX_SLOT_FRAME)
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"upstream_frame_too_large\",\"length\":" + length + "}");
                FailClosed();
                return;
            }
            byte[] payload = new byte[length];
            if (length > 0 && !ReadExact(slot.HostReadHandle, payload, length))
            {
                FailClosed();
                return;
            }

            byte kind = header[0];
            IntPtr peer;
            lock (slot.PeerGate) { peer = slot.Peer; }
            if (peer == INVALID_HANDLE)
            {
                // A frame for a slot with no peer is a protocol violation.
                Emit("{\"t\":\"fatal\",\"reason\":\"upstream_frame_without_peer\",\"slot\":" + slot.Index + "}");
                FailClosed();
                return;
            }
            if (kind == U_DATA)
            {
                if (length > 0 && !OverlappedWrite(slot, peer, payload)) { /* relay will observe the end */ }
            }
            else if (kind == U_DROP)
            {
                // Cancel the relay's parked read; it then closes out the slot.
                CancelIoEx(peer, IntPtr.Zero);
            }
            else
            {
                Emit("{\"t\":\"fatal\",\"reason\":\"unknown_upstream_kind\",\"kind\":" + kind + "}");
                FailClosed();
                return;
            }
        }
    }

    private static bool ReadExact(IntPtr handle, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            uint read;
            byte[] chunk = offset == 0 ? buffer : Slice(buffer, offset, count - offset);
            if (!ReadFile(handle, chunk, (uint)chunk.Length, out read, IntPtr.Zero)) return false;
            if (read == 0) return false;
            offset += (int)read;
        }
        return true;
    }

    private static byte[] Slice(byte[] source, int offset, int count)
    {
        if (offset == 0 && count == source.Length) return source;
        byte[] target = new byte[count];
        Buffer.BlockCopy(source, offset, target, 0, count);
        return target;
    }

    /** Overlapped write to the client pipe, bounded so it can never park forever. */
    private static bool OverlappedWrite(Slot slot, IntPtr pipe, byte[] payload)
    {
        IntPtr buffer = Marshal.AllocHGlobal(payload.Length);
        try
        {
            Marshal.Copy(payload, 0, buffer, payload.Length);
            ResetEvent(slot.WriteEvent);
            uint written;
            if (!WriteFileOverlapped(pipe, buffer, (uint)payload.Length, out written, slot.WriteOverlap))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ERROR_IO_PENDING) return false;
                if (WaitForSingleObject(slot.WriteEvent, WRITE_TIMEOUT_MS) != 0) return false;
                if (!GetOverlappedResult(pipe, slot.WriteOverlap, out written, false)) return false;
            }
            return true;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    /** Frame write to the private host pipe (synchronous, blocking is correct). */
    private static bool WriteSlotFrame(Slot slot, byte kind, byte[] payload, int length)
    {
        byte[] frame = new byte[5 + length];
        frame[0] = kind;
        frame[1] = (byte)(length & 0xff);
        frame[2] = (byte)((length >> 8) & 0xff);
        frame[3] = (byte)((length >> 16) & 0xff);
        frame[4] = (byte)((length >> 24) & 0xff);
        if (length > 0) Buffer.BlockCopy(payload, 0, frame, 5, length);

        lock (slot.HostWriteGate)
        {
            int offset = 0;
            while (offset < frame.Length)
            {
                uint written;
                byte[] chunk = offset == 0 ? frame : Slice(frame, offset, frame.Length - offset);
                if (!WriteFile(slot.HostWriteHandle, chunk, (uint)chunk.Length, out written, IntPtr.Zero) || written == 0) return false;
                offset += (int)written;
            }
        }
        return true;
    }

    private static void WriteMeta(Slot slot, string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        WriteSlotFrame(slot, K_META, body, body.Length);
    }

    private static string NewNonce()
    {
        byte[] bytes = new byte[16];
        Random random = new Random(unchecked(Environment.TickCount * 31 + Thread.CurrentThread.ManagedThreadId));
        random.NextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (int i = 0; i < bytes.Length; i++) sb.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
        return sb.ToString();
    }

    // ---- fail closed -----------------------------------------------------

    /** Tear everything down immediately.  No degraded mode exists. */
    private static void FailClosed()
    {
        g_running = false;
        if (g_slots != null)
        {
            for (int i = 0; i < g_SlotCount; i++)
            {
                if (g_slots[i] == null) continue;
                IntPtr peer;
                lock (g_slots[i].PeerGate) { peer = g_slots[i].Peer; }
                if (peer != INVALID_HANDLE && peer != IntPtr.Zero)
                {
                    try { CancelIoEx(peer, IntPtr.Zero); } catch { /* best effort */ }
                }
            }
        }
        Thread.Sleep(50);
        Environment.Exit(1);
    }

    private static string Json(string value)
    {
        if (value == null) return "";
        StringBuilder sb = new StringBuilder(value.Length + 8);
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\' || c == '"') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }
}
