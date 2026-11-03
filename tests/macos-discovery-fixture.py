"""跨平台合成系统快照，执行真实 Mac 发现器；不枚举测试机器的进程或端口。"""
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mac_discovery", Path(__file__).parents[1] / "apps/bridge/macos-instances.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.load(sys.stdin)
binary = "/Applications/Codex.app/Contents/MacOS/Codex"
rows = config.get("instances", [{"pid": 101, "port": "23451"}])
by_pid = {row["pid"]: row for row in rows}
clock_reads = {}


def system(*args):
    """按 PID 返回合成进程、Unix 通道和真实格式的 lsof 字段。"""
    if args[0] == "/usr/bin/codesign":
        return ""
    if args[1:2] == ("-axo",):
        return "\n".join(f"{pid} {os.getuid()} {binary}" for pid in by_pid)
    if args[-1] == "lstart=":
        pid = int(args[2]); row = by_pid.get(pid, {})
        clock_reads[pid] = clock_reads.get(pid, 0) + 1
        second = 2 if row.get("restart") and clock_reads[pid] > 1 else 1
        return f"Wed Jan 01 00:00:0{second} 2025"
    if args[-1] == "ppid=,uid=":
        return str(config.get("childParent", 1)) + " " + str(os.getuid())
    if "-U" in args:
        pid = int(args[args.index("-p") + 1])
        return f"n/synthetic/{pid}/ipc/ipc.sock\nn/private/tmp/codex-app-tools/00000000-0000-4000-8000-{pid:012d}.sock"
    if any(value.startswith("-iTCP:") for value in args):
        port = next(value.split(":")[1] for value in args if value.startswith("-iTCP:"))
        row = next((row for row in rows if str(row.get("port")) == port or row.get("activePort") == port), rows[0])
        owner = row.get("listenerPid", row["pid"])
        result = f"p{owner}\nf69\nn{row.get('address', '127.0.0.1')}:{port}"
        if row.get("childPid"):
            result += f"\np{row['childPid']}\nf69\nn127.0.0.1:{port}"
        return result
    raise AssertionError("未预期的系统调用")


def arguments(pid):
    """参数使用独立目录；端口值缺省表示未启用调试。"""
    row = by_pid[pid]
    argv = [binary]
    if "port" in row:
        argv.append("--remote-debugging-port=" + row["port"])
    return argv + row.get("extraArgs", []), {"CODEX_HOME": f"/synthetic/{pid}", "CODEX_ELECTRON_USER_DATA_PATH": f"/synthetic/{pid}/ui"}


def info(file):
    """缺省不存在动态端点文件；可合成过期、异主或符号链接的拒绝场景。"""
    if file.name != "DevToolsActivePort":
        return SimpleNamespace(st_mode=stat.S_IFSOCK, st_uid=os.getuid())
    row = by_pid[int(file.parts[2])]
    if "activePort" not in row:
        raise FileNotFoundError()
    return SimpleNamespace(st_mode=stat.S_IFLNK if row.get("symlink") else stat.S_IFREG,
                           st_uid=os.getuid() + int(row.get("foreignFile", False)), st_size=60,
                           st_mtime=0 if row.get("stale") else 2000000000)


def read(file, *args, **kwargs):
    row = by_pid[int(file.parts[2])]
    return row["activePort"] + "\n/devtools/browser/00000000-0000-4000-8000-000000000001\n"


with patch.object(module, "run", system), patch.object(module, "arguments", arguments), patch.object(module, "executable", lambda pid: binary), patch.object(Path, "resolve", lambda self, **kwargs: self), patch.object(Path, "lstat", info), patch.object(Path, "read_text", read):
    try:
        print(json.dumps({"rows": module.discover()}))
    except ValueError:
        print(json.dumps({"error": "实例身份已变化"}))
