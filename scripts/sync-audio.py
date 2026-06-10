#!/usr/bin/env python3
"""
本地自动同步脚本：git pull → 检测新视频 → 下载音频
由 Windows 任务计划程序定期调用（见 scripts/setup-scheduler.ps1）
日志写入项目根的 audio-log.txt
"""

import json, sys, shutil, subprocess, time
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent.parent
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
AUDIO_DIR = ROOT / "audio"
LOG_FILE = ROOT / "audio-log.txt"
LOG_MAX_LINES = 1000  # 超出时截断旧记录
MIN_AUDIO_BYTES = 50 * 1024  # 小于 50KB 视为损坏文件

AUDIO_DIR.mkdir(parents=True, exist_ok=True)


# ── 工具路径（Task Scheduler PATH 可能残缺，优先找绝对路径）──────────────

def find_exe(name: str) -> str:
    """在 PATH 和常见安装位置查找可执行文件，返回完整路径或原名。"""
    found = shutil.which(name)
    if found:
        return found
    fallbacks = {
        "git": [
            r"C:\Program Files\Git\bin\git.exe",
            r"C:\Program Files (x86)\Git\bin\git.exe",
        ],
        "ffmpeg": [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        ],
        "python": [
            sys.executable,  # 当前 python 自身
        ],
    }
    for path in fallbacks.get(name, []):
        if Path(path).exists():
            return path
    return name  # 保底返回原名，让系统报错


GIT = find_exe("git")
FFMPEG = find_exe("ffmpeg")


# ── 日志 ─────────────────────────────────────────────────────────────────

def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def rotate_log():
    """日志超过 LOG_MAX_LINES 行时保留最后一半。"""
    if not LOG_FILE.exists():
        return
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
        if len(lines) > LOG_MAX_LINES:
            keep = lines[-(LOG_MAX_LINES // 2):]
            LOG_FILE.write_text("\n".join(keep) + "\n", encoding="utf-8")
    except Exception:
        pass


# ── Git ───────────────────────────────────────────────────────────────────

def git_pull() -> bool:
    log(f"git pull... (git={GIT})")
    r = subprocess.run(
        [GIT, "pull", "--no-edit"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if r.returncode != 0:
        log(f"git pull 失败: {r.stderr.strip()}")
        return False
    changed = "Already up to date." not in r.stdout
    log(f"git pull 完成{'（有更新）' if changed else '（已是最新）'}")
    return changed


# ── 视频列表 ──────────────────────────────────────────────────────────────

def load_all_videos():
    videos = []
    for f in CHANNELS_DIR.glob("*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        videos.extend(data.get("videos", []))
    seen, unique = set(), []
    for v in videos:
        if v["id"] not in seen:
            seen.add(v["id"])
            unique.append(v)
    return unique


def is_audio_valid(path: Path) -> bool:
    """文件存在且大小正常（排除空文件/损坏文件）。"""
    return path.exists() and path.stat().st_size >= MIN_AUDIO_BYTES


def find_missing(videos):
    missing = []
    for v in videos:
        p = AUDIO_DIR / f"{v['id']}.m4a"
        if not is_audio_valid(p):
            if p.exists():
                log(f"  ⚠️  {v['id']}.m4a 文件过小（{p.stat().st_size}B），视为损坏，重新下载")
                p.unlink()
            missing.append(v)
    return missing


# ── 下载 ──────────────────────────────────────────────────────────────────

def download(video_id: str) -> str:
    import yt_dlp
    out = AUDIO_DIR / f"{video_id}.m4a"

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO_DIR / "%(id)s.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        "postprocessor_args": {"ffmpeg": [
            "-b:a", "64k", "-ac", "1", "-movflags", "+faststart",
        ]},
        "ffmpeg_location": str(Path(FFMPEG).parent) if Path(FFMPEG).exists() else None,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "sleep_interval": 3,
    }
    # 移除 None 值，避免 yt-dlp 报错
    ydl_opts = {k: v for k, v in ydl_opts.items() if v is not None}

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])

    if is_audio_valid(out):
        return "ok"
    if out.exists():
        out.unlink()  # 删除损坏文件，下次重试
        return "fail"
    return "fail"


# ── 主流程 ────────────────────────────────────────────────────────────────

def check_deps():
    errors = []
    if not Path(FFMPEG).exists() and not shutil.which("ffmpeg"):
        errors.append("ffmpeg 未找到，请运行：winget install Gyan.FFmpeg")
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        errors.append("yt-dlp 未安装，请运行：pip install yt-dlp")
    if errors:
        for e in errors:
            log(f"❌ {e}")
        sys.exit(1)


def update_ytdlp():
    """每周自动更新一次 yt-dlp，避免 YouTube 接口变更导致下载失败。"""
    marker = ROOT / ".yt-dlp-updated"
    try:
        if marker.exists():
            age_days = (datetime.now().timestamp() - marker.stat().st_mtime) / 86400
            if age_days < 7:
                return
        log("更新 yt-dlp...")
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp", "-q"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode == 0:
            marker.touch()
            log("yt-dlp 已更新")
        else:
            log(f"yt-dlp 更新失败（非致命）: {r.stderr.strip()[:100]}")
    except Exception as e:
        log(f"yt-dlp 更新跳过: {e}")


def main():
    rotate_log()
    log("===== sync-audio 开始 =====")
    log(f"python={sys.executable}  git={GIT}  ffmpeg={FFMPEG}")

    check_deps()
    update_ytdlp()
    git_pull()

    videos = load_all_videos()
    missing = find_missing(videos)

    if not missing:
        log(f"音频已全部就绪（共 {len(videos)} 个视频），无需下载")
        log("===== 完成 =====\n")
        return

    log(f"发现 {len(missing)} 个新视频需要下载音频：")
    for v in missing:
        log(f"  · {v['id']} {v['title'][:50]}")

    done = failed = skipped_live = 0
    for i, v in enumerate(missing, 1):
        log(f"[{i}/{len(missing)}] 下载 {v['id']} {v['title'][:40]}")
        try:
            status = download(v["id"])
            if status == "ok":
                size_kb = (AUDIO_DIR / f"{v['id']}.m4a").stat().st_size // 1024
                log(f"  ✅ {size_kb} KB")
                done += 1
            else:
                log("  ❌ 文件未生成或过小，下次重试")
                failed += 1
        except Exception as e:
            err = str(e)
            if "live event will begin" in err or "This live event" in err:
                log("  ⏳ 直播未开始，下次自动重试")
                skipped_live += 1
            elif "Premieres in" in err or "premiere" in err.lower():
                log("  ⏳ 首映未开始，下次自动重试")
                skipped_live += 1
            elif "403" in err or "Forbidden" in err:
                log(f"  ⚠️  403 限速，稍后重试: {err[:80]}")
                failed += 1
                time.sleep(10)
            else:
                log(f"  ❌ 失败: {err[:120]}")
                failed += 1
        time.sleep(2)

    total_audio = len(list(AUDIO_DIR.glob("*.m4a")))
    log(f"下载完成: {done}  失败: {failed}  待开播: {skipped_live}  音频总数: {total_audio}")
    log("===== 完成 =====\n")


if __name__ == "__main__":
    main()
