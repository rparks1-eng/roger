"""Bounded PPTX text extraction. Binary stdin, one JSON response, no files/network."""

import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_BYTES = 12 * 1024 * 1024
MAX_XML = 512 * 1024
MAX_TOTAL = 64 * 1024 * 1024
P = {
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
}
A = {
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
}
R = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
}
PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
WARNING = "Slide text only: images, charts, animations and original slide layout are not reproduced. Export to PDF for visual reading and OCR."


class PresentationError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise PresentationError(code)


def tag(element, namespaces, name):
    return element.tag in {"{%s}%s" % (ns, name) for ns in namespaces}


def extract_presentation(data):
    require(isinstance(data, bytes) and 0 < len(data) <= MAX_BYTES, "input")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(0 < len(entries) <= 2048, "archive")
            names = set()
            total = 0
            for entry in entries:
                name = entry.filename
                total += entry.file_size
                require(
                    name not in names
                    and name == entry.orig_filename
                    and not name.startswith("/")
                    and "\\" not in name
                    and not any(part in {".", ".."} for part in name.split("/"))
                    and ":" not in name
                    and not any(ord(c) < 32 for c in name)
                    and total <= MAX_TOTAL,
                    "archive",
                )
                names.add(name)

            def read_xml(name):
                require(name in names, "missing")
                info = archive.getinfo(name)
                require(
                    not info.flag_bits & 1
                    and info.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                    and info.file_size <= MAX_XML,
                    "archive",
                )
                with archive.open(info) as stream:
                    raw = stream.read(MAX_XML + 1)
                require(len(raw) == info.file_size and len(raw) <= MAX_XML, "archive")
                text = raw.decode("utf-8-sig", errors="strict")
                require(not re.search(r"<!DOCTYPE|<!ENTITY", text, re.I), "xml")
                return ET.fromstring(text)

            presentation = read_xml("ppt/presentation.xml")
            relationships = read_xml("ppt/_rels/presentation.xml.rels")
            require(
                tag(presentation, P, "presentation")
                and relationships.tag == "{%s}Relationships" % PACKAGE,
                "slides",
            )
            targets = {}
            for relationship in relationships:
                if relationship.tag != "{%s}Relationship" % PACKAGE:
                    continue
                identifier = relationship.get("Id")
                require(identifier and identifier not in targets, "slides")
                target = relationship.get("Target", "")
                kind = relationship.get("Type", "")
                valid = (
                    relationship.get("TargetMode") != "External"
                    and any(kind == ns + "/slide" for ns in R)
                    and re.fullmatch(r"(?:slides/|/ppt/slides/)slide[0-9]+\.xml", target)
                )
                # Package-absolute OPC targets stay ZIP member names, never
                # filesystem paths. Do not resolve arbitrary relative paths.
                targets[identifier] = (
                    (target[1:] if target.startswith("/ppt/") else "ppt/" + target)
                    if valid
                    else None
                )
            slide_lists = [item for item in presentation if tag(item, P, "sldIdLst")]
            require(len(slide_lists) == 1, "slides")
            slides = []
            for item in slide_lists[0]:
                if tag(item, P, "sldId"):
                    ids = [
                        item.get("{%s}id" % namespace)
                        for namespace in R
                        if item.get("{%s}id" % namespace)
                    ]
                    require(len(ids) == 1 and targets.get(ids[0]), "slides")
                    slides.append(targets[ids[0]])
            require(0 < len(slides) <= 150, "slides")
            pages = []
            total_chars = 0
            for number, name in enumerate(slides, 1):
                slide = read_xml(name)
                require(tag(slide, P, "sld"), "slides")
                paragraphs = []
                for paragraph in slide.iter():
                    if tag(paragraph, A, "p"):
                        text = "".join(
                            (run.text or "") if tag(run, A, "t") else "\n"
                            for run in paragraph.iter()
                            if tag(run, A, "t") or tag(run, A, "br")
                        )
                        if text:
                            paragraphs.append(text)
                text = "\n\n".join(paragraphs)
                # Browser offsets and previous limits use UTF-16 code units.
                total_chars += len(text.encode("utf-16-le")) // 2
                require(total_chars <= 120_000, "text")
                pages.append({"page": number, "text": text})
            return {"kind": "pptx", "layout": "text-only", "pages": pages, "warnings": [WARNING]}
    except PresentationError:
        raise
    except (
        zipfile.BadZipFile,
        KeyError,
        ValueError,
        RuntimeError,
        OSError,
        ET.ParseError,
        UnicodeError,
        NotImplementedError,
        EOFError,
    ):
        raise PresentationError("damaged") from None


def main():
    # Defense in depth on supported Unix hosts. This is not an OS sandbox.
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    except (ImportError, ValueError, OSError):
        pass
    try:
        result = extract_presentation(sys.stdin.buffer.read(MAX_BYTES + 1))
        response = {"ok": True, "result": result}
    except PresentationError as error:
        response = {"ok": False, "error": str(error)}
    except Exception:
        response = {"ok": False, "error": "damaged"}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
