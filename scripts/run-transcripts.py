#!/usr/bin/env python3
"""无窗口运行 update-transcripts.bat，由 Task Scheduler 用 pythonw 调用，避免弹控制台窗口。"""
import os, subprocess, sys

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bat = os.path.join(ROOT, "scripts", "update-transcripts.bat")
# CREATE_NO_WINDOW：不创建新控制台窗口
subprocess.run(["cmd", "/c", bat], cwd=ROOT, creationflags=0x08000000)
