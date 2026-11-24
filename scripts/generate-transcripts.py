#!/usr/bin/env python3
"""Generate subtitle files locally; the batch pipeline owns Git writes."""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from automation_common import NO_WINDOW, ProcessLock, atomic_json, read_json, should_generate, utc_now, write_status
from retranslate import translate_all

ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS_DIR = ROOT / "public" / "data" / "transcripts"
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
CHANNELS_FILE = ROOT / "data" / "channels.json"
# Preferred tracks first: a creator's own captions beat the auto-generated ones.
# The batch commits only after generation; stopping early keeps it inside the task's time limit.
TIME_BUDGET_SECONDS = 100 * 60
SUB_LANGS = {"ko": ["ko"], "en": ["en-GB", "en-US", "en"]}


def channel_languages():
    return {c["id"]: c.get("lang", "ko") for c in read_json(CHANNELS_FILE, [])}


def load_all_videos():
    languages = channel_languages()
    videos = {}
    for path in CHANNELS_DIR.glob("*.json"):
        for video in json.loads(path.read_text(encoding="utf-8")).get("videos", []):
            videos[video["id"]] = {**video, "lang": languages.get(path.stem, "ko")}
    return list(videos.values())


def merge_sentences(segments, max_ms=15000, max_chars=180):
    """Auto captions arrive as screen lines; translate whole sentences instead of fragments."""
    merged = []
    for segment in segments:
        last = merged[-1] if merged else None
        open_sentence = last and not re.search(r"[.?!…]['\"”)]?$", last["text"])
        if open_sentence and segment["end_ms"] - last["start_ms"] <= max_ms and len(last["text"]) + len(segment["text"]) < max_chars:
            last["text"] += " " + segment["text"]
            last["end_ms"] = max(last["end_ms"], segment["end_ms"])
        else:
            merged.append(dict(segment))
    return merged


def fetch_subtitles_ytdlp(video_id, lang="ko"):
    # A subprocess can actually be killed; a Future timeout cannot stop its thread.
    with tempfile.TemporaryDirectory(prefix="podcast-subs-") as temporary:
        result = subprocess.run([
            sys.executable, "-m", "yt_dlp", "--skip-download", "--write-subs", "--write-auto-subs",
            "--sub-langs", ",".join(SUB_LANGS.get(lang, [lang])), "--sub-format", "json3", "--socket-timeout", "20",
            "--retries", "2", "--no-playlist", "--no-warnings", "--quiet",
            "-o", str(Path(temporary) / "%(id)s.%(ext)s"),
            f"https://www.youtube.com/watch?v={video_id}",
        ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, creationflags=NO_WINDOW)
        if result.returncode:
            raise RuntimeError(f"字幕下载失败: {result.stderr[-600:]}")
        files = {path.suffixes[-2].lstrip("."): path for path in Path(temporary).glob("*.json3") if len(path.suffixes) >= 2}
        chosen = next((files[code] for code in SUB_LANGS.get(lang, [lang]) if code in files), next(iter(files.values()), None))
        if not chosen:
            return None
        data = json.loads(chosen.read_text(encoding="utf-8"))
    segments = []
    for event in data.get("events", []):
        text = "".join(s.get("utf8", "") for s in event.get("segs", [])).replace("\n", " ").strip()
        if text:
            start = event.get("tStartMs", 0)
            segments.append({"start_ms": start, "end_ms": start + event.get("dDurationMs", 0), "text": text})
    if lang != "ko":
        segments = merge_sentences(segments)
    return segments or None


def generate(video_id, title="", force=False, lang="ko"):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Invalid YouTube video ID")
    out = TRANSCRIPTS_DIR / f"{video_id}.json"
    if not should_generate(out, force=force):
        return "skip"
    segments = fetch_subtitles_ytdlp(video_id, lang)
    if segments is None:
        # Never replace previously working subtitles with a transient negative result.
        previous = read_json(out, {})
        if previous.get("segments") and not previous.get("error"):
            raise RuntimeError("本次未找到字幕，保留已有字幕")
        atomic_json(out, {"videoId": video_id, "segments": [], "error": "no_transcript", "checked_at": utc_now()})
        return "no_transcript"
    texts = [s["text"] for s in segments]
    translated = translate_all(texts, lang)
    if len(translated) != len(segments):
        raise RuntimeError("翻译响应数量不一致")
    # "ko" holds the original-language line for every channel; "lang" names that language.
    result = {"videoId": video_id, "lang": lang, "segments": [
        {"start": round(s["start_ms"] / 1000, 2), "end": round(s["end_ms"] / 1000, 2), "ko": text, "zh": zh or text}
        for s, text, zh in zip(segments, texts, translated)
    ]}
    atomic_json(out, result)
    return "partial" if any(not text for text in translated) else "ok"


def main(argv=None, clock=time.monotonic):
    ids = set(sys.argv[1:] if argv is None else argv)
    lock = ProcessLock(ROOT / "logs" / "transcript-generation-lock.log")
    if not lock.acquire():
        print("已有字幕生成实例运行，本次跳过")
        return 0
    counts = {"ok": 0, "partial": 0, "skip": 0, "no_transcript": 0, "failed": 0, "deferred": 0}
    deadline = clock() + TIME_BUDGET_SECONDS
    try:
        write_status("transcript-generation", "running")
        for video in load_all_videos():
            if ids and video["id"] not in ids:
                continue
            if clock() > deadline:
                counts["deferred"] += 1
                continue
            try:
                result = generate(video["id"], video.get("title", ""), force=bool(ids), lang=video.get("lang", "ko"))
                counts[result] += 1
                if result != "skip":
                    print(f"{video['id']}: {result}", flush=True)
            except Exception as exc:
                counts["failed"] += 1
                print(f"{video['id']}: 失败: {exc}", flush=True)
        failed = bool(counts["failed"])
        if counts["deferred"]:
            print(f"时间预算用完，{counts['deferred']} 个视频留到下次处理", flush=True)
        write_status("transcript-generation", "failed" if failed else "pending" if counts["partial"] or counts["deferred"] else "success", **counts)
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
