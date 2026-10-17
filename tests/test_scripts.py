import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    # Tests use fake HTTP only; they also run without installing requests locally.
    fake_requests = types.ModuleType("requests")
    fake_requests.RequestException = type("RequestException", (Exception,), {})
    fake_requests.get = Mock(side_effect=AssertionError("Network forbidden"))
    fake_requests.post = Mock(side_effect=AssertionError("Network forbidden"))
    with patch.dict(sys.modules, {"requests": fake_requests}):
        spec.loader.exec_module(module)
    return module


upload = load("upload_catalog")
clean = load("clean_links")
check = load("check_links")


def response(body=None, status=200):
    return types.SimpleNamespace(status_code=status, ok=200 <= status < 300,
                                 text=json.dumps(body), json=lambda: body)


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.catalog = Path(self.temp.name) / "catalog.json"
        self.catalog.write_text(json.dumps({"mounts": {"电影/示例": {"id": "share123"}}}), encoding="utf-8")

    def invoke(self, *extra):
        args = ["upload_catalog.py", "--url", "https://example.test", "--user", "用户",
                "--admin-token", "管理密码", "--file", str(self.catalog), *extra]
        with patch.object(sys, "argv", args), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return upload.main()

    def test_same_successful_hash_skips_upload(self):
        with patch.object(upload.requests, "get", return_value=response({"source_hash": "A"})), patch.object(upload.requests, "post") as post:
            self.assertEqual(self.invoke("--source-hash", "A", "--if-changed"), 0)
            post.assert_not_called()

    def test_reverting_to_an_old_hash_uploads_again(self):
        with patch.object(upload.requests, "get", return_value=response({"source_hash": "B"})), patch.object(upload.requests, "post", return_value=response({"ok": True})) as post:
            self.assertEqual(self.invoke("--source-hash", "A", "--if-changed"), 0)
            self.assertEqual(post.call_args.kwargs["json"]["source_hash"], "A")
            import base64
            auth = post.call_args.kwargs["headers"]["Authorization"].split()[1]
            self.assertEqual(base64.b64decode(auth).decode(), "用户:管理密码")

    def test_force_upload_does_not_read_sync_state(self):
        with patch.object(upload.requests, "get") as get, patch.object(upload.requests, "post", return_value=response({"ok": True})) as post:
            self.assertEqual(self.invoke("--source-hash", "A"), 0)
            get.assert_not_called()
            post.assert_called_once()

    def test_old_workers_without_sync_endpoint_never_silently_receive_full_upload(self):
        with patch.object(upload.requests, "get", return_value=response(status=404)), patch.object(upload.requests, "post") as post:
            self.assertEqual(self.invoke("--source-hash", "A", "--if-changed"), 1)
            post.assert_not_called()

    def test_unauthorized_sync_state_explains_credentials_and_possible_old_worker(self):
        output = io.StringIO()
        with patch.object(upload.requests, "get", return_value=response(status=401)), patch.object(upload.requests, "post") as post, contextlib.redirect_stderr(output):
            # invoke captures stderr itself, so run main directly here.
            args = ["upload_catalog.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123",
                    "--file", str(self.catalog), "--source-hash", "A", "--if-changed"]
            with patch.object(sys, "argv", args):
                self.assertEqual(upload.main(), 1)
            post.assert_not_called()
        self.assertIn("管理口令", output.getvalue())
        self.assertIn("升级", output.getvalue())

    def test_failed_state_lookup_never_overwrites_catalog(self):
        for state in [response(status=401), response(status=502), response([]), response({}), response({"source_hash": None})]:
            with self.subTest(status=state.status_code), patch.object(upload.requests, "get", return_value=state), patch.object(upload.requests, "post") as post:
                self.assertEqual(self.invoke("--source-hash", "A", "--if-changed"), 1)
                post.assert_not_called()

    def test_state_network_failure_does_not_upload(self):
        with patch.object(upload.requests, "get", side_effect=upload.requests.RequestException("offline")), patch.object(upload.requests, "post") as post:
            self.assertEqual(self.invoke("--source-hash", "A", "--if-changed"), 1)
            post.assert_not_called()

    def test_failed_upload_does_not_write_a_separate_success_marker(self):
        before = self.catalog.read_text(encoding="utf-8")
        with patch.object(upload.requests, "post", return_value=response({"error": "failed"}, 502)):
            self.assertEqual(self.invoke("--source-hash", "A"), 1)
        self.assertEqual(self.catalog.read_text(encoding="utf-8"), before)
        self.assertEqual([p.name for p in self.catalog.parent.iterdir()], ["catalog.json"])

    def test_success_requires_explicit_worker_acknowledgement(self):
        with patch.object(upload.requests, "post", return_value=response({"error": "not saved"})):
            self.assertEqual(self.invoke(), 1)

    def test_if_changed_requires_a_source_hash(self):
        self.assertEqual(self.invoke("--if-changed"), 1)


class ParserTests(unittest.TestCase):
    def test_example_links_are_never_imported(self):
        self.assertEqual(clean.parse_file(str(ROOT / "data" / "示例合集.md")), [])

    def test_heading_levels_and_later_password_upgrade(self):
        lines = ["# 分类", "### 旧标题", "### 新标题", "电影：share1234", "电影：share1234#8888"]
        with patch.object(clean, "iter_lines", return_value=iter(lines)):
            items = clean.parse_file("memory")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["path"], ["分类", "新标题"])
        self.assertEqual(items[0]["ids"], ["share1234#8888"])

    def test_passwords_do_not_leak_between_links(self):
        self.assertEqual(clean.extract_ids("甲 https://caiyun.139.com/m/i?AAA 乙 https://caiyun.139.com/m/i?BBB#1234"), ["AAA", "BBB#1234"])

    def test_utf8_bom_preserves_the_first_heading(self):
        raw = b'\xef\xbb\xbf# Category\nMovie:share1234\n'
        with patch.object(clean, "open", return_value=io.BytesIO(raw), create=True):
            self.assertEqual(clean.parse_file("bom.md")[0]["path"], ["Category"])

    def test_same_line_duplicates_upgrade_missing_passwords(self):
        for line in [
            "电影：https://yun.139.com/shareweb/#/w/i/share1234 https://yun.139.com/shareweb/#/w/i/share1234#8888",
            "电影：share1234,share1234#8888",
            "电影：[https://yun.139.com/shareweb/#/w/i/share1234](https://yun.139.com/shareweb/#/w/i/share1234#8888)",
        ]:
            with self.subTest(line=line):
                self.assertEqual(clean.extract_ids(line), ["share1234#8888"])
                with patch.object(clean, "iter_lines", return_value=iter([line])):
                    self.assertEqual(clean.parse_file("memory")[0]["ids"], ["share1234#8888"])

    def test_duplicate_passwords_keep_the_first_valid_password_and_original_order(self):
        cases = [
            ("电影：share1234#1111,share1234#2222,share5678", ["share1234#1111", "share5678"]),
            ("电影：share1234#1111,share1234", ["share1234#1111"]),
            ("电影：https://caiyun.139.com/m/i?share1234#1111 https://yun.139.com/shareweb/#/w/i/share5678 https://yun.139.com/shareweb/#/w/i/share1234#2222", ["share1234#1111", "share5678"]),
        ]
        for line, expected in cases:
            with self.subTest(line=line):
                self.assertEqual(clean.extract_ids(line), expected)


class CheckClientTests(unittest.TestCase):
    def test_structural_errors_are_printed_for_manual_review_without_temporary_retry_advice(self):
        output = io.StringIO()
        result = {"ok": True, "done": True, "total": 1, "unverified": 0,
                  "flagged": [{"path": "Library/Share", "kind": "structure", "reason": "BAD_RESPONSE：响应结构异常，需人工核对"}]}
        with patch.object(sys, "argv", ["check_links.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123"]), patch.object(check.requests, "post", return_value=response(result)), contextlib.redirect_stdout(output):
            self.assertEqual(check.main(), 0)
        self.assertIn("Library/Share", output.getvalue())
        self.assertIn("需人工核对", output.getvalue())
        self.assertNotIn("稍后重试", output.getvalue())
        self.assertNotIn("未知错误码", output.getvalue())

    def test_successful_cleanup_with_missing_history_is_reported_explicitly(self):
        output = io.StringIO()
        result = {"ok": True, "done": True, "total": 1, "logWarning": True,
                  "removed": [{"path": "A", "id": "original-share"}]}
        with patch.object(sys, "argv", ["check_links.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123"]), patch.object(check.requests, "post", return_value=response(result)), contextlib.redirect_stdout(output):
            self.assertEqual(check.main(), 0)
        self.assertIn("清理记录未保存", output.getvalue())
        self.assertIn("original-share", output.getvalue())

    def test_incomplete_or_malformed_check_responses_are_not_reported_as_finished(self):
        for body in [[], {"ok": True}, {"ok": True, "done": False}, {"ok": True, "done": False, "nextFrom": []}]:
            with self.subTest(body=body), patch.object(sys, "argv", ["check_links.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123"]), patch.object(check.requests, "post", return_value=response(body)), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(check.main(), 1)

    def test_uncertain_shares_are_reported_without_deleting_them(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["check_links.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123"]), patch.object(check.requests, "post", return_value=response({"ok": True, "done": True, "total": 3, "unverified": 2})), contextlib.redirect_stdout(output):
            self.assertEqual(check.main(), 0)
        self.assertIn("2", output.getvalue())
        self.assertIn("未能确认", output.getvalue())

    def test_member_cursor_is_passed_back_without_interpretation(self):
        cursor = '@check:["电影/合集",{"id":"S20","pwd":""}]'
        pages = [response({"ok": True, "total": 1, "nextFrom": cursor, "done": False}),
                 response({"ok": True, "total": 1, "done": True})]
        with patch.object(sys, "argv", ["check_links.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123"]), patch.object(check.requests, "post", side_effect=pages) as post, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(), 0)
        self.assertEqual(post.call_args_list[1].kwargs["json"], {"from": cursor})

    def test_batches_that_write_catalog_wait_before_continuing(self):
        pages = [response({"ok": True, "total": 2, "nextFrom": "B", "done": False,
                           "removed": [{"path": "A", "id": "dead"}]}),
                 response({"ok": True, "total": 1, "done": True})]
        with patch.object(sys, "argv", ["check_links.py", "--url", "https://example.test", "--user", "admin", "--pass", "pass123"]), patch.object(check.requests, "post", side_effect=pages), patch.object(check.time, "sleep") as sleep, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(), 0)
        sleep.assert_called_once_with(1.1)


if __name__ == "__main__":
    unittest.main()
