#!/usr/bin/env python3
"""
本地运行：python3 scripts/generate-transcripts.py
为所有视频预生成双语字幕（韩语 + 中文），存到 public/data/transcripts/
push 后自动删除本地 JSON，用 .done 记录已处理的视频 ID
"""

import json, os, time, sys, subprocess, concurrent.futures
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
from pathlib import Path
from youtube_transcript_api import YouTubeTranscriptApi
from deep_translator import GoogleTranslator

ROOT = Path(__file__).parent.parent
TRANSCRIPTS_DIR = ROOT / "public" / "data" / "transcripts"
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
CHANNELS_DIR = ROOT / "public" / "data" / "videos"
DONE_FILE = TRANSCRIPTS_DIR / ".done"

AUTO_PUSH_EVERY = 20
_translation_disabled = False  # 连续失败后自动禁用翻译


def load_done() -> set:
    if DONE_FILE.exists():
        return set(DONE_FILE.read_text(encoding="utf-8").splitlines())
    return set()


def save_done(done_ids: set):
    DONE_FILE.write_text("\n".join(sorted(done_ids)), encoding="utf-8")


def load_all_videos():
    videos = []
    for f in CHANNELS_DIR.glob("*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        videos.extend(data.get("videos", []))
    seen = set()
    unique = []
    for v in videos:
        if v["id"] not in seen:
            seen.add(v["id"])
            unique.append(v)
    return unique


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


def translate_batch(texts, src="ko", tgt="zh-CN", batch_size=80):
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
                translator = GoogleTranslator(source=src, target=tgt)
                translated = run_with_timeout(lambda: translator.translate_batch(batch), 15)
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
                result.extend(texts[i + batch_size:])
                break
        time.sleep(0.5)
    return result


def generate(video_id, title):
    out = TRANSCRIPTS_DIR / f"{video_id}.json"
    if out.exists():
        return "skip"

    api = YouTubeTranscriptApi()
    try:
        transcript_list = run_with_timeout(lambda: api.list(video_id), 20)
        ko = transcript_list.find_transcript(["ko"])
        segments = run_with_timeout(ko.fetch, 20)
    except Exception as e:
        err_msg = str(e)
        if "No transcripts" in err_msg or "Could not find" in err_msg:
            out.write_text(json.dumps({"videoId": video_id, "segments": [], "error": "no_transcript"}, ensure_ascii=False), encoding="utf-8")
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
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return "ok"


def git_push_and_clean(done_ids: set):
    print("\n📤 自动推送到 GitHub...")
    save_done(done_ids)
    subprocess.run(["git", "add", "public/data/transcripts/"], cwd=str(ROOT))
    result = subprocess.run(["git", "diff", "--staged", "--quiet"], cwd=str(ROOT))
    if result.returncode == 0:
        print("  没有新文件，跳过 push")
        return
    subprocess.run(["git", "commit", "-m", "chore: add transcripts (auto)"], cwd=str(ROOT))
    # pull rebase 后再 push，避免远端有新提交时被拒绝
    subprocess.run(["git", "pull", "--rebase", "origin", "main"], cwd=str(ROOT))
    push_result = subprocess.run(["git", "push"], cwd=str(ROOT))
    if push_result.returncode != 0:
        print("  ⚠️ Push 失败，跳过本地清理")
        return
    for f in TRANSCRIPTS_DIR.glob("*.json"):
        f.unlink()
    print(f"  ✅ Push 完成，本地 JSON 已清理\n")


def main():
    videos = load_all_videos()
    total = len(videos)
    done_ids = load_done()
    done = skipped = failed = no_transcript = 0
    new_since_push = 0

    filter_ids = set(sys.argv[1:])

    for i, video in enumerate(videos, 1):
        vid = video["id"]
        title = video["title"][:40]

        if filter_ids and vid not in filter_ids:
            continue

        if vid in done_ids:
            skipped += 1
            continue

        print(f"[{i}/{total}] {vid} {title}")
        try:
            status = generate(vid, title)
            if status == "skip":
                skipped += 1
                done_ids.add(vid)
                print("  → 已存在，跳过")
            elif status == "no_transcript":
                no_transcript += 1
                new_since_push += 1
                done_ids.add(vid)
                print("  → 无字幕")
            else:
                done += 1
                new_since_push += 1
                done_ids.add(vid)
                print("  → ✅ 完成")
            time.sleep(1.5)
        except Exception as e:
            failed += 1
            print(f"  → ❌ 失败: {e}")
            time.sleep(3)

        if new_since_push >= AUTO_PUSH_EVERY:
            git_push_and_clean(done_ids)
            new_since_push = 0

    if new_since_push > 0:
        git_push_and_clean(done_ids)

    print(f"\n完成: {done}  跳过: {skipped}  无字幕: {no_transcript}  失败: {failed}")


if __name__ == "__main__":
    main()
