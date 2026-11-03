using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class WindowsIpcPipe
{
    const uint PipeAccessDuplex = 0x00000003;
    const uint FirstPipeInstance = 0x00080000;
    const uint Overlapped = 0x40000000;
    const uint RejectRemoteClients = 0x00000008;
    const int AccessDenied = 5;
    const int PipeBusy = 231;
    const int PeerLimit = 64;
    const int BufferSize = 65536;

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public int InheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode,
        uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SecurityAttributes attributes);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr securityDescriptor, IntPtr size);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr address);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);

    /** 只接受同会话本机连接；首次创建必须由系统原子确认端点未被占用。 */
    static NamedPipeServerStream Listen(string name, IntPtr descriptor, bool first, out int error)
    {
        var attributes = new SecurityAttributes
        {
            Length = Marshal.SizeOf(typeof(SecurityAttributes)),
            SecurityDescriptor = descriptor,
            InheritHandle = 0
        };
        var handle = CreateNamedPipeW(name, PipeAccessDuplex | Overlapped | (first ? FirstPipeInstance : 0u),
            RejectRemoteClients, 255, BufferSize, BufferSize, 0, ref attributes);
        error = Marshal.GetLastWin32Error();
        if (handle.IsInvalid)
        {
            handle.Dispose();
            return null;
        }
        try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
        catch { handle.Dispose(); throw; }
    }

    /** 连接独立于监听任务执行，归还槽位时观察并丢弃连接异常。 */
    static void StartPeer(NamedPipeServerStream pipe, int port, string secret, int session,
        CancellationToken shutdown, SemaphoreSlim peers)
    {
        Relay(pipe, port, secret, session, shutdown).ContinueWith(task =>
        {
            if (task.IsFaulted) GC.KeepAlive(task.Exception);
            peers.Release();
        }, TaskScheduler.Default);
    }

    /** 发送受保护的本机身份帧，之后原样搬运双向字节；不解析或记录 IPC 内容。 */
    static async Task Relay(NamedPipeServerStream pipe, int port, string secret, int session, CancellationToken shutdown)
    {
        using (pipe)
        using (var socket = new TcpClient(AddressFamily.InterNetwork))
        using (shutdown.Register(() => { pipe.Dispose(); socket.Close(); }))
        {
            try
            {
                uint clientPid, clientSession;
                if (!GetNamedPipeClientSessionId(pipe.SafePipeHandle, out clientSession) || clientSession != (uint)session ||
                    !GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid) || clientPid == 0 || clientPid > Int32.MaxValue) return;
                long startedAt;
                using (var process = Process.GetProcessById((int)clientPid))
                {
                    if (process.SessionId != session || process.HasExited) return;
                    startedAt = (process.StartTime.ToUniversalTime().Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
                }

                var connect = socket.ConnectAsync(IPAddress.Loopback, port);
                if (await Task.WhenAny(connect, Task.Delay(2000, shutdown)).ConfigureAwait(false) != connect)
                {
                    socket.Close();
                    await connect.ConfigureAwait(false);
                    return;
                }
                await connect.ConfigureAwait(false);
                socket.NoDelay = true;
                using (var stream = socket.GetStream())
                {
                    var body = Encoding.UTF8.GetBytes("{\"type\":\"bridge-peer\",\"secret\":\"" + secret + "\",\"pid\":" +
                        clientPid.ToString(CultureInfo.InvariantCulture) + ",\"startedAt\":" + startedAt.ToString(CultureInfo.InvariantCulture) + "}");
                    var prefix = BitConverter.GetBytes(body.Length);
                    await stream.WriteAsync(prefix, 0, prefix.Length, shutdown).ConfigureAwait(false);
                    await stream.WriteAsync(body, 0, body.Length, shutdown).ConfigureAwait(false);
                    var toNode = pipe.CopyToAsync(stream, BufferSize, shutdown);
                    var toClient = stream.CopyToAsync(pipe, BufferSize, shutdown);
                    await Task.WhenAny(toNode, toClient).ConfigureAwait(false);
                    // 先关闭两端，再等待另一方向结束，避免留住半关闭的管道句柄。
                    pipe.Dispose();
                    socket.Close();
                    await Task.WhenAll(toNode, toClient).ConfigureAwait(false);
                }
            }
            catch (Exception) { /* 客户端退出或 I/O 异常只结束该连接，禁止记录帧或身份。 */ }
        }
    }

    /** 保持新监听句柄先于旧连接交接，退出时收回监听与活动连接。 */
    static async Task Accept(NamedPipeServerStream first, string name, IntPtr descriptor,
        int port, string secret, int session, CancellationTokenSource shutdown)
    {
        var listener = first;
        var peers = new SemaphoreSlim(PeerLimit);
        using (shutdown.Token.Register(() => { var current = listener; if (current != null) current.Dispose(); }))
        {
            try
            {
                while (!shutdown.IsCancellationRequested)
                {
                    bool connected = true;
                    try { await listener.WaitForConnectionAsync(shutdown.Token).ConfigureAwait(false); }
                    catch (IOException failure)
                    {
                        // 客户端在连接建立和监听回执之间关闭时，保持服务端端点并换一个监听句柄。
                        int code = failure.HResult & 0xffff;
                        if (code != 109 && code != 232 && code != 233) throw;
                        connected = false;
                    }
                    if (shutdown.IsCancellationRequested) break;
                    int error;
                    var previous = listener;
                    var next = Listen(name, descriptor, false, out error);
                    if (next == null) throw new IOException("无法续接管道监听");
                    listener = next;
                    if (!connected || shutdown.IsCancellationRequested || !peers.Wait(0)) { previous.Dispose(); continue; }
                    StartPeer(previous, port, secret, session, shutdown.Token, peers);
                }
            }
            finally
            {
                listener.Dispose();
            }
        }
    }

    /** stdin 关闭代表父进程退出；占用时可等待，但始终只重试首次原子创建。 */
    public static int Run(string pipeName, bool waitForRelease)
    {
        int port, session;
        var secret = Environment.GetEnvironmentVariable("CODEX_MOBILE_IPC_SECRET");
        if (pipeName == null || !Regex.IsMatch(pipeName, "\\A[a-zA-Z0-9][a-zA-Z0-9-]{0,100}\\z") ||
            secret == null || !Regex.IsMatch(secret, "\\A[a-zA-Z0-9_-]{32,128}\\z") ||
            !Int32.TryParse(Environment.GetEnvironmentVariable("CODEX_MOBILE_IPC_PORT"), NumberStyles.None, CultureInfo.InvariantCulture, out port) ||
            port < 1 || port > 65535) return 1;

        IntPtr descriptor;
        using (var user = WindowsIdentity.GetCurrent())
        using (var process = Process.GetCurrentProcess())
        {
            session = process.SessionId;
            // 同用户的客户端需要 GENERIC_READ 和 GENERIC_WRITE，连接后还核对当前 Windows 会话。
            if (user.User == null || !ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;" + user.User.Value + ")", 1, out descriptor, IntPtr.Zero)) return 1;
        }
        var shutdown = new CancellationTokenSource();
        Task.Run(() =>
        {
            try { using (var input = Console.OpenStandardInput()) while (input.ReadByte() >= 0) { } }
            catch (Exception) { }
            shutdown.Cancel();
        });
        try
        {
            var name = @"\\.\pipe\" + pipeName;
            bool reportedBusy = false;
            while (!shutdown.IsCancellationRequested)
            {
                int error;
                var first = Listen(name, descriptor, true, out error);
                if (first != null)
                {
                    using (first)
                    {
                        Console.WriteLine("ready");
                        Console.Out.Flush();
                        Accept(first, name, descriptor, port, secret, session, shutdown).GetAwaiter().GetResult();
                    }
                    return 0;
                }
                if (error != AccessDenied && error != PipeBusy) return 1;
                if (!reportedBusy) { Console.WriteLine("busy"); Console.Out.Flush(); reportedBusy = true; }
                if (!waitForRelease) return 0;
                shutdown.Token.WaitHandle.WaitOne(500);
            }
            return 0;
        }
        catch (Exception) { return shutdown.IsCancellationRequested ? 0 : 1; }
        finally
        {
            shutdown.Cancel();
            LocalFree(descriptor);
        }
    }
}
