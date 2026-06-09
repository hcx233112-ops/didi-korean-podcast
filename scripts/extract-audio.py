#!/usr/bin/env python3
"""
本地运行：python3 scripts/extract-audio.py
把所有视频的音频提取成 64k 单声道 m4a，存到项目根的 audio/ 目录，
供网站用原生 <audio> 在 iOS 锁屏后台播放。增量执行：已提取的自动跳过。
需要 ffmpeg 在 PATH 中（Windows: winget install Gyan.FFmpeg）。
"""

import json, sys, shutil
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
from pathlib import Path
import yt_dlp

ROOT = Path(__file__).parent.parent
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
AUDIO_DIR = ROOT / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)


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


def extract(video_id):
    out = AUDIO_DIR / f"{video_id}.m4a"
    if out.exists():
        return "skip"
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO_DIR / "%(id)s.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        "postprocessor_args": {"ffmpeg": ["-b:a", "64k", "-ac", "1", "-movflags", "+faststart"]},
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    return "ok" if out.exists() else "fail"


def main():
    if not shutil.which("ffmpeg"):
        sys.exit("❌ 找不到 ffmpeg。Windows 请先运行：winget install Gyan.FFmpeg 然后重开终端")

    videos = load_all_videos()
    total = len(videos)
    print(f"共 {total} 个视频，输出目录：{AUDIO_DIR}")

    done = skipped = failed = 0
    for i, video in enumerate(videos, 1):
        vid = video["id"]
        title = video["title"][:40]
        if (AUDIO_DIR / f"{vid}.m4a").exists():
            skipped += 1
            continue
        print(f"[{i}/{total}] {vid} {title}")
        try:
            status = extract(vid)
            if status == "ok":
                done += 1
                size_kb = (AUDIO_DIR / f"{vid}.m4a").stat().st_size // 1024
                print(f"  → ✅ {size_kb} KB")
            else:
                failed += 1
                print("  → ❌ 未生成文件")
        except Exception as e:
            failed += 1
            print(f"  → ❌ 失败: {e}")

    n = len(list(AUDIO_DIR.glob("*.m4a")))
    print(f"\n完成: {done}  跳过: {skipped}  失败: {failed}  当前音频总数: {n}")


if __name__ == "__main__":
    main()
