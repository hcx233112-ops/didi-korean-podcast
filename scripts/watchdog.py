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

ROOT         = ROOT = Path(__file__).parent.parent
AUDIO_DIR    = ROOT / "audio"
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
LOG_FILE     = ROOT / "audio-log.txt"
WATCHDOG_LOG = ROOT / "watchdog-log.txt"
SYNC_SCRIPT  = ROOT / "scripts" / "sync-audio.py"
TASK_NAME    = "DidiPodcast-SyncAudio"

MAX_SYNC_GAP_HOURS  = 5   # 超过多久没同步视为异常
MIN_SYNC_GAP_HOURS  = 1   # 距上次同步不足此时间则不重复触发
RECENT_DAYS         = 14  # 检查最近多少天的视频
MIN_AUDIO_BYTES     = 50 * 1024


# ── 日志（轮转只在启动时做一次）─────────────────────────────────────────

def _rotate(file: Path, max_lines=500):
    if not file.exists():
        return
    try:
        lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) > max_lines:
            file.write_text("\n".join(lines[-(max_lines // 2):]) + "\n", encoding="utf-8")
    except Exception:
        pass


def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(WATCHDOG_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ── Windows 通知 ──────────────────────────────────────────────────────────

def notify(title: str, body: str):
    # 转义单引号，避免 PowerShell 字符串被截断
    t = title.replace("'", "''")
    b = body.replace("'", "''")
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.Visible = $true
$n.ShowBalloonTip(8000, '{t}', '{b}', [System.Windows.Forms.ToolTipIcon]::Warning)
Start-Sleep -Seconds 9
$n.Dispose()
"""
    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
            creationflags=0x08000000,
        )
    except Exception as e:
        log(f"通知发送失败: {e}")


# ── 解析 audio-log.txt ────────────────────────────────────────────────────

def parse_last_sync() -> tuple[datetime | None, bool]:
    """返回 (上次完成时间, 上次是否有下载失败)。"""
    if not LOG_FILE.exists():
        return None, False

    lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    last_done_time = None
    had_failure    = False

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
            break

    return last_done_time, had_failure


# ── 检查近期视频音频 ──────────────────────────────────────────────────────

def find_recent_missing() -> list[dict]:
    cutoff = (datetime.now() - timedelta(days=RECENT_DAYS)).strftime("%Y-%m-%d")
    missing = []
    for f in CHANNELS_DIR.glob("*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        for v in data.get("videos", []):
            if v.get("published", "") >= cutoff:
                p = AUDIO_DIR / f"{v['id']}.m4a"
                if not p.exists() or p.stat().st_size < MIN_AUDIO_BYTES:
                    missing.append(v)
    return missing


# ── Task Scheduler ────────────────────────────────────────────────────────

def task_exists(name: str) -> bool:
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"(Get-ScheduledTask -TaskName '{name}' -ErrorAction SilentlyContinue) -ne $null"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "True"


def try_reregister_tasks():
    setup_ps1 = ROOT / "scripts" / "setup-scheduler.ps1"
    r = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(setup_ps1)],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        log("✅ 任务重新注册成功")
        return True
    log(f"❌ 重新注册失败（需要管理员权限）: {r.stderr.strip()[:100]}")
    return False


# ── 触发同步 ──────────────────────────────────────────────────────────────

def run_sync_now():
    log("触发 sync-audio.py...")
    subprocess.Popen(
        [sys.executable, str(SYNC_SCRIPT)],
        cwd=str(ROOT),
        creationflags=0x08000000,
    )


# ── 主巡检逻辑 ────────────────────────────────────────────────────────────

def main():
    _rotate(WATCHDOG_LOG)
    log("===== watchdog 检查 =====")

    issues = []
    fixes  = []
    sync_triggered = False

    # 1. Task Scheduler 任务检查
    for name in [TASK_NAME, "DidiPodcast-Watchdog"]:
        if not task_exists(name):
            issues.append(f"任务丢失: {name}")
            log(f"⚠️  {name} 不存在，尝试重新注册...")
            if try_reregister_tasks():
                fixes.append("任务已重新注册")
            break  # 两个任务用同一个 setup 脚本，注册一次即可

    # 2. 上次同步时间检查
    last_sync, had_failure = parse_last_sync()
    now = datetime.now()

    if last_sync is None:
        issues.append("从未运行过 sync-audio")
        log("⚠️  未找到同步记录，立即触发")
        run_sync_now()
        fixes.append("已触发首次同步")
        sync_triggered = True
    else:
        gap_hours = (now - last_sync).total_seconds() / 3600
        log(f"上次同步: {last_sync.strftime('%Y-%m-%d %H:%M')}（{gap_hours:.1f}h 前），有下载失败: {had_failure}")

        if gap_hours > MAX_SYNC_GAP_HOURS:
            issues.append(f"同步停滞 {gap_hours:.0f} 小时")
            log(f"⚠️  超过 {MAX_SYNC_GAP_HOURS}h 未同步，立即触发")
            run_sync_now()
            fixes.append("已触发补跑同步")
            sync_triggered = True
        elif had_failure and gap_hours > MIN_SYNC_GAP_HOURS:
            issues.append("上次同步有下载失败")
            log("⚠️  上次有失败，触发重试")
            run_sync_now()
            fixes.append("已触发失败重试")
            sync_triggered = True

    # 3. 近期音频缺失检查
    # 只在上次同步超过 1h 且本次未触发过时才检查，避免直播/首映反复触发
    if not sync_triggered and last_sync is not None:
        gap_hours = (now - last_sync).total_seconds() / 3600
        if gap_hours > MIN_SYNC_GAP_HOURS:
            missing = find_recent_missing()
            if missing:
                names = "、".join(v["title"][:15] for v in missing[:3])
                log(f"⚠️  {len(missing)} 个近期视频缺少音频: {names}")
                issues.append(f"{len(missing)} 个近期视频无音频")
                run_sync_now()
                fixes.append("已触发补下载")
                sync_triggered = True

    # 4. 汇总
    if issues:
        log(f"问题: {'; '.join(issues)}")
        if fixes:
            log(f"已处理: {'; '.join(fixes)}")
        else:
            log("⚠️  无法自动修复，发送通知")
            notify("Didi播客 自动化异常", "; ".join(issues))
    else:
        log("✅ 一切正常")

    log("===== 完成 =====\n")


if __name__ == "__main__":
    main()
