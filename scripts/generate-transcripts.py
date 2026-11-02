#!/usr/bin/env python3
"""Generate subtitle files locally; the batch pipeline owns Git writes."""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from automation_common import NO_WINDOW, ProcessLock, atomic_json, read_json, should_generate, utc_now, write_status
from retranslate import translate_all

ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS_DIR = ROOT / "public" / "data" / "transcripts"
CHANNELS_DIR = ROOT / "public" / "data" / "videos"


def load_all_videos():
    videos = {}
    for path in CHANNELS_DIR.glob("*.json"):
        for video in json.loads(path.read_text(encoding="utf-8")).get("videos", []):
            videos[video["id"]] = video
    return list(videos.values())


def fetch_subtitles_ytdlp(video_id):
    # A subprocess can actually be killed; a Future timeout cannot stop its thread.
    with tempfile.TemporaryDirectory(prefix="podcast-subs-") as temporary:
        result = subprocess.run([
            sys.executable, "-m", "yt_dlp", "--skip-download", "--write-subs", "--write-auto-subs",
            "--sub-langs", "ko", "--sub-format", "json3", "--socket-timeout", "20",
            "--retries", "2", "--no-playlist", "--no-warnings", "--quiet",
            "-o", str(Path(temporary) / "%(id)s.%(ext)s"),
            f"https://www.youtube.com/watch?v={video_id}",
        ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, creationflags=NO_WINDOW)
        if result.returncode:
            raise RuntimeError(f"字幕下载失败: {result.stderr[-600:]}")
        files = list(Path(temporary).glob("*.json3"))
        if not files:
            return None
        data = json.loads(files[0].read_text(encoding="utf-8"))
    segments = []
    for event in data.get("events", []):
        text = "".join(s.get("utf8", "") for s in event.get("segs", [])).replace("\n", " ").strip()
        if text:
            start = event.get("tStartMs", 0)
            segments.append({"start_ms": start, "end_ms": start + event.get("dDurationMs", 0), "text": text})
    return segments or None


def generate(video_id, title="", force=False):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Invalid YouTube video ID")
    out = TRANSCRIPTS_DIR / f"{video_id}.json"
    if not should_generate(out, force=force):
        return "skip"
    segments = fetch_subtitles_ytdlp(video_id)
    if segments is None:
        # Never replace previously working subtitles with a transient negative result.
        previous = read_json(out, {})
        if previous.get("segments") and not previous.get("error"):
            raise RuntimeError("本次未找到字幕，保留已有字幕")
        atomic_json(out, {"videoId": video_id, "segments": [], "error": "no_transcript", "checked_at": utc_now()})
        return "no_transcript"
    texts = [s["text"] for s in segments]
    translated = translate_all(texts)
    if len(translated) != len(segments):
        raise RuntimeError("翻译响应数量不一致")
    result = {"videoId": video_id, "segments": [
        {"start": round(s["start_ms"] / 1000, 2), "end": round(s["end_ms"] / 1000, 2), "ko": text, "zh": zh or text}
        for s, text, zh in zip(segments, texts, translated)
    ]}
    atomic_json(out, result)
    return "partial" if any(not text for text in translated) else "ok"


def main(argv=None):
    ids = set(sys.argv[1:] if argv is None else argv)
    lock = ProcessLock(ROOT / "logs" / "transcript-generation-lock.log")
    if not lock.acquire():
        print("已有字幕生成实例运行，本次跳过")
        return 0
    counts = {"ok": 0, "partial": 0, "skip": 0, "no_transcript": 0, "failed": 0}
    try:
        write_status("transcript-generation", "running")
        for video in load_all_videos():
            if ids and video["id"] not in ids:
                continue
            try:
                result = generate(video["id"], video.get("title", ""), force=bool(ids))
                counts[result] += 1
                if result != "skip":
                    print(f"{video['id']}: {result}", flush=True)
            except Exception as exc:
                counts["failed"] += 1
                print(f"{video['id']}: 失败: {exc}", flush=True)
        failed = bool(counts["failed"])
        write_status("transcript-generation", "failed" if failed else "pending" if counts["partial"] else "success", **counts)
        print(json.dumps(counts, ensure_ascii=False), flush=True)
        return 1 if failed else 0
    except Exception as exc:
        write_status("transcript-generation", "failed", error=str(exc))
        print(f"字幕任务失败: {exc}", file=sys.stderr)
        return 1
    finally:
        lock.release()


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            stream.reconfigure(encoding="utf-8")
    sys.exit(main())
