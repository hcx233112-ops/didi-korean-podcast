#!/usr/bin/env python3
"""
自动巡检脚本，每小时由 Task Scheduler 调用。
发现问题 → 能修就修，修不了就弹 Windows 系统通知。
"""

import json, sys, subprocess, shutil, time, re
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent.parent
AUDIO_DIR      = ROOT / "audio"
CHANNELS_DIR   = ROOT / "public" / "data" / "videos"
LOG_FILE       = ROOT / "audio-log.txt"
WATCHDOG_LOG   = ROOT / "watchdog-log.txt"
SYNC_SCRIPT    = ROOT / "scripts" / "sync-audio.py"
TASK_NAME      = "DidiPodcast-SyncAudio"

# 超过这么久没运行 sync-audio，视为异常
MAX_SYNC_GAP_HOURS = 5
# 检查最近多少天内发布的视频是否有音频
RECENT_DAYS = 14


# ── 日志 ─────────────────────────────────────────────────────────────────

def log(msg: str, file=WATCHDOG_LOG):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(file, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        # 保持日志不超过 500 行
        lines = Path(file).read_text(encoding="utf-8").splitlines()
        if len(lines) > 500:
            Path(file).write_text("\n".join(lines[-250:]) + "\n", encoding="utf-8")
    except Exception:
        pass


# ── Windows 通知 ──────────────────────────────────────────────────────────

def notify(title: str, body: str):
    """弹出 Windows 系统托盘通知（不需要第三方包）。"""
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(8000, '{title}', '{body}', [System.Windows.Forms.ToolTipIcon]::Warning)
Start-Sleep -Seconds 9
$n.Dispose()
"""
    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except Exception as e:
        log(f"通知发送失败: {e}")


# ── 解析 audio-log.txt ────────────────────────────────────────────────────

def parse_last_sync() -> tuple[datetime | None, bool]:
    """返回 (上次完成时间, 是否有失败)。"""
    if not LOG_FILE.exists():
        return None, False

    lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    last_done_time = None
    had_failure = False

    # 从后往前找最近一次完成记录
    for line in reversed(lines):
        m = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', line)
        if not m:
            continue
        ts = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")

        if "===== 完成 =====" in line and last_done_time is None:
            last_done_time = ts
        if last_done_time and "失败:" in line and "失败: 0" not in line:
            had_failure = True
        if last_done_time and "===== sync-audio 开始 =====" in line:
            break  # 只看最近一次运行

    return last_done_time, had_failure


# ── 检查近期视频音频 ──────────────────────────────────────────────────────

def find_recent_missing() -> list[dict]:
    """返回最近 RECENT_DAYS 天内发布但缺少音频的视频。"""
    cutoff = (datetime.now() - timedelta(days=RECENT_DAYS)).strftime("%Y-%m-%d")
    missing = []
    for f in CHANNELS_DIR.glob("*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        for v in data.get("videos", []):
            if v.get("published", "") >= cutoff:
                p = AUDIO_DIR / f"{v['id']}.m4a"
                if not p.exists() or p.stat().st_size < 50 * 1024:
                    missing.append(v)
    return missing


# ── 检查 Task Scheduler ───────────────────────────────────────────────────

def task_exists() -> bool:
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"(Get-ScheduledTask -TaskName '{TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "True"


def run_sync_now():
    """在后台触发一次 sync-audio.py。"""
    log("触发 sync-audio.py...")
    subprocess.Popen(
        [sys.executable, str(SYNC_SCRIPT)],
        cwd=str(ROOT),
        creationflags=0x08000000,
    )


# ── 主巡检逻辑 ────────────────────────────────────────────────────────────

def main():
    log("===== watchdog 检查 =====")
    issues = []
    fixes  = []

    # 1. 检查 Task Scheduler 任务是否存在
    if not task_exists():
        issues.append("Task Scheduler 任务丢失")
        log("⚠️  Task Scheduler 任务不存在，尝试重新注册...")
        setup_ps1 = ROOT / "scripts" / "setup-scheduler.ps1"
        r = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(setup_ps1)],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            fixes.append("Task Scheduler 任务已重新注册")
            log("✅ 任务重新注册成功")
        else:
            log(f"❌ 重新注册失败（需要管理员权限）: {r.stderr.strip()[:100]}")

    # 2. 检查上次同步时间
    last_sync, had_failure = parse_last_sync()
    now = datetime.now()

    if last_sync is None:
        issues.append("从未运行过 sync-audio")
        log("⚠️  未找到同步记录，立即触发同步")
        run_sync_now()
        fixes.append("已触发首次同步")
    else:
        gap_hours = (now - last_sync).total_seconds() / 3600
        log(f"上次同步: {last_sync.strftime('%Y-%m-%d %H:%M')}（{gap_hours:.1f}h 前），有失败: {had_failure}")

        if gap_hours > MAX_SYNC_GAP_HOURS:
            issues.append(f"同步停滞 {gap_hours:.0f} 小时")
            log(f"⚠️  超过 {MAX_SYNC_GAP_HOURS}h 未同步，立即触发")
            run_sync_now()
            fixes.append("已触发补跑同步")
        elif had_failure:
            issues.append("上次同步有下载失败")
            log("⚠️  上次有失败项，触发重试")
            run_sync_now()
            fixes.append("已触发失败重试")

    # 3. 检查近期视频音频
    time.sleep(3)  # 给 sync 启动一点时间，避免误报
    recent_missing = find_recent_missing()
    if recent_missing:
        names = ", ".join(v["title"][:20] for v in recent_missing[:3])
        log(f"⚠️  {len(recent_missing)} 个近期视频缺少音频: {names}...")
        # sync 已在上面触发，这里只记录
        if not fixes:
            issues.append(f"{len(recent_missing)} 个近期视频无音频")
            run_sync_now()
            fixes.append("已触发补下载")

    # 4. 汇总
    if issues:
        log(f"发现问题: {'; '.join(issues)}")
        if fixes:
            log(f"已自动修复: {'; '.join(fixes)}")
        else:
            msg = "; ".join(issues)
            log(f"⚠️  无法自动修复，发送通知")
            notify("Didi播客 自动化异常", msg)
    else:
        log("✅ 一切正常")

    log("===== 完成 =====\n")


if __name__ == "__main__":
    main()
