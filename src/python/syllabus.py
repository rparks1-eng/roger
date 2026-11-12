"""Extract source passages without fetching links or executing document content."""

import base64
import binascii
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from html.parser import HTMLParser

from common import require

MAX_TEXT = 120_000
MAX_XML = 2 * 1024 * 1024
WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TOPICS = {
    "officeHours": re.compile(
        r"\b(?:o\s*(?:f\s*f?\s*|ﬀ\s*)?ice\s+hours?|student\s+hours?|drop[- ]in\s+hours?)\b",
        re.I,
    ),
    "grading": re.compile(
        r"\b(?:grad(?:ing|es?)\s+(?:breakdown|policy|scale|system|criteria|components)|"
        r"(?:course|final)\s+grad(?:e|ing)|course\s+evaluation|assessment\s+(?:weights?|breakdown)|"
        r"(?:your |the )?grade\s+is\s+broken|grading|evaluation criteria)\b"
        r"|^(?:assessment|evaluation)\s*:?$",
        re.I,
    ),
}
HEADING = re.compile(r"^(?:\d+[.)]?\s+)?[A-Z][\w ,/&’'()–-]{2,75}:?$")
SECTION_BREAK = re.compile(
    r"^(?:required (?:texts?|materials?|readings?)|course (?:description|objectives|schedule)|"
    r"learning objectives|academic integrity|attendance policy|contact information|"
    r".{0,60}\buse policy|(?:\d+\s+of\s+\d+|of\s+\d+\s+\d+))\s*:?$",
    re.I,
)
WEIGHT = re.compile(r"\d+(?:\.\d+)?\s*%")


class CourseHtml(HTMLParser):
    breaks = {
        "p",
        "div",
        "li",
        "tr",
        "br",
        "section",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines = []
        self.line = []
        self.links = []
        self.anchor = None
        self.hidden = None

    def newline(self):
        self.lines.append("".join(self.line))
        self.line.clear()

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "template"}:
            self.hidden = tag
        if self.hidden:
            return
        if tag in self.breaks:
            self.newline()
        if tag in {"th", "td"}:
            self.line.append("  ")
        if tag == "a":
            values = dict(attrs)
            self.anchor = [values.get("href") or "", values.get("title") or "", []]

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden:
                self.hidden = None
            return
        if tag == "a" and self.anchor:
            href, title, label = self.anchor
            if href and len(self.links) < 100:
                self.links.append(
                    dict(href=href[:1500], title=title[:300], label="".join(label)[:300])
                )
            self.anchor = None
        if tag in self.breaks:
            self.newline()

    def handle_data(self, data):
        if self.hidden:
            return
        self.line.append(re.sub(r"\s+", " ", data))
        if self.anchor:
            self.anchor[2].append(data)


def parse_html(html):
    require(isinstance(html, str) and len(html) <= MAX_TEXT)
    parser = CourseHtml()
    parser.feed(html)
    parser.close()
    parser.newline()
    return dict(text="\n".join(parser.lines)[:MAX_TEXT], links=parser.links)


def docx_text(encoded):
    require(isinstance(encoded, str) and len(encoded) <= 2_800_000, "oversized")
    try:
        data = base64.b64decode(encoded, validate=True)
        require(len(data) <= MAX_XML, "oversized")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(len(entries) <= 2048, "invalid_document")
            parts = [item for item in entries if item.filename == "word/document.xml"]
            require(len(parts) == 1, "invalid_document")
            part = parts[0]
            require(
                part.file_size <= MAX_XML
                and part.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                "invalid_document",
            )
            with archive.open(part) as stream:
                xml = stream.read(MAX_XML + 1)
        require(
            0 < len(xml) <= MAX_XML
            and b"\x00" not in xml
            and not re.search(rb"<!\s*(?:DOCTYPE|ENTITY)", xml, re.I),
            "invalid_document",
        )
        root = ET.fromstring(xml)
        require(root.tag == WORD + "document", "invalid_document")
        separators = {WORD + "tab": "  ", WORD + "br": "\n", WORD + "cr": "\n"}
        lines = [
            "".join(
                (node.text or "") if node.tag == WORD + "t" else separators.get(node.tag, "")
                for node in para.iter()
            )
            for para in root.iter(WORD + "p")
        ]
        return "\n".join(lines)[:MAX_TEXT]
    except (ET.ParseError, zipfile.BadZipFile, RuntimeError, binascii.Error, ValueError, OSError):
        require(False, "invalid_document")


def excerpts(pages):
    require(isinstance(pages, list) and 0 < len(pages) <= 150)
    results = dict(grading=[], officeHours=[])
    total = 0
    for entry in pages:
        require(isinstance(entry, dict) and isinstance(entry.get("text"), str))
        text = entry["text"]
        total += len(text)
        require(total <= MAX_TEXT, "oversized")
        page = entry.get("page")
        require(page is None or type(page) is int and 1 <= page <= 150)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        for topic, pattern in TOPICS.items():
            candidates = []
            for index, line in enumerate(lines):
                if not pattern.search(line):
                    continue
                window = [line]
                limit = 12 if topic == "grading" else 3
                other = TOPICS["officeHours" if topic == "grading" else "grading"]
                for next_line in lines[index + 1 : index + limit]:
                    if SECTION_BREAK.match(re.sub(r"\s+", " ", next_line)) or other.search(
                        next_line
                    ):
                        break
                    if (
                        topic == "officeHours"
                        and HEADING.match(next_line)
                        and next_line.endswith(":")
                    ):
                        break
                    window.append(next_line)
                quote = "\n".join(window)[:1250]
                score = (
                    2 * bool(re.search(r"\d|appointment|arrangement", quote, re.I))
                    if topic == "officeHours"
                    else 2 * len(WEIGHT.findall(quote))
                )
                candidates.append((score, dict(page=page, excerpt=quote)))
            if candidates:
                results[topic].append(max(candidates, key=lambda item: item[0]))
    return {
        topic: [
            entry
            for score, entry in sorted(items, key=lambda item: -item[0])
            if score or not any(points for points, _ in items)
        ][:3]
        for topic, items in results.items()
    }


def run(operation, value):
    require(isinstance(value, dict))
    if operation == "syllabus.html":
        parsed = parse_html(value.get("html"))
        return {**parsed, "evidence": excerpts([dict(text=parsed["text"])])}
    if operation == "syllabus.docx":
        text = docx_text(value.get("archive"))
        return dict(text=text, evidence=excerpts([dict(text=text)]))
    return excerpts(value.get("pages"))
