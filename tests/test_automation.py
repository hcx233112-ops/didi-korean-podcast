"""Offline regression tests. All subprocess/network boundaries are mocked."""
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SANDBOX = tempfile.TemporaryDirectory(prefix="podcast-regression-")


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Tests must neither contend with the real hourly task nor touch its files.
    directory = Path(SANDBOX.name) / (name + "-" + uuid.uuid4().hex)
    directory.mkdir(parents=True)
    project = SCRIPTS.parent
    for key, value in list(vars(module).items()):
        if isinstance(value, Path):
            try:
                isolated = directory / value.resolve().relative_to(project)
            except ValueError:
                continue
            setattr(module, key, isolated)
            if key.endswith("_DIR"):
                isolated.mkdir(parents=True, exist_ok=True)
    if hasattr(module, "_lock"):
        module._lock = module.ProcessLock(directory / "lock.log")
    if hasattr(module, "VALIDATOR"):
        module.VALIDATOR = module.AudioValidator(directory / "validation.log", module.FFPROBE)
    return module


class AutomationRegressionTests(unittest.TestCase):
    def setUp(self):
        # Any unmocked subprocess or HTTP call is a test failure, never a live action.
        self.boundaries = [patch("subprocess.run", side_effect=AssertionError("unexpected subprocess")), patch("subprocess.Popen", side_effect=AssertionError("unexpected process")), patch("urllib.request.urlopen", side_effect=AssertionError("unexpected HTTP")), patch("requests.get", side_effect=AssertionError("unexpected translation HTTP"))]
        for boundary in self.boundaries:
            boundary.start()
            self.addCleanup(boundary.stop)
        # Main-loop watchdog tests only validate orchestration; ffprobe itself is
        # exercised separately against temporary files and mocked process output.
        self.probe_validity = patch("audio_validation.AudioValidator.valid", return_value=True)
        self.probe_validity.start()
        self.addCleanup(self.probe_validity.stop)

    def test_wrapper_propagates_child_exit_code(self):
        with patch("subprocess.run", return_value=SimpleNamespace(returncode=17)):
            module = load("run-transcripts")
            self.assertTrue(hasattr(module, "main"), "wrapper needs a testable main returning child status")
            with patch.object(module, "write_status"):
                self.assertEqual(module.main(), 17)

    def test_git_pull_failure_stops_sync(self):
        module = load("sync-audio")
        with patch.object(module.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr="network", stdout="")), patch.object(module, "log"):
            with self.assertRaises(RuntimeError):
                module.git_pull()

    def test_negative_subtitle_cache_expires(self):
        module = load("generate-transcripts")
        self.assertTrue(hasattr(module, "should_generate"), "no_transcript must be a temporary cache")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "video.json"
            path.write_text(json.dumps({"segments": [], "error": "no_transcript", "checked_at": "2000-01-01T00:00:00+00:00"}))
            self.assertTrue(module.should_generate(path))

    def test_audio_validation_checks_duration_not_just_size(self):
        self.probe_validity.stop()
        module = load("sync-audio")
        self.assertTrue(hasattr(module, "AudioValidator"), "ffprobe validation is required")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "video.m4a"
            path.write_bytes(b"x" * 60000)
            validator = module.AudioValidator(Path(tmp) / "cache.json")
            response = SimpleNamespace(returncode=0, stdout=json.dumps({"format": {"duration": "30"}, "streams": [{"codec_type": "audio"}]}))
            with patch("subprocess.run", return_value=response):
                self.assertFalse(validator.valid(path, 1000), "a large but truncated file must fail")

    def test_probe_cache_invalidates_after_file_size_or_mtime_changes(self):
        self.probe_validity.stop()
        from audio_validation import AudioValidator
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "video.m4a"
            path.write_bytes(b"x" * 60000)
            validator = AudioValidator(Path(tmp) / "cache.json")
            response = SimpleNamespace(returncode=0, stdout=json.dumps({"format": {"duration": "100"}, "streams": [{"codec_type": "audio"}]}))
            with patch("subprocess.run", return_value=response) as probe:
                self.assertTrue(validator.valid(path, 100))
                self.assertTrue(validator.valid(path, 100))
                self.assertEqual(probe.call_count, 1)
                path.write_bytes(b"y" * 60001)
                self.assertTrue(validator.valid(path, 100))
                self.assertEqual(probe.call_count, 2)
                import os
                st = path.stat()
                os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10000000))
                self.assertTrue(validator.valid(path, 100))
                self.assertEqual(probe.call_count, 3)
                validator.save()
                fresh = AudioValidator(Path(tmp) / "cache.json")
                self.assertTrue(fresh.valid(path, 100))
                self.assertEqual(probe.call_count, 3)

    def test_failed_download_preserves_existing_audio(self):
        module = load("sync-audio")
        import yt_dlp
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            old = directory / "abcdefghijk.m4a"
            old.write_bytes(b"old audio")
            ydl = unittest.mock.MagicMock()
            ydl.__enter__.return_value.download.return_value = 1
            with patch.object(module, "AUDIO_DIR", directory), patch.object(module, "STAGING_DIR", directory / "staging", create=True), patch.object(yt_dlp, "YoutubeDL", return_value=ydl), patch.object(module.AudioValidator, "valid", return_value=False):
                self.assertEqual(module.download("abcdefghijk", 1000), "fail")
            self.assertEqual(old.read_bytes(), b"old audio")
            self.assertEqual(list((directory / "staging").iterdir()), [])

    def test_validated_download_replaces_existing_audio_atomically(self):
        module = load("sync-audio")
        import yt_dlp
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            old = directory / "abcdefghijk.m4a"
            old.write_bytes(b"old audio")
            class FakeYDL:
                def __init__(self, options): self.options = options
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def download(self, urls):
                    self.assertion = old.read_bytes() == b"old audio"
                    if not self.assertion: raise AssertionError("old audio removed before verification")
                    path = Path(self.options["outtmpl"].replace("%(id)s", "abcdefghijk").replace("%(ext)s", "m4a"))
                    path.write_bytes(b"new audio")
                    return 0
            with patch.object(module, "AUDIO_DIR", directory), patch.object(module, "STAGING_DIR", directory / "staging", create=True), patch.object(yt_dlp, "YoutubeDL", FakeYDL), patch.object(module.AudioValidator, "valid", return_value=True):
                self.assertEqual(module.download("abcdefghijk", 1000), "ok")
            self.assertEqual(old.read_bytes(), b"new audio")

    def test_new_audio_triggers_subtitles_only_when_downloaded(self):
        module = load("sync-audio")
        video = {"id": "abcdefghijk", "title": "t", "duration": 1000}
        for result, expected in (("ok", 1), ("fail", 0)):
            with patch.object(module, "check_deps"), patch.object(module, "git_pull"), patch.object(module, "log"), \
                    patch.object(module, "write_status"), patch.object(module.time, "sleep"), \
                    patch.object(module, "load_all_videos", return_value=[video]), \
                    patch.object(module, "find_missing", return_value=[video]), \
                    patch.object(module, "download", return_value=result), \
                    patch.object(module.Path, "stat", return_value=SimpleNamespace(st_size=2048)), \
                    patch.object(module, "start_transcripts") as trigger, patch.object(module, "warm_edge") as warm:
                module.main()
            self.assertEqual(warm.call_count, expected)
            self.assertEqual(trigger.call_count, expected)

    def test_transcript_log_is_rotated(self):
        module = load("run-transcripts")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "log.txt"
            path.write_text("\n".join(f"line {i}" for i in range(5000)), encoding="utf-8")
            module.rotate_log(path, max_bytes=100, keep_lines=10)
            self.assertEqual(path.read_text(encoding="utf-8").splitlines(), [f"line {i}" for i in range(4990, 5000)])

    def test_forced_negative_cache_can_be_rechecked(self):
        module = load("generate-transcripts")
        from automation_common import utc_now
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "abcdefghijk.json"
            path.write_text(json.dumps({"segments": [], "error": "no_transcript", "checked_at": utc_now()}))
            self.assertFalse(module.should_generate(path))
            with patch.object(module, "TRANSCRIPTS_DIR", directory), patch.object(module, "fetch_subtitles_ytdlp", return_value=None):
                self.assertEqual(module.generate("abcdefghijk", force=True), "no_transcript")

    def test_mutex_does_not_allow_simultaneous_owners(self):
        from automation_common import ProcessLock
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lock"
            first = ProcessLock(path)
            self.assertTrue(first.acquire())
            result = []
            def try_second():
                second = ProcessLock(path)
                result.append(second.acquire())
                second.release()
            thread = threading.Thread(target=try_second)
            thread.start()
            thread.join(timeout=5)
            first.release()
            self.assertEqual(result, [False])
            second = ProcessLock(path)
            self.assertTrue(second.acquire())
            second.release()

    def test_subtitle_download_sets_real_deadline(self):
        module = load("generate-transcripts")
        with patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            self.assertIsNone(module.fetch_subtitles_ytdlp("abcdefghijk"))
            self.assertEqual(run.call_args.kwargs["timeout"], 180)
            self.assertIn("--socket-timeout", run.call_args.args[0])

    def test_public_range_probe_rejects_non_range_response(self):
        module = load("watchdog")
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {}
        response.read.return_value = b"x" * 101
        with patch("urllib.request.urlopen", return_value=response):
            self.assertFalse(module.probe_audio("https://example.test", "abcdefghijk"))

    def test_range_probe_identifies_the_application_to_the_public_edge(self):
        module = load("watchdog")
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 206
        response.headers = {"Content-Range": "bytes 0-100/50000"}
        response.read.return_value = b"x" * 101
        with patch("urllib.request.urlopen", return_value=response) as request:
            self.assertTrue(module.probe_audio("https://example.test", "abcdefghijk"))
            self.assertEqual(request.call_args.args[0].get_header("User-agent"), "DidiPodcast-Healthcheck/1.0")

    def test_unrecovered_audio_service_triggers_notification(self):
        module = load("watchdog")
        from automation_common import utc_now
        states = {name: {"exists": True, "enabled": True, "last_result": 0, "last_run": utc_now()} for name in module.TASK_NAMES}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "abcdefghijk.m4a").write_bytes(b"x" * 60000)
            good_status = {"status": "success", "updated_at": utc_now()}
            with patch.object(module, "AUDIO_DIR", directory), patch.object(module, "task_states", return_value=states), patch.object(module, "read_json", return_value=good_status), patch.object(module, "video_list", return_value=[{"id": "abcdefghijk", "published": "2000-01-01"}]), patch.object(module, "public_base", return_value="https://example.test"), patch.object(module, "probe_audio", return_value=False) as probe, patch.object(module, "recover_services", return_value=True), patch.object(module.time, "sleep"), patch.object(module, "notify") as notify, patch.object(module, "write_status") as status, patch.object(module, "log"):
                self.assertEqual(module.main(), 1)
                self.assertEqual(probe.call_count, 8, "must retest both endpoints after attempted recovery")
                notify.assert_called_once()
                self.assertEqual(status.call_args.args[1], "failed")

    def test_overdue_running_sync_is_detected_and_not_claimed_repaired(self):
        module = load("watchdog")
        from automation_common import utc_now
        from datetime import datetime, timedelta, timezone
        states = {name: {"exists": True, "enabled": True, "last_result": 0, "last_run": utc_now()} for name in module.TASK_NAMES}
        stuck = {"status": "running", "updated_at": (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()}
        good = {"status": "success", "updated_at": utc_now()}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "abcdefghijk.m4a").write_bytes(b"x" * 60000)
            with patch.object(module, "AUDIO_DIR", directory), patch.object(module, "task_states", return_value=states), patch.object(module, "read_json", side_effect=lambda path: stuck if path.name == "audio-status.log" else good), patch.object(module, "video_list", return_value=[{"id": "abcdefghijk", "published": "2000-01-01"}]), patch.object(module, "public_base", return_value="https://example.test"), patch.object(module, "probe_audio", return_value=True), patch.object(module, "run_sync_now") as retry, patch.object(module, "notify"), patch.object(module, "write_status") as status, patch.object(module, "log"):
                self.assertEqual(module.main(), 1)
                retry.assert_called_once()
                self.assertEqual(status.call_args.args[1], "failed")
                self.assertTrue(status.call_args.kwargs["pending"])

    def test_watchdog_detects_truncated_historical_audio(self):
        module = load("watchdog")
        from automation_common import utc_now
        states = {name: {"exists": True, "enabled": True, "last_result": 0, "last_run": utc_now()} for name in module.TASK_NAMES}
        good = {"status": "success", "updated_at": utc_now()}
        validator = unittest.mock.MagicMock()
        validator.valid.return_value = False
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "abcdefghijk.m4a").write_bytes(b"x" * 60000)
            with patch.object(module, "AUDIO_DIR", directory), patch.object(module, "AudioValidator", return_value=validator, create=True), patch.object(module, "task_states", return_value=states), patch.object(module, "read_json", return_value=good), patch.object(module, "video_list", return_value=[{"id": "abcdefghijk", "published": "2000-01-01", "duration": 2000}]), patch.object(module, "public_base", return_value="https://example.test"), patch.object(module, "probe_audio", return_value=True), patch.object(module, "run_sync_now") as retry, patch.object(module, "notify"), patch.object(module, "write_status"), patch.object(module, "log"):
                self.assertEqual(module.main(), 1)
                retry.assert_called_once()
                validator.valid.assert_called_once_with(directory / "abcdefghijk.m4a", 2000)

    def test_watchdog_reports_audio_the_server_cannot_read(self):
        module = load("watchdog")
        from automation_common import utc_now
        states = {name: {"exists": True, "enabled": True, "last_result": 0, "last_run": utc_now()} for name in module.TASK_NAMES}
        good = {"status": "success", "updated_at": utc_now()}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "abcdefghijk.m4a").write_bytes(b"x" * 60000)
            with patch.object(module, "AUDIO_DIR", directory), patch.object(module, "readable", return_value=False), patch.object(module, "task_states", return_value=states), patch.object(module, "read_json", return_value=good), patch.object(module, "video_list", return_value=[{"id": "abcdefghijk", "duration": 2000}]), patch.object(module, "public_base", return_value="https://example.test"), patch.object(module, "probe_audio", return_value=True), patch.object(module, "notify") as notify, patch.object(module, "write_status") as status, patch.object(module, "log"):
                self.assertEqual(module.main(), 1)
                self.assertIn("无法读取", status.call_args.kwargs["issues"][0])
                notify.assert_called_once()
        self.assertTrue(module.readable(Path(__file__)))
        self.assertFalse(module.readable(Path(tmp) / "gone.m4a"))

    def test_english_caption_lines_merge_into_sentences(self):
        module = load("generate-transcripts")
        lines = [("been no episodes for", 0), ("two weeks, because I was ill.", 2000), ("Um I've been in bed", 4000), ("over there.", 6000), ("Right?", 7000)]
        merged = module.merge_sentences([{"start_ms": t, "end_ms": t + 1500, "text": x} for x, t in lines])
        self.assertEqual([m["text"] for m in merged], ["been no episodes for two weeks, because I was ill.", "Um I've been in bed over there.", "Right?"])
        self.assertEqual((merged[1]["start_ms"], merged[1]["end_ms"]), (4000, 7500))
        long = [{"start_ms": i * 1000, "end_ms": i * 1000 + 900, "text": "word " * 10} for i in range(10)]
        self.assertTrue(all(len(m["text"]) < 200 for m in module.merge_sentences(long)))

    def test_generated_subtitles_record_and_translate_from_the_channel_language(self):
        module = load("generate-transcripts")
        segments = [{"start_ms": 0, "end_ms": 1000, "text": "Hello there."}]
        with patch.object(module, "fetch_subtitles_ytdlp", return_value=segments) as fetch, patch.object(module, "translate_all", return_value=["你好。"]) as translate:
            self.assertEqual(module.generate("abcdefghijk", lang="en"), "ok")
        fetch.assert_called_once_with("abcdefghijk", "en")
        translate.assert_called_once_with(["Hello there."], "en")
        saved = json.loads((module.TRANSCRIPTS_DIR / "abcdefghijk.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["lang"], "en")
        self.assertEqual(saved["segments"][0], {"start": 0.0, "end": 1.0, "ko": "Hello there.", "zh": "你好。"})

    def test_english_titles_drop_numbers_tags_and_seo_tails(self):
        titles = load("video_titles")
        cases = {
            "Sick in France 🇫🇷 | How My Family Holiday Became a 3-Week Nightmare [1009]": "Sick in France",
            "Life, Death & Mario Kart [1008] A Rambling Challenge": "Life, Death & Mario Kart",
            "868. How the USA is changing (with Lindsay McMahon)": "How the USA is changing",
            "[BONUS] FIFA WORLD CUP 2026 PREVIEW MEGARAMBLE ⚽": "FIFA WORLD CUP 2026 PREVIEW MEGARAMBLE",
            "895. Books 📚 Farts💨 & Ghosts 👻 (with Anna Brooke)": "Books Farts & Ghosts",
            "Room 101🚪with Charlie Baxter 🇬🇧 Funny British English Listening Practice [980]": "Room 101 with Charlie Baxter",
            "Technology in Everyday Life (Part 2) 👨‍💻 The Choices We Make / Topic Discussion & Vocabulary [947]": "Technology in Everyday Life (Part 2)",
            "925. Walaa’s Experience in Syria / Walaa Mouma Returns (Part 2) and a much longer tail": "Walaa’s Experience in Syria",
            "Episode 1000! 🎉": "Episode 1000!",
        }
        for raw, expected in cases.items():
            self.assertEqual(titles.clean_title(raw, "en"), expected, raw)

    def test_korean_title_rules_are_unchanged(self):
        titles = load("video_titles")
        self.assertEqual(titles.clean_title("Didi의 한국문화 Podcast 잠이 안오는 밤 (Korean Podcast) | Learn Korean", "ko"), "잠이 안오는 밤")
        self.assertEqual(titles.clean_title("한국어 (자막) 이야기", "ko"), "한국어 (자막) 이야기")

    def test_channel_selection_filters_short_videos_and_keeps_newest(self):
        module = load("update-videos")
        videos = [{"id": str(i), "published": f"2026-01-{i + 10:02d}", "duration": d} for i, d in enumerate([100, 700, 900, 0, 800])]
        self.assertEqual([v["id"] for v in module.select(videos, {"minDuration": 600, "limit": 2})], ["4", "2"])
        self.assertEqual(len(module.select(videos, {})), 5)
        self.assertEqual(module.parse_duration("PT1H2M3S"), 3723)

    def test_pending_translation_includes_blank_chinese(self):
        module = load("retranslate")
        self.assertTrue(module._pending({"ko": "한국어", "zh": ""}))

    def test_translator_does_not_count_failed_requests_as_done(self):
        module = load("retranslate")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "video.json"
            data = {"segments": [{"ko": "한국어", "zh": "한국어"}]}
            with patch.object(module, "translate_all", return_value=[None]):
                self.assertEqual(module.process_file(path, data), (0, 1))

    def test_watchdog_does_not_hide_newer_failed_attempt(self):
        module = load("watchdog")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audio.log"
            path.write_text("[2026-11-02 12:41:05] ===== sync-audio 开始 =====\n[2026-11-02 12:41:06] ===== 完成 =====\n[2026-11-02 16:41:05] ===== sync-audio 开始 =====\n[2026-11-02 16:41:06] git pull 失败: network\n", encoding="utf-8")
            with patch.object(module, "LOG_FILE", path):
                self.assertTrue(module.parse_last_sync()[1])

    def test_scheduler_updates_without_unregistering_tasks(self):
        source = (SCRIPTS / "setup-scheduler.ps1").read_text(encoding="utf-8-sig")
        self.assertNotIn("Unregister-ScheduledTask", source)
        self.assertIn("podcast-transcript-update", source)


if __name__ == "__main__":
    unittest.main()
