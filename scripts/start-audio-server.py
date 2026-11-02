#!/usr/bin/env python3
"""Start the project's audio services without visible windows; verify the origin."""
import json
import subprocess
import sys
import time
from pathlib import Path
from automation_common import NO_WINDOW, ProcessLock

ROOT = Path(__file__).resolve().parent.parent


def already_running(name):
    executable = str(ROOT / name).replace("'", "''")
    script = f"@(Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -eq '{executable}' }}).Count"
    result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW)
    if result.returncode:
        raise RuntimeError("无法检查音频服务进程")
    return int(result.stdout.strip() or "0") > 0


def main():
    lock = ProcessLock(ROOT / "logs" / "audio-server-lock.log")
    if not lock.acquire():
        return 0
    children = []
    try:
        for name, arguments in [("caddy.exe", ["run", "--config", str(ROOT / "Caddyfile")]), ("cloudflared.exe", ["tunnel", "run"])]:
            if already_running(name):
                continue
            # Persistent logs capture early startup failures even under pythonw.
            log_path = ROOT / "logs" / (name + ".log")
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("ab") as log:
                child = subprocess.Popen([str(ROOT / name), *arguments], cwd=ROOT, stdout=log, stderr=log, creationflags=NO_WINDOW)
            children.append(child)
        time.sleep(1)
        if any(child.poll() is not None for child in children):
            return 1
        from watchdog import probe_audio
        sample = next((ROOT / "audio").glob("*.m4a"), None)
        if sample:
            for _ in range(3):
                if probe_audio("http://localhost:8080", sample.stem):
                    return 0
                time.sleep(1)
            return 1
        return 1  # A process existing is not evidence of playable audio.
    except Exception as exc:
        if sys.stderr:
            print(f"音频服务启动失败: {exc}", file=sys.stderr)
        return 1
    finally:
        lock.release()


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            stream.reconfigure(encoding="utf-8")
    sys.exit(main())
