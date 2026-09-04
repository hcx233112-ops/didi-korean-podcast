#!/usr/bin/env python3
"""
补翻译：把 zh==ko 的 segments 重新翻译成中文
使用 Google Translate 公开端点，支持断点续传
"""
import json, sys, time, requests, os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

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
                timeout=15,
            )
            if r.status_code != 200:
                raise Exception(f"HTTP {r.status_code}")
            data = r.json()
            return "".join(seg[0] for seg in data[0] if seg[0])
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
    return s.get("zh", "") == s.get("ko", "") and s.get("ko", "").strip() and not s.get("nt")


def needs_translation(segs):
    return any(_pending(s) for s in segs)


def process_file(path, data):
    segs = data.get("segments", [])
    indices  = [i for i, s in enumerate(segs) if _pending(segs[i])]
    ko_texts = [segs[i]["ko"] for i in indices]
    zh_texts = translate_all(ko_texts)

    for i, zh in zip(indices, zh_texts):
        if zh is None:
            continue                    # 本次失败，保留原状下次再试
        if zh == segs[i]["ko"]:
            segs[i]["nt"] = 1           # 译文与原文一致 → 不可译，永久跳过
        else:
            segs[i]["zh"] = zh

    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    files   = sorted(TRANSCRIPTS_DIR.glob("*.json"))
    total   = len(files)
    done    = skipped = 0

    print(f"共 {total} 个文件，开始补翻译...\n", flush=True)

    for i, f in enumerate(files, 1):
        data = json.loads(f.read_text(encoding="utf-8"))
        segs = data.get("segments", [])
        if not segs or not needs_translation(segs):
            skipped += 1
            continue

        untrans = sum(1 for s in segs if _pending(s))
        print(f"[{i}/{total}] {f.stem} ({untrans} 条)...", end=" ", flush=True)
        try:
            process_file(f, data)
            done += 1
            print("完成", flush=True)
        except Exception as e:
            print(f"失败: {e}", flush=True)

    print(f"\n完成 {done} 个，跳过 {skipped} 个", flush=True)


if __name__ == "__main__":
    main()
