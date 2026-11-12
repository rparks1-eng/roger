"""Explainable syllabus-to-material matching. No invented exam scope or dates."""

import re
from common import require

EXAM = re.compile(
    r"\b(?:final\s+(?:exam(?:ination)?|assessment)|mid[ -]?term(?:\s+exam(?:ination)?)?|exam(?:ination)?\s*(?:[1-9]\d?|[IVX]{1,4}|one|two|three)?|test\s+(?:[1-9]\d?|one|two|three))\b",
    re.I,
)
CHAPTERS = re.compile(
    r"\b(?:chapters?|chs?)\.?\s*(\d{1,2}(?:\s*(?:[-–—]|to|through|,|and|&)\s*\d{1,2})*)", re.I
)
STOP = set(
    "about after again before below chapter chapters class course covered covers coverage during exam examination final from have into material materials midterm notes only other page pages please questions reading readings review section should syllabus test that their these this those through topic topics will with your".split()
)


def string(value, limit):
    require(isinstance(value, str) and len(value) <= limit)
    return value


def label(value):
    value = re.sub(r"\s+", " ", value.lower().strip())
    value = value.replace("examination", "exam").replace("mid-term", "midterm")
    for word, digit in [("one", "1"), ("two", "2"), ("three", "3")]:
        value = re.sub(r"\b" + word + r"\b", digit, value)
    return value


def chapters(text):
    result = set()
    for match in CHAPTERS.finditer(text):
        raw = match[1]
        for span in re.finditer(r"(\d{1,2})\s*(?:[-–—]|to|through)\s*(\d{1,2})", raw):
            start, end = map(int, span.groups())
            if 0 < start <= end <= 60:
                result.update(range(start, end + 1))
        result.update(int(item) for item in re.findall(r"\d{1,2}", raw) if 0 < int(item) <= 60)
    return result


def tokens(text):
    return {word for word in re.findall(r"[a-z]{4,}", text.lower()) if word not in STOP}


def excerpts(pages, title, url):
    results = []
    for page in pages:
        text = page["text"]
        # Keep exact quotes and page numbers. Sentence/newline boundaries prevent
        # one exam's chapter scope being attributed to a different nearby exam.
        for sentence in re.split(r"\n|(?<=[.!?])\s+(?=[A-Z])", text):
            line = sentence.strip()
            if not line:
                continue
            for match in EXAM.finditer(line):
                quote = line[max(0, match.start() - 100) : match.start() + 440].strip()
                results.append(
                    {
                        "label": label(match[0]),
                        "quote": quote,
                        "page": page.get("page"),
                        "title": title,
                        "url": url,
                    }
                )
                if len(results) >= 120:
                    return results
    return results


def course_topics(pages, title, url, materials):
    result = []
    seen = set()
    heading = re.compile(r"^\s*(\d{1,2}(?:\.\d{1,2})?)[.)]?\s+([A-Z][^\n]{3,175})$", re.M)
    for page in pages:
        for match in heading.finditer(page["text"]):
            number, name = match.groups()
            name = name.strip()
            if int(number.split(".")[0]) > 60 or name in seen:
                continue
            words = tokens(name)
            if not words:
                continue
            seen.add(name)
            matching = []
            for material in materials:
                metadata = material["title"] + " " + material.get("module", "")
                if words <= tokens(metadata) or len(words & tokens(metadata)) >= 3:
                    matching.append(material["key"])
            result.append(
                {
                    "name": number + " " + name,
                    "matchedKeys": matching,
                    "citation": {
                        "title": title,
                        "url": url,
                        "page": page.get("page"),
                        "quote": match[0].strip(),
                    },
                }
            )
            if len(result) >= 80:
                return result
    return result


def plan(value):
    require(isinstance(value, dict))
    syllabus = value.get("syllabus", {})
    require(isinstance(syllabus, dict))
    title = string(syllabus.get("title", "Syllabus"), 500)
    url = string(syllabus.get("url", ""), 2000)
    pages = syllabus.get("pages", [])
    require(isinstance(pages, list) and len(pages) <= 150)
    total = 0
    for page in pages:
        require(isinstance(page, dict))
        total += len(string(page.get("text"), 120_000))
        require(page.get("page") is None or type(page["page"]) is int)
    require(total <= 240_000, "oversized")
    materials = value.get("materials", [])
    require(isinstance(materials, list) and len(materials) <= 700)
    keys = set()
    for item in materials:
        require(isinstance(item, dict))
        key = string(item.get("key"), 200)
        require(key not in keys)
        keys.add(key)
        string(item.get("title", ""), 1000)
        string(item.get("module", ""), 1000)
        string(item.get("url", ""), 2000)
        require(type(item.get("available")) is bool)
    topics = course_topics(pages, title, url, materials)
    requested = label(string(value.get("exam", ""), 200))
    evidence = excerpts(pages, title, url)
    labels = list(dict.fromkeys(item["label"] for item in evidence))
    # Generic policy mentions are not a specific exam choice when named exams exist.
    specific = [name for name in labels if name not in ("exam", "exams")]
    labels = specific or labels
    choices = [
        {"label": name, "citations": [item for item in evidence if item["label"] == name][:6]}
        for name in labels
    ]
    chosen = requested if requested in labels else labels[0] if len(labels) == 1 else ""
    unknowns = []
    if requested and requested not in labels:
        unknowns.append(
            "That exam was not identified in the readable syllabus. No exam scope was invented."
        )
    if not chosen:
        unknowns.append(
            "Choose the exam from the syllabus mentions below."
            if choices
            else "No exam was identified in the readable syllabus. Add the instructor's exam guide or announcement."
        )
    relevant = [item for item in evidence if item["label"] == chosen] if chosen else []
    # A quote mentioning multiple differently named exams is ambiguous unless it
    # has one scope; do not silently assign every listed chapter to each exam.
    scopes = []
    for item in relevant:
        mentioned = {label(match[0]) for match in EXAM.finditer(item["quote"])}
        if len(mentioned) == 1 and chapters(item["quote"]):
            scopes.append(item)
    required = set().union(*(chapters(item["quote"]) for item in scopes)) if scopes else set()
    reasons, selected, matched_chapters = [], [], set()
    for item in materials:
        metadata = item.get("title", "") + " " + item.get("module", "")
        item_chapters = chapters(metadata)
        matching = required & item_chapters
        named = chosen and any(label(match[0]) == chosen for match in EXAM.finditer(metadata))
        topical = [cite for cite in relevant if len(tokens(metadata) & tokens(cite["quote"])) >= 2]
        if matching:
            why = (
                "Matches syllabus chapter coverage: " + ", ".join(map(str, sorted(matching))) + "."
            )
            citations = [cite for cite in scopes if matching & chapters(cite["quote"])][:2]
            matched_chapters.update(matching)
        elif named:
            why, citations = "Its title or module names the selected exam.", relevant[:2]
        elif topical:
            why, citations = (
                "Its title shares topic terms with this syllabus passage; relevance is inferred, not confirmed.",
                topical[:2],
            )
        elif (
            not required and chosen and any(item["key"] in topic["matchedKeys"] for topic in topics)
        ):
            matched = [topic for topic in topics if item["key"] in topic["matchedKeys"]]
            why = (
                "Matches a syllabus course topic: "
                + matched[0]["name"]
                + ". This is course coverage, not confirmed exam scope."
            )
            citations = [topic["citation"] for topic in matched[:2]]
        elif not required and chosen:
            why, citations = (
                "Broad review: the syllabus does not state exact chapter coverage, so this available source remains included.",
                relevant[:2],
            )
        else:
            continue
        reasons.append(
            {
                "key": item["key"],
                "title": item["title"],
                "url": item.get("url", ""),
                "available": item["available"],
                "reason": why,
                "citations": citations,
            }
        )
        if item["available"]:
            selected.append(item["key"])
    gaps = []
    for chapter in sorted(required - matched_chapters):
        gaps.append(
            {
                "label": f"Chapter {chapter}",
                "request": f"Add the Chapter {chapter} reading, slides, or your notes; no matching title was found in the course materials.",
                "citations": [cite for cite in scopes if chapter in chapters(cite["quote"])][:2],
            }
        )
    for item in reasons:
        if not item["available"]:
            gaps.append(
                {
                    "label": item["title"],
                    "request": f"Add notes, a readable document, or a transcript for {item['title']}; Roger cannot currently read this item.",
                    "citations": item["citations"],
                }
            )
    if chosen and not required:
        unknowns.append(
            "Exact chapter coverage is not stated in an unambiguous exam passage. All readable materials are included as broad review; confirm the instructor's exam guide."
        )
    if chosen and not selected:
        unknowns.append(
            "No readable source matched this exam. Add the named missing readings or select additional sources manually."
        )
    unknowns.append(
        "Exam dates, location and permitted materials are not inferred from topic matches. Check the cited syllabus and current Canvas announcements."
    )
    return {
        "exam": chosen,
        "choices": choices,
        "selectedKeys": selected,
        "reasons": reasons,
        "gaps": gaps,
        "unknowns": unknowns,
        "scopeCitations": (scopes or relevant)[:6],
        "basis": "syllabus chapter and title matching",
        "courseTopics": topics,
    }
