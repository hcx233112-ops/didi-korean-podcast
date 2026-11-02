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
