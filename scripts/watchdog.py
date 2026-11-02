#!/usr/bin/env python3
"""Inspect task state, completed work and actual Range delivery. No false repair claims."""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from automation_common import NO_WINDOW, ProcessLock, read_json, write_status
from audio_validation import AudioValidator

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "audio"
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
LOG_FILE = ROOT / "audio-log.txt"
WATCHDOG_LOG = ROOT / "watchdog-log.txt"
SYNC_SCRIPT = ROOT / "scripts" / "sync-audio.py"
TASK_NAMES = ["DidiPodcast-SyncAudio", "DidiPodcast-Watchdog", "DidiPodcast-AudioServer", "podcast-audio-update", "podcast-transcript-update"]


def log(message):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}"
    if sys.stdout:
        print(line, flush=True)
    with WATCHDOG_LOG.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")


def notify(title, body):
    title, body = title.replace("'", "''"), body.replace("'", "''")
    script = f"""Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.Visible = $true
$n.ShowBalloonTip(8000, '{title}', '{body}', [System.Windows.Forms.ToolTipIcon]::Warning)
Start-Sleep -Seconds 9
$n.Dispose()
"""
    subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script], creationflags=NO_WINDOW)


def parse_last_sync():
    """Legacy log fallback, including failures after the last completed attempt."""
    if not LOG_FILE.exists():
        return None, True
    last_done = None
    failed = False
    for line in reversed(LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()):
        match = re.match(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]", line)
        if not match:
            continue
        if "失败" in line and "失败: 0" not in line:
            failed = True
        if "===== 完成 =====" in line and last_done is None:
            last_done = datetime.strptime(match[1], "%Y-%m-%d %H:%M:%S")
        if last_done and "===== sync-audio 开始 =====" in line:
            break
    return last_done, failed


def task_states():
    names = ",".join("'" + name + "'" for name in TASK_NAMES)
    script = """$ErrorActionPreference='Stop'; @(%s) | ForEach-Object {
 $name=$_; $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
 if ($null -eq $task) { [pscustomobject]@{name=$name;exists=$false;enabled=$false} }
 else { $info=$task|Get-ScheduledTaskInfo; [pscustomobject]@{name=$name;exists=$true;enabled=($task.State -ne 'Disabled' -and $task.Settings.Enabled);state=[string]$task.State;last_result=$info.LastTaskResult;last_run=$info.LastRunTime.ToString('o')} }
} | ConvertTo-Json -Compress""" % names
    result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=NO_WINDOW)
    if result.returncode:
        raise RuntimeError(f"无法读取任务计划: {result.stderr[-300:]}")
    data = json.loads(result.stdout.lstrip("\ufeff"))
    return {row["name"]: row for row in (data if isinstance(data, list) else [data])}


def configure_tasks():
    result = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / "setup-scheduler.ps1")], capture_output=True, text=True, timeout=60, creationflags=NO_WINDOW)
    return result.returncode == 0


def video_list():
    videos = []
    for path in CHANNELS_DIR.glob("*.json"):
        videos.extend(json.loads(path.read_text(encoding="utf-8")).get("videos", []))
    return videos


def probe_audio(base, video_id):
    request = urllib.request.Request(base.rstrip("/") + "/" + video_id + ".m4a", headers={"Range": "bytes=0-100", "User-Agent": "DidiPodcast-Healthcheck/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status == 206 and response.headers.get("Content-Range", "").startswith("bytes 0-100/") and len(response.read(102)) == 101
    except (OSError, ValueError):
        return False


def public_base():
    value = os.environ.get("NEXT_PUBLIC_AUDIO_BASE", "")
    if not value:
        env = ROOT / ".env.production"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                if line.startswith("NEXT_PUBLIC_AUDIO_BASE="):
                    value = line.split("=", 1)[1].strip().strip('"\'')
    return value


def recover_services():
    result = subprocess.run([sys.executable, str(ROOT / "scripts" / "start-audio-server.py")], cwd=ROOT, capture_output=True, timeout=30, creationflags=NO_WINDOW)
    return result.returncode == 0


def run_sync_now():
    subprocess.Popen([sys.executable, str(SYNC_SCRIPT)], cwd=ROOT, creationflags=NO_WINDOW)
    log("已请求音频补跑，结果待后续巡检确认")


def age_hours(timestamp):
    try:
        value = datetime.fromisoformat(timestamp)
        if value.tzinfo is None:
            value = value.astimezone()
        return (datetime.now(timezone.utc) - value).total_seconds() / 3600
    except (TypeError, ValueError):
        return float("inf")


def main():
    lock = ProcessLock(ROOT / "logs" / "watchdog-lock.log")
    if not lock.acquire():
        return 0
    issues, recovered, pending = [], [], []
    try:
        if WATCHDOG_LOG.exists() and WATCHDOG_LOG.stat().st_size > 150000:
            lines = WATCHDOG_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
            WATCHDOG_LOG.write_text("\n".join(lines[-500:]) + "\n", encoding="utf-8")
        log("===== watchdog 检查 =====")
        states = task_states()
        bad_tasks = [name for name in TASK_NAMES if not states.get(name, {}).get("exists") or not states.get(name, {}).get("enabled")]
        if bad_tasks:
            configure_tasks()
            states = task_states()  # The registration exit code alone is insufficient.
            remaining = [name for name in bad_tasks if not states.get(name, {}).get("exists") or not states.get(name, {}).get("enabled")]
            if remaining:
                issues.append("任务缺失或禁用: " + ", ".join(remaining))
            else:
                recovered.append("已验证任务恢复启用")
        for name, state in states.items():
            if state.get("last_result", 0) not in (0, 267009, 267011) and state.get("state") != "Running":
                issues.append(f"{name} 最近退出码 {state['last_result']}")

        audio = read_json(ROOT / "logs" / "audio-status.log")
        retry_audio = False
        if audio:
            age = age_hours(audio.get("updated_at"))
            if audio.get("status") == "running" and age <= 2:
                pending.append("音频同步仍在执行")
            elif audio.get("status") in ("failed", "pending") or (audio.get("status") == "running" and age > 2) or age > 5:
                issues.append(f"音频同步状态异常或过期: {audio.get('status')}")
                retry_audio = True
        else:
            last, failed = parse_last_sync()
            if last is None or failed or (datetime.now() - last).total_seconds() > 5 * 3600:
                issues.append("音频同步缺少近期成功记录")
                retry_audio = True

        transcript = read_json(ROOT / "logs" / "transcript-status.log")
        if transcript:
            if transcript.get("status") == "running" and age_hours(transcript.get("updated_at")) <= 3:
                pending.append("字幕任务仍在执行")
            elif transcript.get("status") != "success" or age_hours(transcript.get("updated_at")) > 30:
                issues.append("字幕更新失败或超过30小时未成功")
        else:
            state = states.get("podcast-transcript-update", {})
            if not state.get("last_run") or age_hours(state["last_run"]) > 30 or state.get("last_result", 1) != 0:
                issues.append("字幕任务缺少近期成功记录")

        videos = video_list()
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe") or (str(Path(ffmpeg).with_name("ffprobe.exe")) if ffmpeg else "ffprobe")
        validator = AudioValidator(ROOT / "logs" / "audio-validation.log", ffprobe)
        missing = [v for v in videos if not validator.valid(AUDIO_DIR / f"{v['id']}.m4a", v.get("duration", 0))]
        validator.save()
        if missing:
            issues.append(f"{len(missing)} 个视频音频缺失或时长/容器校验失败")
            retry_audio = True
        if retry_audio and not (audio and audio.get("status") == "running" and age_hours(audio.get("updated_at")) <= 2):
            run_sync_now()
            pending.append("音频补跑已触发，尚未验证完成")

        sample = next((v["id"] for v in videos if (AUDIO_DIR / f"{v['id']}.m4a").exists()), None)
        if sample:
            base = public_base()
            local_ok = probe_audio("http://localhost:8080", sample)
            public_ok = bool(base) and probe_audio(base, sample)
            if not local_ok or not public_ok:
                recover_services()
                # Startup is asynchronous: bounded retries, then alert if still broken.
                for _ in range(3):
                    time.sleep(2)
                    local_ok = probe_audio("http://localhost:8080", sample)
                    public_ok = bool(base) and probe_audio(base, sample)
                    if local_ok and public_ok:
                        recovered.append("音频服务已恢复并通过本机/公网Range复测")
                        break
                if not local_ok:
                    issues.append("本机音频Range请求失败")
                if not public_ok:
                    issues.append("公网音频Range请求失败或未配置域名")
        else:
            issues.append("没有可用于播放链路检测的音频")

        for message in recovered + pending + issues:
            log(message)
        write_status("watchdog", "failed" if issues else "pending" if pending else "success", issues=issues, recovered=recovered, pending=pending)
        if issues:
            notify("播客巡检发现问题", "; ".join(issues)[:220])
            return 1
        log("检测通过" if not pending else "仍有任务执行或补跑待验证")
        return 0
    except Exception as exc:
        log(f"巡检失败: {exc}")
        write_status("watchdog", "failed", error=str(exc))
        try:
            notify("播客巡检失败", str(exc)[:220])
        except Exception:
            pass
        return 1
    finally:
        lock.release()


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            stream.reconfigure(encoding="utf-8")
    sys.exit(main())
