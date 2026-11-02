"""ffprobe validation, cached only for an unchanged file and expected duration."""
import json
import math
import subprocess
from pathlib import Path
from automation_common import NO_WINDOW, atomic_json, read_json


class AudioValidator:
    def __init__(self, cache_file, ffprobe="ffprobe"):
        self.cache_file = Path(cache_file)
        self.ffprobe = ffprobe
        loaded = read_json(self.cache_file, {})
        self.cache = loaded if isinstance(loaded, dict) else {}
        self.dirty = False

    def valid(self, path, expected_duration=0):
        path = Path(path)
        try:
            stat = path.stat()
        except OSError:
            return False
        if stat.st_size < 50 * 1024:
            return False
        fingerprint = [stat.st_size, stat.st_mtime_ns, float(expected_duration or 0)]
        key = str(path.resolve())
        entry = self.cache.get(key, {})
        if entry.get("fingerprint") == fingerprint:
            return entry.get("valid") is True
        try:
            result = subprocess.run([self.ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=NO_WINDOW)
            data = json.loads(result.stdout) if result.returncode == 0 else {}
            duration = float(data.get("format", {}).get("duration", 0))
            valid = math.isfinite(duration) and duration > 0 and any(s.get("codec_type") == "audio" for s in data.get("streams", []))
            if expected_duration:
                valid = valid and abs(duration - float(expected_duration)) <= max(15, float(expected_duration) * 0.05)
        except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
            valid = False
        self.cache[key] = {"fingerprint": fingerprint, "valid": valid}
        self.dirty = True
        return valid

    def save(self):
        if self.dirty:
            atomic_json(self.cache_file, self.cache)
            self.dirty = False
