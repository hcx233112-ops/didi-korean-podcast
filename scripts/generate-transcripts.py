#!/usr/bin/env python3
"""
本地运行：python3 scripts/generate-transcripts.py
为所有视频预生成双语字幕（韩语 + 中文），存到 public/data/transcripts/
"""

import json, os, time, sys
from pathlib import Path
from youtube_transcript_api import YouTubeTranscriptApi
from deep_translator import GoogleTranslator

ROOT = Path(__file__).parent.parent
TRANSCRIPTS_DIR = ROOT / "public" / "data" / "transcripts"
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

CHANNELS_DIR = ROOT / "public" / "data" / "videos"

def load_all_videos():
    videos = []
    for f in CHANNELS_DIR.glob("*.json"):
        data = json.loads(f.read_text())
        videos.extend(data.get("videos", []))
    seen = set()
    unique = []
    for v in videos:
        if v["id"] not in seen:
            seen.add(v["id"])
            unique.append(v)
    return unique

def translate_batch(texts, src="ko", tgt="zh-CN", batch_size=80):
    translator = GoogleTranslator(source=src, target=tgt)
    result = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        try:
            translated = translator.translate_batch(batch)
            result.extend(t or b for t, b in zip(translated, batch))
        except Exception as e:
            print(f"    翻译失败: {e}，保留原文")
            result.extend(batch)
        time.sleep(0.5)
    return result

def generate(video_id, title):
    out = TRANSCRIPTS_DIR / f"{video_id}.json"
    if out.exists():
        return "skip"

    api = YouTubeTranscriptApi()
    try:
        transcript_list = api.list(video_id)
        ko = transcript_list.find_transcript(["ko"])
        segments = ko.fetch()
    except Exception as e:
        err_msg = str(e)
        if "No transcripts" in err_msg or "Could not find" in err_msg:
            out.write_text(json.dumps({"videoId": video_id, "segments": [], "error": "no_transcript"}, ensure_ascii=False))
            return "no_transcript"
        raise

    ko_texts = [s.text.replace("\n", " ") for s in segments]
    zh_texts = translate_batch(ko_texts)

    result = {
        "videoId": video_id,
        "segments": [
            {
                "start": round(s.start, 2),
                "end": round(s.start + s.duration, 2),
                "ko": ko,
                "zh": zh,
            }
            for s, ko, zh in zip(segments, ko_texts, zh_texts)
        ],
    }
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return "ok"

def main():
    videos = load_all_videos()
    total = len(videos)
    done = skipped = failed = no_transcript = 0

    # 如果传了参数，只处理指定视频 ID
    filter_ids = set(sys.argv[1:])

    for i, video in enumerate(videos, 1):
        vid = video["id"]
        title = video["title"][:40]

        if filter_ids and vid not in filter_ids:
            continue

        print(f"[{i}/{total}] {vid} {title}")
        try:
            status = generate(vid, title)
            if status == "skip":
                skipped += 1
                print("  → 已存在，跳过")
            elif status == "no_transcript":
                no_transcript += 1
                print("  → 无字幕")
            else:
                done += 1
                print("  → ✅ 完成")
            time.sleep(1.5)
        except Exception as e:
            failed += 1
            print(f"  → ❌ 失败: {e}")
            time.sleep(3)

    print(f"\n完成: {done}  跳过: {skipped}  无字幕: {no_transcript}  失败: {failed}")

if __name__ == "__main__":
    main()
