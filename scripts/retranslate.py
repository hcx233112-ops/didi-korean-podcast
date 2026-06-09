#!/usr/bin/env python3
"""
补翻译：把 zh==ko 的 segments 重新翻译成中文
支持断点续传，已翻的文件跳过
"""
import json, sys, time, concurrent.futures
from pathlib import Path
from deep_translator import GoogleTranslator

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

TRANSCRIPTS_DIR = Path(__file__).parent.parent / "public" / "data" / "transcripts"
BATCH_SIZE = 20
SLEEP_BETWEEN_BATCHES = 1.0


def run_with_timeout(fn, timeout=45):
    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = ex.submit(fn)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        ex.shutdown(wait=False, cancel_futures=True)
        raise TimeoutError(f"翻译超时 {timeout}s")
    finally:
        ex.shutdown(wait=False)


def translate_batch(texts):
    result = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        for attempt in range(3):
            try:
                t = GoogleTranslator(source="ko", target="zh-CN")
                translated = run_with_timeout(lambda: t.translate_batch(batch))
                result.extend(tr or orig for tr, orig in zip(translated, batch))
                break
            except Exception as e:
                print(f"  批次 {i//BATCH_SIZE+1} 第{attempt+1}次失败: {e}", flush=True)
                time.sleep(3)
        else:
            result.extend(batch)
        time.sleep(SLEEP_BETWEEN_BATCHES)
    return result


def needs_translation(segs):
    return any(s.get("zh", "") == s.get("ko", "") and s.get("ko", "").strip() for s in segs)


def process_file(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    segs = data.get("segments", [])
    if not segs or not needs_translation(segs):
        return False

    indices = [i for i, s in enumerate(segs) if s.get("zh", "") == s.get("ko", "") and s.get("ko", "").strip()]
    ko_texts = [segs[i]["ko"] for i in indices]

    zh_texts = translate_batch(ko_texts)

    for i, zh in zip(indices, zh_texts):
        segs[i]["zh"] = zh

    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return True


def main():
    files = sorted(TRANSCRIPTS_DIR.glob("*.json"))
    total = len(files)
    done = 0
    skipped = 0

    print(f"共 {total} 个文件，开始补翻译...\n", flush=True)

    for i, f in enumerate(files, 1):
        data = json.loads(f.read_text(encoding="utf-8"))
        segs = data.get("segments", [])
        if not segs or not needs_translation(segs):
            skipped += 1
            continue

        untrans = sum(1 for s in segs if s.get("zh","") == s.get("ko","") and s.get("ko","").strip())
        print(f"[{i}/{total}] {f.stem} ({untrans} 条)...", end=" ", flush=True)
        try:
            process_file(f)
            done += 1
            print("完成", flush=True)
        except Exception as e:
            print(f"失败: {e}", flush=True)

    print(f"\n完成 {done} 个，跳过 {skipped} 个")


if __name__ == "__main__":
    main()
