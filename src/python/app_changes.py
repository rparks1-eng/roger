"""Allowlisted browser-source transactions; generated text never runs here.

Recovery without Roger or an AI: python3 src/python/app_changes.py ROOT undo
Pass JSON on stdin ({} for undo/status/snapshot). Journals live in ROOT/.roger-changes.
"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import PurePosixPath
import stat
import sys
import uuid

CLIENTS = {
    "app",
    "canvas-ui",
    "canvas-display",
    "study-ui",
    "course-study-ui",
    "syllabus-ui",
    "resources-ui",
    "documents",
    "pdf-workspace",
    "speech",
}
STYLES = {
    "styles",
    "appearance",
    "memory",
    "resources",
    "builder",
    "connections",
}
ALLOWED = (
    {"public/index.html"}
    | {f"public/{name}.css" for name in STYLES}
    | {f"src/client/{name}.mjs" for name in CLIENTS}
)
MAX_FILE = 256 * 1024
MAX_TOTAL = 2 * 1024 * 1024
MAX_JOURNAL = 4 * 1024 * 1024


class ChangeError(Exception):
    pass


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def safe_path(name):
    if not isinstance(name, str) or name not in ALLOWED:
        raise ChangeError("Only supported browser application files can be changed.")
    return PurePosixPath(name).parts


@contextmanager
def directory(root):
    if not isinstance(root, str) or not os.path.isabs(root) or ".." in root.split(os.sep):
        raise ChangeError("The application source folder is invalid.")
    fd = os.open(os.path.abspath(os.sep), os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.split(os.sep):
            if not part:
                continue
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        if os.fstat(fd).st_uid != os.getuid():
            raise ChangeError("The application source folder must belong to this account.")
        yield fd
    finally:
        os.close(fd)


@contextmanager
def parent(root_fd, name):
    parts = safe_path(name)
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, parts[-1]
    finally:
        os.close(fd)


def regular(fd, name, max_bytes=MAX_FILE):
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(handle)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or info.st_size > max_bytes
        ):
            raise ChangeError("Source must be an owned, bounded regular file without links.")
        chunks = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(handle, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            raise ChangeError("Source is too large.")
        return data.decode("utf-8"), stat.S_IMODE(info.st_mode)
    finally:
        os.close(handle)


def read_source(root_fd, name):
    with parent(root_fd, name) as (fd, leaf):
        return regular(fd, leaf)


def atomic_text(fd, name, text, mode=0o600):
    temp = f".roger-{uuid.uuid4().hex}.tmp"
    out = None
    try:
        out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
        data = text.encode("utf-8")
        while data:
            size = os.write(out, data)
            if size == 0:
                raise OSError("Source write stopped before completion")
            data = data[size:]
        os.fsync(out)
        os.close(out)
        out = None
        os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        if out is not None:
            os.close(out)
        try:
            os.unlink(temp, dir_fd=fd)
        except FileNotFoundError:
            pass


def replace_source(root_fd, entry, field):
    with parent(root_fd, entry["path"]) as (fd, leaf):
        atomic_text(fd, leaf, entry[field], entry.get("mode", 0o644))


@contextmanager
def journal_directory(root_fd):
    try:
        os.mkdir(".roger-changes", 0o700, dir_fd=root_fd)
    except FileExistsError:
        pass
    fd = os.open(".roger-changes", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    lock = None
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ChangeError("The rollback folder must be private to this account.")
        lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise ChangeError("The source-change lock is invalid.")
        import fcntl

        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ChangeError("Another source transaction is still running.") from error
        yield fd
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def load_journal(fd):
    try:
        text, mode = regular(fd, "rollback.json", MAX_JOURNAL)
    except FileNotFoundError:
        return None
    if mode & 0o077:
        raise ChangeError("The rollback record must be private.")
    value = json.loads(text)
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or value.get("state") not in {"prepared", "applied", "undone"}
        or not isinstance(value.get("files"), list)
        or not 1 <= len(value["files"]) <= 6
    ):
        raise ChangeError("The existing rollback record is invalid; it was preserved.")
    seen = set()
    for entry in value["files"]:
        safe_path(entry.get("path"))
        if entry["path"] in seen:
            raise ChangeError("The rollback record contains duplicate files.")
        seen.add(entry["path"])
        for key in ("before", "after"):
            if not isinstance(entry.get(key), str) or len(entry[key].encode()) > MAX_FILE:
                raise ChangeError("The rollback content is invalid.")
        if type(entry.get("mode")) is not int or not 0 <= entry["mode"] <= 0o777:
            raise ChangeError("The rollback permissions are invalid.")
    return value


def save_journal(fd, value):
    text = json.dumps(value, ensure_ascii=False)
    if len(text.encode()) > MAX_JOURNAL:
        raise ChangeError("The rollback record is too large.")
    atomic_text(fd, "rollback.json", text)


def recover(root_fd, journal_fd, value):
    if not value or value["state"] != "prepared":
        return value
    # Only states produced by this transaction are repairable automatically.
    for entry in value["files"]:
        current, _ = read_source(root_fd, entry["path"])
        if current not in {entry["before"], entry["after"]}:
            raise ChangeError(
                "Interrupted change conflicts with newer edits. Restore it manually from the rollback record."
            )
    for entry in value["files"]:
        replace_source(root_fd, entry, "before")
    value["state"] = "undone"
    save_journal(journal_fd, value)
    return value


def snapshot(root_fd):
    result = {}
    total = 0
    for name in sorted(ALLOWED):
        try:
            content, _ = read_source(root_fd, name)
        except FileNotFoundError:
            continue
        total += len(content.encode())
        if total > MAX_TOTAL:
            raise ChangeError("The application source context is too large.")
        result[name] = {"content": content, "hash": digest(content)}
    return result


def run(root, action, payload):
    if os.name != "posix":
        raise ChangeError("App source changes currently require macOS or Linux.")
    if not isinstance(payload, dict):
        raise ChangeError("Invalid source change request.")
    with directory(root) as root_fd, journal_directory(root_fd) as journal_fd:
        journal = recover(root_fd, journal_fd, load_journal(journal_fd))
        if action == "snapshot":
            return {"files": snapshot(root_fd)}
        if action == "status":
            return {"canUndo": bool(journal and journal["state"] == "applied")}
        if action == "undo":
            if not journal or journal["state"] != "applied":
                raise ChangeError("There is no applied app change to undo.")
            for entry in journal["files"]:
                current, _ = read_source(root_fd, entry["path"])
                if current != entry["after"]:
                    raise ChangeError(
                        "A changed file has newer edits. Undo stopped without overwriting them."
                    )
            journal["state"] = "prepared"
            save_journal(journal_fd, journal)
            recover(root_fd, journal_fd, journal)
            return {"undone": True}
        if action != "apply":
            raise ChangeError("Unknown source operation.")
        baseline = payload.get("baseline")
        edits = payload.get("files")
        if (
            not isinstance(baseline, dict)
            or not baseline
            or not isinstance(edits, list)
            or not 1 <= len(edits) <= 6
        ):
            raise ChangeError("The source change is invalid.")
        current = snapshot(root_fd)
        if set(current) != set(baseline):
            raise ChangeError("The application source changed. Build a fresh preview.")
        for name, expected in baseline.items():
            safe_path(name)
            if current[name]["hash"] != expected:
                raise ChangeError("The application source changed. Build a fresh preview.")
        files = []
        seen = set()
        for edit in edits:
            name = edit.get("path")
            safe_path(name)
            after = edit.get("after")
            if (
                name in seen
                or name not in current
                or not isinstance(after, str)
                or not after
                or len(after.encode()) > MAX_FILE
            ):
                raise ChangeError("The changed file is invalid or too large.")
            seen.add(name)
            before, mode = read_source(root_fd, name)
            if digest(before) != baseline[name]:
                raise ChangeError("The source changed during validation. Try again.")
            files.append({"path": name, "before": before, "after": after, "mode": mode})
        journal = {"version": 1, "state": "prepared", "files": files}
        save_journal(journal_fd, journal)
        try:
            for entry in files:
                replace_source(root_fd, entry, "after")
            journal["state"] = "applied"
            save_journal(journal_fd, journal)
        except BaseException:
            recover(root_fd, journal_fd, {**journal, "state": "prepared"})
            raise
        return {"applied": True}


def main():
    try:
        if len(sys.argv) != 3:
            raise ChangeError("Supply the application folder and snapshot/status/apply/undo.")
        raw = sys.stdin.buffer.read(MAX_JOURNAL + 1)
        if len(raw) > MAX_JOURNAL:
            raise ChangeError("Source request is too large.")
        result = run(sys.argv[1], sys.argv[2], json.loads(raw or b"{}"))
        print(json.dumps(result, ensure_ascii=False))
    except (ChangeError, OSError, ValueError, TypeError, KeyError) as error:
        message = (
            str(error)
            if isinstance(error, ChangeError)
            else "Source files could not be handled safely. Existing files were preserved."
        )
        print(json.dumps({"error": message}))
        sys.exit(1)


if __name__ == "__main__":
    main()
