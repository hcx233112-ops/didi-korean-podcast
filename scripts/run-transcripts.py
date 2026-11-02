#!/usr/bin/env python3
"""无窗口运行 update-transcripts.bat，由 Task Scheduler 用 pythonw 调用，避免弹控制台窗口。"""
import os, subprocess, sys
from pathlib import Path
from automation_common import ProcessLock, write_status

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bat = os.path.join(ROOT, "scripts", "update-transcripts.bat")
# CREATE_NO_WINDOW：不创建新控制台窗口
def main():
    lock = ProcessLock(Path(ROOT) / "logs" / "repository-lock.log")
    if not lock.acquire():
        print("仓库正被另一个自动任务使用，稍后重试")
        return 1
    try:
        write_status("transcript", "running")
        code = subprocess.run(["cmd", "/c", bat], cwd=ROOT, creationflags=0x08000000, timeout=3 * 3600).returncode
        write_status("transcript", "success" if code == 0 else "failed", exit_code=code)
        return code
    except Exception as exc:
        write_status("transcript", "failed", error=str(exc))
        return 1
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
