"""只读核对当前用户的原桌面，环境中只保留实例目录，不输出鉴权字段。"""
import ctypes
import datetime
import json
import os
import re
from pathlib import Path
import stat
import struct
import subprocess
import sys


def run(*args):
    """固定系统程序不经过 shell，所有诊断由调用方转换为中文固定提示。"""
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=5).decode()


def arguments(pid):
    """通过内核的空字符边界读取参数，目录含空格时也不会误解析环境。"""
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2
    size = ctypes.c_size_t(1024 * 1024)
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
        raise ValueError("进程参数不可读")
    data = buffer.raw[:size.value]
    argc = struct.unpack("i", data[:4])[0]
    offset = data.index(b"\0", 4) + 1
    while data[offset] == 0:
        offset += 1
    parts = data[offset:].split(b"\0")
    argv = [part.decode() for part in parts[:argc]]
    environment = {}
    for part in parts[argc:]:
        key, _, value = part.partition(b"=")
        if key in (b"CODEX_HOME", b"CODEX_ELECTRON_USER_DATA_PATH"):
            environment[key.decode()] = value.decode()
    return argv, environment


def executable(pid):
    """核对内核记录的实际可执行路径，不相信进程名称或命令行伪装。"""
    lib = ctypes.CDLL("/usr/lib/libproc.dylib")
    buffer = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, buffer, len(buffer)) <= 0:
        raise ValueError("进程路径不可读")
    return buffer.value.decode()


def started_at(pid):
    """使用内核进程启动时间标识代次，发现前后复核，拒绝 PID 被复用。"""
    stamp = run("/bin/ps", "-p", str(pid), "-o", "lstart=").strip()
    return int(datetime.datetime.strptime(stamp, "%a %b %d %H:%M:%S %Y").timestamp() * 1000)


def belongs_to_instance(owner, pid, started):
    """桌面子进程可能继承监听句柄；只接受同用户、同代次主进程的后代。"""
    seen = set()
    for _ in range(16):
        if owner == pid:
            return True
        if owner <= 1 or owner in seen or started_at(owner) < started:
            return False
        seen.add(owner)
        parent, uid = map(int, run("/bin/ps", "-p", str(owner), "-o", "ppid=,uid=").split())
        if uid != os.getuid():
            return False
        owner = parent
    return False


def debug_port(pid, argv, user_data, started):
    """仅核对该实例声明的端点；文件或参数都不能代替实际 PID 和回环监听归属。"""
    try:
        values = []
        for index, arg in enumerate(argv):
            if arg.startswith("--remote-debugging-port="):
                values.append(arg.split("=", 1)[1])
            elif arg == "--remote-debugging-port":
                values.append(argv[index + 1] if index + 1 < len(argv) else "")
        if len(values) > 1 or values and not re.fullmatch(r"[0-9]{1,5}", values[0]):
            return None
        port = int(values[0]) if values else 0
        if not 0 <= port <= 65535:
            return None
        if port == 0:
            # 动态端口必须来自本实例配置目录的新文件；不猜测其他目录或枚举全机端口。
            directory = Path(user_data) if user_data else Path.home() / "Library/Application Support/Codex"
            active = directory / "DevToolsActivePort"
            info = active.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 256 or info.st_mtime * 1000 < started:
                return None
            lines = active.read_text().splitlines()
            if len(lines) != 2 or not re.fullmatch(r"[0-9]{1,5}", lines[0]) or not re.fullmatch(r"/devtools/browser/[0-9a-f-]{36}", lines[1], re.I):
                return None
            port = int(lines[0])
        if not 1 <= port <= 65535:
            return None
        # 不只查询本进程：同端口若还有其他进程或非回环绑定，也不能接纳。
        listeners = run("/usr/sbin/lsof", "-nP", "-iTCP:" + str(port), "-sTCP:LISTEN", "-Fpn")
        owner = None
        addresses = []
        main_listens = False
        for line in listeners.splitlines():
            if line.startswith("p"):
                owner = int(line[1:])
                if not belongs_to_instance(owner, pid, started):
                    return None
            elif line.startswith("n"):
                if owner is None:
                    return None
                addresses.append(line[1:])
                main_listens = main_listens or owner == pid
        # 读取器固定连接 IPv4 回环；仅有 IPv6 时不冒充可连接。
        if not main_listens or "127.0.0.1:" + str(port) not in addresses or any(value not in ("127.0.0.1:" + str(port), "[::1]:" + str(port)) for value in addresses):
            return None
        return port
    except (OSError, ValueError, subprocess.SubprocessError):
        # 端点尚未就绪只影响原生引用，不让已有 IPC 列表连接掉线。
        return None


def discover():
    """仅接纳官方签名的桌面主进程及该进程持有的私有 Unix 套接字。"""
    rows = []
    signed = set()
    homes = [Path("/Applications"), Path.home() / "Applications"]
    allowed = {str(root / app / "Contents/MacOS" / name)
               for root in homes for app, name in [("ChatGPT.app", "ChatGPT"), ("Codex.app", "Codex")]}
    snapshot = run("/bin/ps", "-axo", "pid=,uid=,comm=")
    for line in snapshot.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3 or fields[2] not in allowed or int(fields[1]) != os.getuid():
            continue
        pid = int(fields[0])
        started = started_at(pid)
        binary = executable(pid)
        if binary != fields[2]:
            raise ValueError("进程身份已变化")
        bundle = str(Path(binary).parents[2])
        if bundle not in signed:
            run("/usr/bin/codesign", "--verify", "--strict", "-R",
                '=anchor apple generic and identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"', bundle)
            signed.add(bundle)
        argv, env = arguments(pid)
        if any(arg.startswith("--type=") for arg in argv):
            continue
        home = Path(env.get("CODEX_HOME") or str(Path.home() / ".codex"))
        user_data = env.get("CODEX_ELECTRON_USER_DATA_PATH") or None
        for i, arg in enumerate(argv):
            if not user_data and arg.startswith("--user-data-dir="):
                user_data = arg.split("=", 1)[1]
            elif not user_data and arg == "--user-data-dir" and i + 1 < len(argv):
                user_data = argv[i + 1]
        if not home.is_absolute() or user_data and not Path(user_data).is_absolute():
            raise ValueError("实例目录无效")
        home = home.resolve(strict=True)
        if user_data:
            user_data = str(Path(user_data).resolve(strict=True))
        ipc = home / "ipc/ipc.sock"
        paths = {line[1:] for line in run("/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), "-U", "-Fn").splitlines() if line.startswith("n/")}
        native = {str(Path(value).resolve()) for value in paths
                  if str(Path(value).parent) in ("/tmp/codex-app-tools", "/private/tmp/codex-app-tools")
                  and re.fullmatch(r"[0-9a-f-]{36}\.sock", Path(value).name)}
        if len(native) != 1 or str(ipc) not in {str(Path(value).resolve()) for value in paths}:
            raise ValueError("实例套接字归属不完整")
        for socket in [ipc, Path(next(iter(native)))]:
            info = socket.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("实例套接字身份无效")
        # 启动时间和路径二次读取，避免在退出或 PID 换代期间登记旧身份。
        port = debug_port(pid, argv, user_data, started)
        current_argv, current_env = arguments(pid)
        if executable(pid) != binary or started_at(pid) != started or current_argv != argv or current_env != env:
            raise ValueError("进程身份已变化")
        rows.append(dict(platform="darwin", pid=pid, startedAt=started, executable=binary,
                         codexHome=str(home), userData=user_data, nativePipe=next(iter(native)),
                         ipcSocketPath=str(ipc), port=port))
    if len(rows) > 16:
        raise ValueError("实例数量超限")
    return rows


if __name__ == "__main__":
    try:
        print(json.dumps(discover(), ensure_ascii=False))
    except Exception:
        print("Mac 实例身份核对不完整", file=sys.stderr)
        sys.exit(1)
