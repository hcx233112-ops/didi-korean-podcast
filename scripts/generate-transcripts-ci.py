#!/usr/bin/env python3
import json, time, sys, concurrent.futures
from pathlib import Path
from youtube_transcript_api import YouTubeTranscriptApi
from deep_translator import GoogleTranslator

TRANSCRIPTS_DIR = Path("public/data/transcripts")
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

_translation_disabled = False


def run_with_timeout(fn, timeout):
    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = ex.submit(fn)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        ex.shutdown(wait=False, cancel_futures=True)
        raise Exception(f"超时（>{timeout}s）")
    finally:
        ex.shutdown(wait=False)


def translate_batch(texts, batch_size=80):
    global _translation_disabled
    if _translation_disabled:
        return list(texts)
    result = []
    consec_fail = 0
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        translated = None
        for attempt in range(2):
            try:
                translator = GoogleTranslator(source="ko", target="zh-CN")
                translated = run_with_timeout(lambda: translator.translate_batch(batch), 20)
                consec_fail = 0
                break
            except Exception as e:
                print(f"    翻译第 {attempt+1} 次失败: {e}")
                time.sleep(3)
        if translated:
            result.extend(t or b for t, b in zip(translated, batch))
        else:
            consec_fail += 1
            result.extend(batch)
            if consec_fail >= 2:
                print("    翻译连续失败，本次运行跳过翻译")
                _translation_disabled = True
                result.extend(texts[i + batch_size :])
                break
        time.sleep(0.5)
    return result


def load_all_videos():
    videos = []
    for f in Path("public/data/videos").glob("*.json"):
        data = json.loads(f.read_text())
        videos.extend(data.get("videos", []))
    seen = set()
    unique = []
    for v in videos:
        if v["id"] not in seen:
            seen.add(v["id"])
            unique.append(v)
    return unique


def main():
    videos = load_all_videos()
    total = len(videos)
    api = YouTubeTranscriptApi()
    done = skipped = failed = no_transcript = 0

    for i, video in enumerate(videos, 1):
        vid = video["id"]
        title = video["title"][:40]
        out = TRANSCRIPTS_DIR / f"{vid}.json"

        if out.exists():
            skipped += 1
            continue

        print(f"[{i}/{total}] {vid} {title}")

        try:
            transcript_list = run_with_timeout(lambda: api.list(vid), 20)
            ko = transcript_list.find_transcript(["ko"])
            segments = run_with_timeout(ko.fetch, 20)

            ko_texts = [s.text.replace("\n", " ") for s in segments]
            zh_texts = translate_batch(ko_texts)

            result = {
                "videoId": vid,
                "segments": [
                    {"start": round(s.start, 2), "end": round(s.start + s.duration, 2), "ko": k, "zh": z}
                    for s, k, z in zip(segments, ko_texts, zh_texts)
                ],
            }
            out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
            print(f"  ✅ {len(segments)} 段")
            done += 1
            time.sleep(2)

        except Exception as e:
            err = str(e)
            if "No transcripts" in err or "Could not find" in err or "NoTranscriptFound" in err or "TranscriptsDisabled" in err:
                out.write_text(json.dumps({"videoId": vid, "segments": [], "error": "no_transcript"}, ensure_ascii=False))
                print(f"  ⚠️  无字幕")
                no_transcript += 1
                time.sleep(1)
            elif "IpBlocked" in err or "blocked" in err.lower():
                print(f"  ❌ IP 被封，停止运行")
                print(f"\n完成: {done}  跳过: {skipped}  无字幕: {no_transcript}  失败: {failed}")
                sys.exit(1)
            else:
                print(f"  ❌ {err[:100]}")
                failed += 1
                time.sleep(3)

    print(f"\n完成: {done}  跳过: {skipped}  无字幕: {no_transcript}  失败: {failed}")


if __name__ == "__main__":
    main()
