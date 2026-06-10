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

AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def git_pull() -> bool:
    log("git pull...")
    r = subprocess.run(
        ["git", "pull", "--no-edit"],
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


def find_missing(videos):
    return [v for v in videos if not (AUDIO_DIR / f"{v['id']}.m4a").exists()]


def download(video_id: str) -> str:
    import yt_dlp
    out = AUDIO_DIR / f"{video_id}.m4a"
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO_DIR / "%(id)s.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        "postprocessor_args": {"ffmpeg": ["-b:a", "64k", "-ac", "1", "-movflags", "+faststart"]},
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "sleep_interval": 3,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    return "ok" if out.exists() else "fail"


def main():
    log("===== sync-audio 开始 =====")

    if not shutil.which("ffmpeg"):
        log("❌ 找不到 ffmpeg，请先运行：winget install Gyan.FFmpeg")
        sys.exit(1)

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
                log("  ❌ 下载完成但文件不存在")
                failed += 1
        except Exception as e:
            err = str(e)
            if "live event will begin" in err or "This live event" in err:
                log(f"  ⏳ 直播未开始，下次自动重试")
                skipped_live += 1
            elif "Premieres in" in err or "premiere" in err.lower():
                log(f"  ⏳ 首映未开始，下次自动重试")
                skipped_live += 1
            else:
                log(f"  ❌ 失败: {err[:120]}")
                failed += 1
        time.sleep(2)

    total_audio = len(list(AUDIO_DIR.glob("*.m4a")))
    log(f"下载完成: {done}  失败: {failed}  待开播: {skipped_live}  音频总数: {total_audio}")
    log("===== 完成 =====\n")


if __name__ == "__main__":
    main()
