"""Keyword passage retrieval over explicitly supplied text, without persistence."""

from collections import Counter
import math
import unicodedata
from common import require, units, cut, trim, integer

LIMITS = dict(
    documents=8,
    documentChars=120000,
    totalChars=480000,
    chunks=600,
    chunkChars=1200,
    overlap=160,
    results=4,
    queryChars=3000,
)
STOP = set(
    "a an and are as at be by do does for from how i in is it me of on or that the this to was were what when where which who why with you your".split()
)


def tokens(value):
    token = []
    for character in value.lower():
        if unicodedata.category(character)[0] in "LN":
            token.append(character)
        elif token:
            yield "".join(token)
            token = []
    if token:
        yield "".join(token)


def label(value, maximum):
    return (
        isinstance(value, str)
        and bool(trim(value))
        and units(value) <= maximum
        and all(ord(c) >= 32 for c in value)
    )


def create_index(documents):
    require(isinstance(documents, list) and len(documents) <= LIMITS["documents"])
    passages, ids, total = [], set(), 0
    for doc in documents:
        require(
            isinstance(doc, dict)
            and label(doc.get("id"), 200)
            and label(doc.get("revision"), 200)
            and label(doc.get("title"), 300)
            and isinstance(doc.get("text"), str)
            and units(doc["text"]) <= LIMITS["documentChars"]
            and doc["id"] not in ids
        )
        ids.add(doc["id"])
        text = doc["text"]
        total += units(text)
        require(total <= LIMITS["totalChars"], "oversized")
        explicit = "pages" in doc and doc["pages"] is not None
        pages = (
            doc.get("pages")
            if explicit
            else ([dict(page=0, start=0, end=units(text))] if text else [])
        )
        require(isinstance(pages, list) and len(pages) <= 1000)
        previous_end, previous_page = 0, -1
        for page in pages:
            require(
                isinstance(page, dict)
                and all(integer(page.get(k)) for k in ("page", "start", "end"))
            )
            number, start, end = page["page"], page["start"], page["end"]
            require(
                number >= (1 if explicit else 0)
                and number > previous_page
                and start >= previous_end
                and not trim(cut(text, previous_end, start))
                and end >= start
                and end <= units(text)
            )
            previous_end, previous_page = end, number
            while start < end:
                finish = min(end, start + LIMITS["chunkChars"])
                excerpt = cut(text, start, finish)
                if trim(excerpt):
                    passages.append(
                        dict(
                            documentId=doc["id"],
                            revision=doc["revision"],
                            title=doc["title"],
                            page=number or None,
                            start=start,
                            end=finish,
                            text=excerpt,
                        )
                    )
                require(len(passages) <= LIMITS["chunks"], "oversized")
                if finish == end:
                    break
                start = finish - LIMITS["overlap"]
        require(not trim(cut(text, previous_end)))
    return dict(method="keyword", passages=passages)


def retrieve(index, query):
    require(isinstance(query, str) and units(query) <= LIMITS["queryChars"] and bool(trim(query)))
    require(
        isinstance(index, dict)
        and index.get("method") == "keyword"
        and isinstance(index.get("passages"), list)
        and len(index["passages"]) <= LIMITS["chunks"]
    )
    passages = index["passages"]
    terms = list(dict.fromkeys(t for t in tokens(query) if t not in STOP))[:64]
    counts = [Counter(tokens(p["text"])) for p in passages]
    weights = {
        term: math.log(1 + len(passages) / (1 + sum(term in count for count in counts)))
        for term in terms
    }
    ranked = []
    for order, passage in enumerate(passages):
        score = sum(weights[t] * min(counts[order].get(t, 0), 3) for t in terms)
        if score > 0:
            ranked.append((score, order, passage))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    result = []
    for _, _, passage in ranked:
        if any(
            p["documentId"] == passage["documentId"]
            and p["start"] < passage["end"]
            and passage["start"] < p["end"]
            for p in result
        ):
            continue
        result.append(dict(passage))
        if len(result) == LIMITS["results"]:
            break
    return dict(method="keyword", state="matched" if result else "no-match", passages=result)


def search(value):
    require(isinstance(value, dict) and set(value) == {"documents", "query"})
    result = retrieve(create_index(value["documents"]), value["query"])
    result["evidenceText"] = "\n\n".join(p["text"] for p in result["passages"])
    return result
