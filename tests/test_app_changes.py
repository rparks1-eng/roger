"""Source transactions never execute generated code or overwrite later edits."""

from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/python"))
import app_changes as changes


class AppChangeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / "public").mkdir()
        (self.root / "src/client").mkdir(parents=True)
        (self.root / "public/index.html").write_text("<html><body>Roger</body></html>")
        (self.root / "public/styles.css").write_text("body { color: green; }")
        (self.root / "src/client/app.mjs").write_text("console.log('Roger');")
        self.root_name = str(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def payload(self):
        sources = changes.run(self.root_name, "snapshot", {})["files"]
        return {
            "baseline": {name: item["hash"] for name, item in sources.items()},
            "files": [
                {"path": "public/index.html", "after": "<html><body>Calendar</body></html>"},
                {"path": "public/styles.css", "after": "body { color: purple; }"},
            ],
        }

    def test_apply_and_independent_undo_restore_exact_source(self):
        self.assertTrue(changes.run(self.root_name, "apply", self.payload())["applied"])
        self.assertIn("Calendar", (self.root / "public/index.html").read_text())
        self.assertTrue(changes.run(self.root_name, "status", {})["canUndo"])
        self.assertTrue(changes.run(self.root_name, "undo", {})["undone"])
        self.assertEqual((self.root / "public/styles.css").read_text(), "body { color: green; }")
        self.assertFalse(changes.run(self.root_name, "status", {})["canUndo"])
        self.assertEqual((self.root / ".roger-changes/rollback.json").stat().st_mode & 0o777, 0o600)

    def test_stale_unedited_context_blocks_apply_and_preserves_files(self):
        value = self.payload()
        (self.root / "src/client/app.mjs").write_text("console.log('newer');")
        with self.assertRaisesRegex(changes.ChangeError, "source changed"):
            changes.run(self.root_name, "apply", value)
        self.assertEqual(
            (self.root / "public/index.html").read_text(), "<html><body>Roger</body></html>"
        )

    def test_undo_refuses_newer_edits(self):
        changes.run(self.root_name, "apply", self.payload())
        (self.root / "public/styles.css").write_text("body { color: red; }")
        with self.assertRaisesRegex(changes.ChangeError, "newer edits"):
            changes.run(self.root_name, "undo", {})
        self.assertEqual((self.root / "public/styles.css").read_text(), "body { color: red; }")
        self.assertIn("Calendar", (self.root / "public/index.html").read_text())

    def test_paths_links_and_protected_code_are_rejected(self):
        for path in [
            "../secret",
            "src/server/http.mjs",
            "src/client/api.mjs",
            "public/app-changes.css",
        ]:
            value = self.payload()
            value["files"][0]["path"] = path
            with self.assertRaises(changes.ChangeError):
                changes.run(self.root_name, "apply", value)
        target = self.root / "public/styles.css"
        target.unlink()
        target.symlink_to(self.root / "public/index.html")
        with self.assertRaises(OSError):
            changes.run(self.root_name, "snapshot", {})

    def test_failed_second_write_restores_first_and_keeps_recovery_record(self):
        original = changes.replace_source
        attempts = 0

        def interrupted(root_fd, entry, field):
            nonlocal attempts
            if field == "after":
                attempts += 1
                if attempts == 2:
                    raise OSError("simulated full disk")
            return original(root_fd, entry, field)

        value = self.payload()
        with patch.object(changes, "replace_source", interrupted), self.assertRaises(OSError):
            changes.run(self.root_name, "apply", value)
        self.assertIn("Roger", (self.root / "public/index.html").read_text())
        self.assertEqual((self.root / "public/styles.css").read_text(), "body { color: green; }")

    def test_write_failure_cleans_temporary_files_and_preserves_original(self):
        with changes.directory(self.root_name) as root_fd:
            with changes.parent(root_fd, "public/styles.css") as (fd, leaf):
                with patch.object(changes.os, "write", side_effect=OSError("full disk")):
                    with self.assertRaises(OSError):
                        changes.atomic_text(fd, leaf, "new content")
        self.assertEqual(list((self.root / "public").glob(".roger-*.tmp")), [])
        self.assertEqual((self.root / "public/styles.css").read_text(), "body { color: green; }")

    def test_interrupted_journal_is_recovered_but_unknown_edits_are_preserved(self):
        changes.run(self.root_name, "apply", self.payload())
        journal_path = self.root / ".roger-changes/rollback.json"
        journal = json.loads(journal_path.read_text())
        journal["state"] = "prepared"
        journal_path.write_text(json.dumps(journal))
        # Crash halfway through replacement: first file after, second before.
        (self.root / "public/styles.css").write_text(journal["files"][1]["before"])
        changes.run(self.root_name, "status", {})
        self.assertIn("Roger", (self.root / "public/index.html").read_text())
        journal_path.write_text(json.dumps(journal))
        (self.root / "public/index.html").write_text("newer independent edit")
        with self.assertRaisesRegex(changes.ChangeError, "conflicts"):
            changes.run(self.root_name, "status", {})
        self.assertEqual((self.root / "public/index.html").read_text(), "newer independent edit")


if __name__ == "__main__":
    unittest.main()
