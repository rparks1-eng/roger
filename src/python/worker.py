"""Fixed JSON domain entry point. Operations are allowlisted, never code or paths."""

import json
import re
from xml.etree import ElementTree
from pathlib import Path
import sys

# -I excludes the script directory. Add only this owned source directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DomainError, require
import retrieval
import study
import study_sets
import canvas_records
import syllabus
import exam_plan

LIMITS = {
    "books.opds": 3 * 1024 * 1024,
    "retrieval": 2 * 1024 * 1024,
    "study.prepare": 128 * 1024,
    "study.validate": 256 * 1024,
    "study.route": 4096,
    "study.set.prepare": 384 * 1024,
    "study.set.rank": 384 * 1024,
    "study.set.build": 128 * 1024,
    "study.exam.plan": 1024 * 1024,
    "syllabus.html": 1024 * 1024,
    "syllabus.docx": 3 * 1024 * 1024,
    "syllabus.excerpts": 1024 * 1024,
    **{
        name: 8 * 1024 * 1024
        for name in (
            "canvas.profile",
            "canvas.courses",
            "canvas.course",
            "canvas.assignment",
            "canvas.assignments",
            "canvas.page",
            "canvas.groups",
            "canvas.topics",
            "canvas.topic",
            "canvas.thread",
        )
    },
}


def gutenberg_catalog(value):
    xml = value.get("xml")
    require(isinstance(xml, str) and "<!" not in xml)
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    feed = ElementTree.fromstring(xml)
    require(feed.tag == "{http://www.w3.org/2005/Atom}feed")
    results = []
    for entry in feed.findall("atom:entry", ns)[:12]:
        identifier = entry.findtext("atom:id", "", ns)
        match = re.fullmatch(
            r"https?://www\.gutenberg\.org/ebooks/(\d{1,8})(?:\.opds)?", identifier
        )
        title = entry.findtext("atom:title", "", ns).strip()[:300]
        if match and title:
            results.append(
                {
                    "id": match[1],
                    "title": title,
                    "author": entry.findtext("atom:content", "", ns).strip()[:200],
                }
            )
    return results


def dispatch(operation, value):
    require(operation in LIMITS)
    if operation == "books.opds":
        return gutenberg_catalog(value)
    if operation == "retrieval":
        return retrieval.search(value)
    if operation == "study.prepare":
        return study.prepare(value)
    if operation == "study.validate":
        return study.validate(value)
    if operation == "study.route":
        return study.route(value)
    if operation == "study.set.rank":
        return study_sets.prepare(value, allow_empty=True)
    if operation == "study.set.prepare":
        return study_sets.prepare(value)
    if operation == "study.exam.plan":
        return exam_plan.plan(value)
    if operation == "study.set.build":
        return study_sets.build(value)
    if operation.startswith("syllabus."):
        return syllabus.run(operation, value)
    return canvas_records.normalize(operation, value)


def main():
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    except (ImportError, ValueError, OSError):
        pass
    try:
        operation = sys.argv[1] if len(sys.argv) == 2 else ""
        require(operation in LIMITS)
        data = sys.stdin.buffer.read(LIMITS[operation] + 1)
        require(len(data) <= LIMITS[operation], "oversized")
        value = json.loads(data, parse_constant=lambda _: require(False))
        response = dict(ok=True, result=dispatch(operation, value))
    except DomainError as error:
        response = dict(ok=False, error=str(error))
    except Exception:
        response = dict(ok=False, error="invalid")
    sys.stdout.write(
        json.dumps(response, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    )


if __name__ == "__main__":
    main()
