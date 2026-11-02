#!/usr/bin/env python3
"""
补翻译：把 zh==ko 的 segments 重新翻译成中文
使用 Google Translate 公开端点，支持断点续传
"""
import json, sys, time, requests, os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from automation_common import atomic_json

# 无控制台环境下 stdout/stderr 为 None，先容错再 reconfigure
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

TRANSCRIPTS_DIR = Path(__file__).parent.parent / "public" / "data" / "transcripts"
WORKERS = 6  # 并发请求数（dict-chrome-ex 端点，6 并发实测不触发限流）


def gtrans(text):
    for attempt in range(3):
        try:
            r = requests.get(
                "https://translate.googleapis.com/translate_a/single",
                params={"client": "dict-chrome-ex", "sl": "ko", "tl": "zh-CN", "dt": "t", "q": text},
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=(5, 20),
            )
            if r.status_code != 200:
                raise Exception(f"HTTP {r.status_code}")
            data = r.json()
            translated = "".join(seg[0] for seg in data[0] if seg[0])
            if not translated.strip():
                raise ValueError("empty translation response")
            return translated
        except Exception:
            if attempt == 2:
                return None   # 网络/HTTP 失败：返回 None，下次再试
            time.sleep(1 + attempt)


def translate_all(texts):
    results = [None] * len(texts)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(gtrans, t): i for i, t in enumerate(texts)}
        for f in as_completed(futures):
            results[futures[f]] = f.result()
    return results


def _pending(s):
    # zh 与 ko 相同、ko 非空、且未被标记为不可译
    return bool(s.get("ko", "").strip() and not s.get("nt") and (not s.get("zh", "").strip() or s.get("zh") == s.get("ko")))


def needs_translation(segs):
    return any(_pending(s) for s in segs)


def process_file(path, data):
    segs = data.get("segments", [])
    indices  = [i for i, s in enumerate(segs) if _pending(segs[i])]
    ko_texts = [segs[i]["ko"] for i in indices]
    zh_texts = translate_all(ko_texts)
    if len(zh_texts) != len(indices):
        raise ValueError("translation count mismatch")
    translated = failed = 0

    for i, zh in zip(indices, zh_texts):
        if not zh:
            failed += 1
            continue                    # 本次失败，保留原状下次再试
        if zh == segs[i]["ko"]:
            segs[i]["nt"] = 1           # 译文与原文一致 → 不可译，永久跳过
        else:
            segs[i]["zh"] = zh
        translated += 1

    atomic_json(path, data)
    return translated, failed


def main():
    files   = sorted(TRANSCRIPTS_DIR.glob("*.json"))
    total   = len(files)
    done = skipped = failed_files = translated_segments = failed_segments = 0

    print(f"共 {total} 个文件，开始补翻译...\n", flush=True)

    for i, f in enumerate(files, 1):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            segs = data.get("segments", [])
            if not segs or not needs_translation(segs):
                skipped += 1
                continue
            translated, failed = process_file(f, data)
            translated_segments += translated
            failed_segments += failed
            if failed:
                failed_files += 1
            else:
                done += 1
            print(f"[{i}/{total}] {f.stem}: 成功 {translated} 段，失败 {failed} 段", flush=True)
        except Exception as e:
            failed_files += 1
            print(f"失败: {e}", flush=True)

    print(f"\n完成 {done} 个，跳过 {skipped} 个，失败 {failed_files} 个；翻译成功 {translated_segments} 段，失败 {failed_segments} 段", flush=True)
    return 1 if failed_files else 0


if __name__ == "__main__":
    sys.exit(main())
