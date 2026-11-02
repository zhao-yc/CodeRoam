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
        stamp = run("/bin/ps", "-p", str(pid), "-o", "lstart=").strip()
        started = int(datetime.datetime.strptime(stamp, "%a %b %d %H:%M:%S %Y").timestamp() * 1000)
        if executable(pid) != binary:
            raise ValueError("进程身份已变化")
        rows.append(dict(platform="darwin", pid=pid, startedAt=started, executable=binary,
                         codexHome=str(home), userData=user_data, nativePipe=next(iter(native)),
                         ipcSocketPath=str(ipc), port=None))
    if len(rows) > 16:
        raise ValueError("实例数量超限")
    return rows


if __name__ == "__main__":
    try:
        print(json.dumps(discover(), ensure_ascii=False))
    except Exception:
        print("Mac 实例身份核对不完整", file=sys.stderr)
        sys.exit(1)
