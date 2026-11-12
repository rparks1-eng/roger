"""Normalize untrusted Canvas records. No token, URL fetching or file access."""

import math
import re
from datetime import datetime
from common import require, plain, cut, units, integer

ORIGIN = "https://babson.instructure.com"


def identifier(value):
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        value = int(value)
    result = str(value) if type(value) in (int, str) else ""
    require(bool(re.fullmatch(r"[1-9][0-9]{0,15}", result)), "invalid_id")
    return result


def record(value):
    require(isinstance(value, dict), "invalid_response")
    return value


def course(raw):
    record(raw)
    cid = identifier(raw.get("id"))
    term = raw.get("term")
    return dict(
        id=cid,
        name=plain(raw.get("name") or raw.get("course_code")),
        code=plain(raw.get("course_code"), 100),
        state=plain(raw.get("workflow_state"), 50),
        url=ORIGIN + "/courses/" + cid,
        termId=identifier(term["id"]) if isinstance(term, dict) and term.get("id") else None,
    )


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.timestamp() if result.tzinfo is not None else None
    except (AttributeError, ValueError, OverflowError, OSError):
        return None


def semester_courses(raw, now):
    courses = {}
    terms = {}
    for value in raw:
        if not isinstance(value, dict) or not (value.get("name") or value.get("course_code")):
            continue
        entry = course(value)
        courses[entry["id"]] = entry
        if entry["termId"] is None:
            continue
        term = value["term"]
        terms[entry["termId"]] = dict(
            id=entry["termId"],
            name=plain(term.get("name"), 120) or "Unnamed term",
            start=timestamp(term.get("start_at")),
            end=timestamp(term.get("end_at")),
        )
    ordered = sorted(
        terms.values(),
        key=lambda term: (term["start"] is not None, term["start"] or 0, term["id"]),
        reverse=True,
    )
    current = next(
        (
            term["id"]
            for term in ordered
            if now is not None
            and term["start"] is not None
            and term["end"] is not None
            and term["start"] <= now <= term["end"]
        ),
        None,
    )
    return dict(
        courses=list(courses.values()),
        terms=[dict(id=term["id"], name=term["name"]) for term in ordered],
        currentTermId=current,
    )


def assignment(raw, cid):
    record(raw)
    aid = identifier(raw.get("id"))
    submission = raw.get("submission") if isinstance(raw.get("submission"), dict) else {}
    submitted = submission.get("workflow_state") in ("submitted", "graded", "pending_review")
    if submission.get("excused") is True:
        status = "excused"
    elif submission.get("redo_request") is True:
        status = "redo"
    elif submitted:
        status = "submitted"
    elif submission.get("missing") is True:
        status = "missing"
    elif raw.get("locked_for_user") is True:
        status = "locked"
    elif submission.get("workflow_state") == "unsubmitted":
        status = "unsubmitted"
    else:
        status = "unknown"
    points = raw.get("points_possible")
    return dict(
        id=aid,
        name=plain(raw.get("name")),
        dueAt=plain(raw.get("due_at"), 80) or None,
        points=points if type(points) in (int, float) and math.isfinite(points) else None,
        locked=raw.get("locked_for_user") is True,
        submissionTypes=[
            plain(v, 60) for v in raw.get("submission_types", []) if isinstance(v, str)
        ][:20]
        if isinstance(raw.get("submission_types"), list)
        else [],
        submitted=submitted,
        status=status,
        url=ORIGIN + "/courses/" + cid + "/assignments/" + aid,
    )


def item(raw, cid):
    record(raw)
    iid = identifier(raw.get("id"))
    details = raw.get("content_details") if isinstance(raw.get("content_details"), dict) else {}
    title = plain(raw.get("title"))
    target = plain(raw.get("external_url"), 800)
    item_type = raw.get("type")
    if item_type == "File":
        category = "Videos" if re.search(r"\.(?:mp4|mov|webm|m4v)$", title, re.I) else "Documents"
    elif item_type == "Page":
        category = "Pages"
    elif item_type in ("ExternalUrl", "ExternalTool"):
        category = (
            "Videos"
            if re.search(
                r"youtube\.com|youtu\.be|vimeo\.com|panopto|video", f"{target} {title}", re.I
            )
            else "Links"
        )
    else:
        category = "Other materials"
    return dict(
        id=iid,
        title=title,
        studyCategory=category,
        type=plain(raw.get("type"), 50),
        fileId=identifier(raw["content_id"])
        if raw.get("type") == "File" and raw.get("content_id")
        else None,
        assignmentId=identifier(raw["content_id"])
        if raw.get("type") == "Assignment" and raw.get("content_id")
        else None,
        pageUrl=plain(raw.get("page_url"), 200) if raw.get("type") == "Page" else None,
        locked=raw.get("locked_for_user") is True or details.get("locked_for_user") is True,
        url=ORIGIN + "/courses/" + cid + "/modules/items/" + iid,
    )


def normalize(operation, value):
    require(isinstance(value, dict))
    raw = value.get("raw")
    if operation == "canvas.profile":
        record(raw)
        return dict(id=identifier(raw.get("id")), name=plain(raw.get("name")))
    if operation == "canvas.courses":
        require(isinstance(raw, list) and len(raw) <= 300)
        return semester_courses(raw, timestamp(value.get("now")))
    cid = identifier(value.get("courseId"))
    if operation == "canvas.assignments":
        require(isinstance(raw, list) and len(raw) <= 300)
        return list({entry["id"]: entry for entry in (assignment(v, cid) for v in raw)}.values())
    if operation == "canvas.course":
        require(
            isinstance(value.get("assignments"), list)
            and len(value["assignments"]) <= 300
            and isinstance(value.get("modules"), list)
            and len(value["modules"]) <= 300
        )
        modules = []
        for module in value["modules"]:
            record(module)
            require(isinstance(module.get("items"), list) and len(module["items"]) <= 300)
            modules.append(
                dict(
                    id=identifier(module.get("id")),
                    name=plain(module.get("name")),
                    locked=module.get("state") == "locked" or module.get("locked_for_user") is True,
                    items=[item(v, cid) for v in module["items"]],
                )
            )
        return dict(
            course=course(raw),
            assignments=[assignment(v, cid) for v in value["assignments"]],
            modules=modules,
        )
    record(raw)
    if operation == "canvas.assignment":
        aid = identifier(value.get("assignmentId"))
        require(
            identifier(raw.get("id")) == aid
            and (not raw.get("course_id") or identifier(raw["course_id"]) == cid),
            "invalid_response",
        )
        result = assignment(raw, cid)
        description = raw.get("description") if isinstance(raw.get("description"), str) else ""
        result.update(
            courseId=cid,
            descriptionHtml=cut(description, 0, 120000),
            descriptionTruncated=units(description) > 120000,
            unlockAt=plain(raw.get("unlock_at"), 80) or None,
            lockAt=plain(raw.get("lock_at"), 80) or None,
            lockExplanation=plain(raw.get("lock_explanation"), 1500),
            allowedExtensions=[plain(v, 30) for v in raw.get("allowed_extensions", [])[:30]]
            if isinstance(raw.get("allowed_extensions"), list)
            else [],
            requiresPledge=raw.get("academic_integrity_pledge") is True,
            groupCategoryId=raw.get("group_category_id"),
            submission=None,
        )
        if type(raw.get("can_submit")) is bool:
            result["canSubmit"] = raw["can_submit"]
        if isinstance(raw.get("submission"), dict):
            sub = raw["submission"]
            result["submission"] = dict(
                state=plain(sub.get("workflow_state"), 50),
                submittedAt=plain(sub.get("submitted_at"), 80) or None,
                late=sub.get("late") is True,
                missing=sub.get("missing") is True,
                grade=plain(sub.get("grade"), 100),
                attempt=sub.get("attempt") if integer(sub.get("attempt")) else None,
            )
        return dict(assignment=result)
    if operation == "canvas.page":
        require(raw.get("locked_for_user") is not True, "locked")
        body = raw.get("body") if isinstance(raw.get("body"), str) else ""
        return dict(
            page=dict(
                title=plain(raw.get("title")),
                bodyHtml=cut(body, 0, 120000),
                truncated=units(body) > 120000,
                courseId=cid,
            )
        )
    require(False)
