using System;
using System.IO;
using System.Text;
using System.Threading;
using System.ServiceProcess;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Web.Script.Serialization;

// 服务只负责生命周期；桥接始终以指定用户的普通令牌在交互会话中运行。
public sealed class BridgeService : ServiceBase {
    readonly object gate = new object();
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    Settings settings;
    Timer timer;
    IntPtr worker = IntPtr.Zero, job = IntPtr.Zero;
    uint workerPid;
    DateTime retryAt = DateTime.MinValue;
    bool stopping;
    public class Settings { public string UserSid, NodePath, SupervisorPath, WorkerConfig, ProjectRoot; }
    public BridgeService() { ServiceName="CodexMobileBridge"; CanStop=true; CanShutdown=true; CanHandleSessionChangeEvent=true; AutoLog=true; }
    public static void Main() { ServiceBase.Run(new BridgeService()); }

    // 记录服务层可观测的退出码；不会把未知强制终止误报为应用崩溃。
    void Log(string name, object details) {
        try {
            string file=Path.Combine(root,"service.jsonl");
            if(File.Exists(file)&&new FileInfo(file).Length>2097152) { if(File.Exists(file+".1"))File.Delete(file+".1");File.Move(file,file+".1"); }
            File.AppendAllText(file,new JavaScriptSerializer().Serialize(new {time=DateTime.UtcNow.ToString("o"), @event=name, servicePid=System.Diagnostics.Process.GetCurrentProcess().Id, details=details})+Environment.NewLine,Encoding.UTF8);
        } catch { }
    }
    // 启动服务仅加载受保护的路径配置；尚未登录时由定时检查等待会话。
    protected override void OnStart(string[] args) {
        settings=new JavaScriptSerializer().Deserialize<Settings>(File.ReadAllText(Path.Combine(root,"service.json"),Encoding.UTF8));
        foreach(string file in new[]{settings.NodePath,settings.SupervisorPath,settings.WorkerConfig})if(!Path.IsPathRooted(file)||!File.Exists(file))throw new InvalidOperationException("固定启动路径无效");
        new SecurityIdentifier(settings.UserSid);
        stopping=false;Log("service_started",null);timer=new Timer(Tick,null,0,3000);
    }
    // 会话变化只记状态，不触发登录或提升用户权限。
    protected override void OnSessionChange(SessionChangeDescription change) { Log("session_changed",new {reason=change.Reason.ToString(),sessionId=change.SessionId}); }
    protected override void OnShutdown() { OnStop(); }
    protected override void OnStop() {
        lock(gate) {
            stopping=true;if(timer!=null)timer.Dispose();
            Log("service_stopping",new {workerPid=workerPid,planned=true});
            // 作业对象只含本服务启动的守护与桥接，不涉及 Codex 桌面任务。
            Cleanup(true);Log("service_stopped",null);
        }
    }
    // 关闭服务专有句柄；作业对象不会影响不属于本服务的进程。
    void Cleanup(bool terminate) {
        if(job!=IntPtr.Zero){if(terminate)Native.TerminateJobObject(job,0xC000013A);Native.CloseHandle(job);job=IntPtr.Zero;}
        if(worker!=IntPtr.Zero){Native.CloseHandle(worker);worker=IntPtr.Zero;}workerPid=0;
    }
    // 每次只维护一个指定用户的守护，退出后退避重建，避免重启风暴。
    void Tick(object _) {
        lock(gate) {
            if(stopping)return;
            try {
                if(worker!=IntPtr.Zero) {
                    uint code;if(!Native.GetExitCodeProcess(worker,out code))throw new Win32Exception(Marshal.GetLastWin32Error());
                    if(Native.WaitForSingleObject(worker,0)==0) { Log("supervisor_exit",new {workerPid=workerPid,exitCode=code,planned=false});Cleanup(true);retryAt=DateTime.UtcNow.AddSeconds(5); }
                    else return;
                }
                if(DateTime.UtcNow<retryAt)return;
                IntPtr token;int session=FindUserSession(out token);if(session<0)return;
                try{Launch(token,session);}finally{Native.CloseHandle(token);}
            } catch(Exception e) { Log("service_tick_failed",new {errorType=e.GetType().Name,errorCode=e is Win32Exception?((Win32Exception)e).NativeErrorCode:0});Cleanup(true);retryAt=DateTime.UtcNow.AddSeconds(15); }
        }
    }
    // 不登录账号、不保存密码；只使用已登录且 SID 完全匹配的会话。
    int FindUserSession(out IntPtr selected) {
        selected=IntPtr.Zero;IntPtr sessions;int count;
        if(!Native.WTSEnumerateSessions(IntPtr.Zero,0,1,out sessions,out count))throw new Win32Exception(Marshal.GetLastWin32Error());
        try {for(int i=0;i<count;i++) {
            var item=(Native.SessionInfo)Marshal.PtrToStructure(IntPtr.Add(sessions,i*Marshal.SizeOf(typeof(Native.SessionInfo))),typeof(Native.SessionInfo));
            if(item.SessionID==0||(item.State!=0&&item.State!=4))continue;
            IntPtr token;if(!Native.WTSQueryUserToken(item.SessionID,out token))continue;
            bool keep=false;
            try {
                using(var identity=new WindowsIdentity(token))if(identity.User.Value!=settings.UserSid)continue;
                // WTS 令牌必须为普通用户令牌，不能给桥接增加管理员权限。
                int elevation,size;if(!Native.GetTokenInformation(token,20,out elevation,4,out size))throw new Win32Exception(Marshal.GetLastWin32Error());
                if(elevation!=0)throw new InvalidOperationException("拒绝以提升的用户令牌运行桥接");
                keep=true;selected=token;return item.SessionID;
            } finally {if(!keep)Native.CloseHandle(token);}
        }} finally {Native.WTSFreeMemory(sessions);}return -1;
    }
    // 所有可执行参数均为固定路径，禁止引入额外命令或换行。
    static string Quote(string value) { if(value.IndexOf('"')>=0||value.IndexOf('\n')>=0||value.IndexOf('\r')>=0)throw new InvalidOperationException("路径包含非法字符");return "\""+value+"\""; }
    // 以已核对用户令牌创建隐藏进程，再接入本服务的作业对象。
    void Launch(IntPtr token,int session) {
        IntPtr environment=IntPtr.Zero;Native.ProcessInfo info=new Native.ProcessInfo();
        if(!Native.CreateEnvironmentBlock(out environment,token,false))throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var start=new Native.StartupInfo();start.cb=Marshal.SizeOf(start);start.lpDesktop="winsta0\\default";start.dwFlags=1;start.wShowWindow=0;
            var command=new StringBuilder(Quote(settings.NodePath)+" "+Quote(settings.SupervisorPath)+" --config "+Quote(settings.WorkerConfig));
            // 先挂起再加入服务自己的作业对象，避免守护抢先创建不受托管的子进程。
            if(!Native.CreateProcessAsUser(token,settings.NodePath,command,IntPtr.Zero,IntPtr.Zero,false,0x08000404,environment,settings.ProjectRoot,ref start,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
            worker=info.hProcess;workerPid=info.dwProcessId;
            job=Native.CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits=new Native.JobLimits();limits.BasicLimitInformation.LimitFlags=0x2000;
            if(!Native.SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))||!Native.AssignProcessToJobObject(job,worker))throw new Win32Exception(Marshal.GetLastWin32Error());
            if(Native.ResumeThread(info.hThread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());
            Log("supervisor_started",new {workerPid=workerPid,sessionId=session});
        } catch {if(info.hProcess!=IntPtr.Zero)Native.TerminateProcess(info.hProcess,1);throw;}
        finally {if(info.hThread!=IntPtr.Zero)Native.CloseHandle(info.hThread);if(environment!=IntPtr.Zero)Native.DestroyEnvironmentBlock(environment);}
    }
}

// 固定 Windows API 声明；句柄由服务明确释放，不注入桌面进程。
static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct SessionInfo {public int SessionID;public IntPtr Name;public int State;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct StartupInfo {public int cb;public string lpReserved,lpDesktop,lpTitle;public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;public short wShowWindow,cbReserved2;public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;}
    [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo {public IntPtr hProcess,hThread;public uint dwProcessId,dwThreadId;}
    [StructLayout(LayoutKind.Sequential)] public struct BasicLimits {public long PerProcessUserTimeLimit,PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;public uint ActiveProcessLimit;public IntPtr Affinity;public uint PriorityClass,SchedulingClass;}
    [StructLayout(LayoutKind.Sequential)] public struct IoCounters {public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;}
    [StructLayout(LayoutKind.Sequential)] public struct JobLimits {public BasicLimits BasicLimitInformation;public IoCounters IoInfo;public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;}
    [DllImport("wtsapi32.dll",SetLastError=true)] public static extern bool WTSEnumerateSessions(IntPtr server,int reserved,int version,out IntPtr sessions,out int count);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll",SetLastError=true)] public static extern bool WTSQueryUserToken(int session,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token,int type,out int value,int size,out int returned);
    [DllImport("userenv.dll",SetLastError=true)] public static extern bool CreateEnvironmentBlock(out IntPtr environment,IntPtr token,bool inherit);
    [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcessAsUser(IntPtr token,string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo start,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int type,ref JobLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr process,uint timeout);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
