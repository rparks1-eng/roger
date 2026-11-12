"""Select bounded study passages and verify answers against those passages."""

import re

from common import exact, require
from study import plain

KINDS = ("assignment", "syllabus", "notes", "material")
CHOICE_MODES = ("multiple-choice", "true-false")
LABELS = {
    "assignment": "the assignment",
    "syllabus": "the syllabus",
    "notes": "your notes",
    "material": "the course material",
}
WORD = re.compile(r"[\w’'-]{4,}")
SIGNAL = re.compile(
    r"\b(?:due|submit|include|exam|grade|grading|project|review|must|required)\b|\d\s*%", re.I
)
NUMBER = re.compile(r"\b\d+(?:\.\d+)?\s*%|\b\d{1,2}:\d{2}(?:\s*[ap]m)?\b", re.I)
SPLIT = re.compile(r"\n+|(?<=[.!?])\s+(?=[A-Z])")


def normalized(text):
    return " ".join(text.split()).casefold()


def prepare(value, *, allow_empty=False):
    require(
        exact(value, ["mode", "engine", "sources"])
        or exact(value, ["mode", "engine", "sources", "focus"])
    )
    mode, engine, sources = value["mode"], value["engine"], value["sources"]
    topic = value.get("focus", "")
    require(
        mode in ("flashcards", "practice", *CHOICE_MODES)
        and engine in ("quick", "local")
        and isinstance(sources, list)
        and 0 < len(sources) <= 48
        and isinstance(topic, str)
        and len(topic) <= 200
    )
    groups = {kind: [] for kind in KINDS}
    ids = set()
    total = 0
    for source in sources:
        require(exact(source, ["id", "kind", "text"]))
        sid, kind, text = source["id"], source["kind"], source["text"]
        require(
            isinstance(sid, str)
            and bool(re.fullmatch(r"[a-z0-9-]{1,32}", sid))
            and sid not in ids
            and kind in KINDS
            and isinstance(text, str)
        )
        ids.add(sid)
        total += len(text)
        require(total <= 80_000, "oversized")
        for block in SPLIT.split(text):
            # Long paragraphs are searched throughout, not only their opening line.
            for start in range(0, len(block), 400):
                line = block[start : start + 440].strip()
                if plain(line) and len(line) >= 8 and len(line.split()) >= 2:
                    groups[kind].append(dict(sourceId=sid, kind=kind, quote=line))
    focus = set(WORD.findall(" ".join(p["quote"] for p in groups["assignment"]).casefold()))
    topic_terms = set(re.findall(r"[\w-]{2,}", topic.casefold()))
    for kind, group in groups.items():
        group.sort(
            key=lambda p: (
                -len(topic_terms.intersection(re.findall(r"[\w-]{2,}", p["quote"].casefold()))),
                -len(focus.intersection(WORD.findall(p["quote"].casefold())))
                if kind != "assignment"
                else 0,
                -len(SIGNAL.findall(p["quote"])),
            )
        )
    passages = []
    seen = set()
    for kind in KINDS:
        for item in groups[kind]:
            key = (kind, normalized(item["quote"]))
            if key in seen:
                continue
            seen.add(key)
            passages.append(dict(ref=f"p{len(passages) + 1}", **item))
            if sum(entry["kind"] == kind for entry in passages) == 5:
                break
    if not allow_empty:
        require(bool(passages))
    return dict(mode=mode, engine=engine, passages=passages)


def recall_detail(quote):
    hit = NUMBER.search(quote)
    if hit:
        start, end = hit.span()
    else:
        words = list(re.finditer(r"\S+", quote))
        tail = min(7, max(1, len(words) // 3))
        start, end = words[-tail].start(), len(quote)
    answer = quote[start:end]
    masked = quote[:start] + "____" + quote[end:]
    return answer, masked


def quick_card(passage, mode):
    quote = passage["quote"]
    answer, masked = recall_detail(quote)
    prompt = (
        masked
        if mode == "flashcards"
        else f"What detail completes this passage from {LABELS[passage['kind']]}?\n{masked}"
    )
    return dict(
        prompt=prompt, answer=answer, sourceId=passage["sourceId"], quote=quote, generated=False
    )


def choice_key(value):
    value = normalized(value).strip(" .,!?:;")
    return re.sub(r"\s+%", "%", value)


def answer_type(value):
    if NUMBER.fullmatch(value):
        return "percentage" if value.endswith("%") else "time"
    return "text"


def choice_card(passage, mode, answers, index):
    quote = passage["quote"]
    answer, masked = recall_detail(quote)
    key = choice_key(answer)
    if not key or len(answer) > 100:
        return None
    distractors = [
        value
        for value in answers
        if choice_key(value) != key and choice_key(value) not in choice_key(quote)
    ]
    distractors.sort(key=lambda value: answer_type(value) != answer_type(answer))
    if mode == "multiple-choice":
        if not distractors:
            return None
        options = distractors[:3]
        options.insert(index % (len(options) + 1), answer)
        prompt = f"Which detail completes this passage as written?\n{masked}"
    else:
        is_true = index % 2 == 0 or not distractors
        detail = answer if is_true else distractors[0]
        options = ["True", "False"]
        answer = "True" if is_true else "False"
        prompt = (
            f"True or false: “{detail}” completes the blank in this passage as written.\n{masked}"
        )
    return dict(
        prompt=prompt,
        answer=answer,
        options=options,
        sourceId=passage["sourceId"],
        quote=quote,
        generated=False,
    )


def build(value):
    require(exact(value, ["prepared", "generated"]))
    prepared = value["prepared"]
    require(isinstance(prepared, dict) and isinstance(prepared.get("passages"), list))
    passages = prepared["passages"]
    mode = prepared["mode"]
    answers = {}
    if mode in CHOICE_MODES:
        for passage in passages:
            answer, _ = recall_detail(passage["quote"])
            if choice_key(answer) and len(answer) <= 100:
                answers.setdefault(choice_key(answer), answer)

    def source_card(passage, index):
        if mode in CHOICE_MODES:
            return choice_card(passage, mode, answers.values(), index)
        return quick_card(passage, mode)

    by_ref = {entry["ref"]: entry for entry in passages}
    cards = []
    used = set()
    kinds = set()
    generated = value["generated"]
    if (
        mode not in CHOICE_MODES
        and exact(generated, ["cards"])
        and isinstance(generated["cards"], list)
    ):
        for entry in generated["cards"][:8]:
            if not exact(entry, ["prompt", "answer", "ref"]):
                continue
            if not all(plain(entry[key]) for key in entry):
                continue
            passage = by_ref.get(entry["ref"])
            if (
                not passage
                or entry["ref"] in used
                or len(entry["prompt"]) > 550
                or len(entry["answer"]) > 120
                or normalized(entry["answer"]) not in normalized(passage["quote"])
                or normalized(entry["answer"]) in normalized(entry["prompt"])
            ):
                continue
            used.add(entry["ref"])
            kinds.add(passage["kind"])
            cards.append(
                dict(
                    prompt=entry["prompt"],
                    answer=entry["answer"],
                    sourceId=passage["sourceId"],
                    quote=passage["quote"],
                    generated=True,
                )
            )
            if len(cards) == 2:
                break
    for kind in KINDS:
        if kind in kinds:
            continue
        for passage in passages:
            if passage["kind"] != kind:
                continue
            card = source_card(passage, len(cards))
            if card:
                used.add(passage["ref"])
                cards.append(card)
                break
    for passage in passages:
        if len(cards) >= 6:
            break
        if passage["ref"] not in used:
            card = source_card(passage, len(cards))
            if card:
                cards.append(card)
    require(bool(cards))
    return dict(cards=cards, enhanced=sum(card["generated"] for card in cards))
