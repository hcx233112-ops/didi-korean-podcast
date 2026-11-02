#!/usr/bin/env python3
"""
本地自动同步脚本：git pull → 检测新视频 → 下载音频
由 Windows 任务计划程序定期调用（见 scripts/setup-scheduler.ps1）
日志写入项目根的 audio-log.txt
"""

import json, sys, shutil, subprocess, time, os, tempfile
from datetime import datetime
from pathlib import Path
from automation_common import ProcessLock, write_status
from audio_validation import AudioValidator

# pythonw 无控制台环境下 stdout/stderr 为 None，先容错再 reconfigure
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT         = Path(__file__).parent.parent
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
AUDIO_DIR    = ROOT / "audio"
STAGING_DIR  = ROOT / ".media-repair"
LOG_FILE     = ROOT / "audio-log.txt"
LOCK_FILE    = ROOT / "logs" / "sync-lock.log"

NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW：子进程不弹控制台窗口

LOG_MAX_LINES  = 1000
MIN_AUDIO_BYTES = 50 * 1024  # < 50KB 视为损坏

AUDIO_DIR.mkdir(parents=True, exist_ok=True)


# ── 工具路径 ──────────────────────────────────────────────────────────────

def find_exe(name: str) -> str:
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
    }
    for path in fallbacks.get(name, []):
        if Path(path).exists():
            return path
    return name


GIT    = find_exe("git")
FFMPEG = find_exe("ffmpeg")
FFPROBE = shutil.which("ffprobe") or str(Path(FFMPEG).with_name("ffprobe.exe"))
VALIDATOR = AudioValidator(ROOT / "logs" / "audio-validation.log", FFPROBE)
_lock = ProcessLock(LOCK_FILE)


# ── 锁文件（防止重复运行）────────────────────────────────────────────────

def acquire_lock() -> bool:
    return _lock.acquire()


def release_lock():
    _lock.release()


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
    if not LOG_FILE.exists():
        return
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) > LOG_MAX_LINES:
            LOG_FILE.write_text("\n".join(lines[-(LOG_MAX_LINES // 2):]) + "\n", encoding="utf-8")
    except Exception:
        pass


# ── Git ───────────────────────────────────────────────────────────────────

def git_pull():
    repo_lock = ProcessLock(ROOT / "logs" / "repository-lock.log")
    if not repo_lock.acquire():
        raise RuntimeError("字幕任务正在使用仓库，稍后重试同步")
    try:
        _git_pull_unlocked()
    finally:
        repo_lock.release()


def _git_pull_unlocked():
    log(f"git pull... (git={GIT})")
    r = subprocess.run(
        [GIT, "pull", "--no-edit"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=NO_WINDOW,
        timeout=120,
    )
    if r.returncode != 0:
        raise RuntimeError(f"git pull 失败: {r.stderr.strip()}")
    changed = "Already up to date." not in r.stdout
    log(f"git pull 完成{'（有更新）' if changed else '（已是最新）'}")


# ── 视频与音频 ────────────────────────────────────────────────────────────

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


def is_valid(path: Path, expected_duration=0) -> bool:
    return VALIDATOR.valid(path, expected_duration)


def find_missing(videos):
    missing = []
    for v in videos:
        p = AUDIO_DIR / f"{v['id']}.m4a"
        if not is_valid(p, v.get("duration", 0)):
            if p.exists():
                log(f"  ⚠️  {v['id']}.m4a 校验失败，保留旧文件直到新文件就绪")
            missing.append(v)
    VALIDATOR.save()
    return missing


# ── 下载 ──────────────────────────────────────────────────────────────────

def download(video_id: str, expected_duration=0) -> str:
    import yt_dlp
    out = AUDIO_DIR / f"{video_id}.m4a"

    ffmpeg_dir = str(Path(FFMPEG).parent) if Path(FFMPEG).exists() else None
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="download-", dir=STAGING_DIR) as staging:
        ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(Path(staging) / "%(id)s.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        "postprocessor_args": {"ffmpeg": ["-b:a", "64k", "-ac", "1", "-movflags", "+faststart"]},
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "sleep_interval": 3,
        **({"ffmpeg_location": ffmpeg_dir} if ffmpeg_dir else {}),
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            result = ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        candidate = Path(staging) / f"{video_id}.m4a"
        # A temporary validator prevents stale staging entries growing the persistent cache.
        validator = AudioValidator(ROOT / "logs" / "unused-validation.log", FFPROBE)
        if result or not validator.valid(candidate, expected_duration):
            return "fail"
        os.replace(candidate, out)
        return "ok"


# ── 依赖检查 / yt-dlp 更新 ────────────────────────────────────────────────

def check_deps():
    errors = []
    if not Path(FFMPEG).exists() and not shutil.which("ffmpeg"):
        errors.append("ffmpeg 未找到，请运行：winget install Gyan.FFmpeg")
    if not Path(FFPROBE).exists() and not shutil.which(FFPROBE):
        errors.append("ffprobe 未找到，请安装完整 ffmpeg")
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        errors.append("yt-dlp 未安装，请运行：pip install yt-dlp")
    if errors:
        for e in errors:
            log(f"❌ {e}")
        sys.exit(1)


# ── 主流程 ────────────────────────────────────────────────────────────────

def main():
    rotate_log()
    log("===== sync-audio 开始 =====")
    log(f"python={sys.executable}  git={GIT}  ffmpeg={FFMPEG}")

    if not acquire_lock():
        log("已有实例在运行，退出")
        return 0

    try:
        write_status("audio", "running", started_at=datetime.now().astimezone().isoformat())
        check_deps()
        git_pull()

        videos  = load_all_videos()
        missing = find_missing(videos)

        if not missing:
            log(f"音频已全部就绪（共 {len(videos)} 个视频），无需下载")
            log("===== 完成 =====\n")
            write_status("audio", "success", videos=len(videos), failed=0)
            return 0

        log(f"发现 {len(missing)} 个新视频需要下载音频：")
        for v in missing:
            log(f"  · {v['id']} {v['title'][:50]}")

        done = failed = skipped_live = 0
        for i, v in enumerate(missing, 1):
            log(f"[{i}/{len(missing)}] 下载 {v['id']} {v['title'][:40]}")
            try:
                status = download(v["id"], v.get("duration", 0))
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
                    log(f"  ⚠️  403 限速: {err[:80]}")
                    failed += 1
                    time.sleep(10)
                else:
                    log(f"  ❌ 失败: {err[:120]}")
                    failed += 1
            time.sleep(2)

        total = len(list(AUDIO_DIR.glob("*.m4a")))
        log(f"下载完成: {done}  失败: {failed}  待开播: {skipped_live}  音频总数: {total}")
        write_status("audio", "failed" if failed else "pending" if skipped_live else "success", downloaded=done, failed=failed, pending=skipped_live)
        if not failed and not skipped_live:
            log("===== 完成 =====\n")
        return 1 if failed else 0
    except (Exception, SystemExit) as exc:
        log(f"❌ 同步失败: {exc}")
        write_status("audio", "failed", error=str(exc))
        return 1
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
