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


def community_group(raw, cid):
    record(raw)
    if raw.get("context_type") != "Course" or str(raw.get("course_id")) != cid:
        return None
    gid = identifier(raw.get("id"))
    count = raw.get("members_count")
    return dict(
        id=gid,
        name=plain(raw.get("name"), 220) or "Canvas group",
        description=plain(raw.get("description"), 1200),
        memberCount=count if integer(count) and count >= 0 else None,
        url=f"{ORIGIN}/groups/{gid}",
    )


def topic_summary(raw, base, announcement):
    record(raw)
    tid = identifier(raw.get("id"))
    author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
    lock = raw.get("lock_info") if isinstance(raw.get("lock_info"), dict) else {}
    # Canvas can close a topic to posts while explicitly allowing students to read it.
    readable = lock.get("can_view") is True
    return dict(
        id=tid,
        title=plain(raw.get("title"), 300) or "Untitled topic",
        author=plain(author.get("display_name") or raw.get("user_name"), 120),
        postedAt=plain(raw.get("posted_at"), 80),
        locked=raw.get("published") is False
        or (not readable and (raw.get("locked_for_user") is True or lock.get("can_view") is False)),
        lockExplanation=plain(raw.get("lock_explanation"), 800),
        announcement=announcement,
        url=f"{ORIGIN}{base}/discussion_topics/{tid}",
    )


def attachment_links(raw, base):
    files = raw.get("attachments")
    files = files[:20] if isinstance(files, list) else []
    if isinstance(raw.get("attachment"), dict):
        files = [raw["attachment"], *files]
    links = {}
    for file in files:
        if not isinstance(file, dict) or not isinstance(file.get("url"), str):
            continue
        path = file["url"].split("?", 1)[0].split("#", 1)[0].removeprefix(ORIGIN)
        match = re.fullmatch(
            rf"(?:{re.escape(base)})?/files/([1-9]\d{{0,15}})(?:/download)?/?", path
        )
        if not match:
            continue
        href = f"{ORIGIN}{base}/files/{match[1]}"
        links[href] = dict(
            name=plain(file.get("display_name") or file.get("filename"), 220) or "Attachment",
            url=href,
        )
    return list(links.values())


def normalize_topic(raw, value, base, context_code, announcement):
    summary = topic_summary(raw, base, announcement)
    require(
        summary["id"] == identifier(value.get("topicId"))
        and raw.get("context_code") in (None, context_code)
        and (
            not isinstance(raw.get("is_announcement"), bool)
            or raw["is_announcement"] == announcement
        ),
        "invalid_response",
    )
    content = raw.get("message") if isinstance(raw.get("message"), str) else ""
    children = raw.get("group_topic_children")
    return dict(
        **summary,
        bodyHtml="" if summary["locked"] else cut(content, 0, 60000),
        bodyTruncated=not summary["locked"] and units(content) > 60000,
        attachments=[] if summary["locked"] else attachment_links(raw, base),
        repliesRestricted=raw.get("user_can_see_posts") is False,
        initialPostRequired=raw.get("require_initial_post") is True,
        groupDiscussion=bool(raw.get("group_category_id") or children),
        groupChildren=[
            dict(groupId=identifier(child.get("group_id")), topicId=identifier(child.get("id")))
            for child in children[:300]
            if isinstance(child, dict)
        ]
        if isinstance(children, list) and not summary["locked"]
        else [],
    )


def normalize_thread(raw, base):
    participants = raw.get("participants")
    authors = (
        {
            str(person.get("id")): plain(person.get("display_name"), 120)
            for person in participants[:300]
            if isinstance(person, dict)
        }
        if isinstance(participants, list)
        else {}
    )
    roots = raw.get("view")
    require(isinstance(roots, list), "invalid_response")
    index = {}
    replies = []
    partial = False
    remaining_text = 100000

    def append(entry, target, depth):
        nonlocal remaining_text, partial
        if depth > 12 or len(index) >= 300:
            partial = True
            return
        record(entry)
        eid = identifier(entry.get("id"))
        if eid in index:
            return
        deleted = entry.get("deleted") is True or entry.get("workflow_state") == "deleted"
        html = entry.get("message") if isinstance(entry.get("message"), str) and not deleted else ""
        limit = min(20000, remaining_text)
        excerpt = cut(html, 0, limit)
        remaining_text -= units(excerpt)
        partial |= units(html) > limit
        reply = dict(
            id=eid,
            author="" if deleted else authors.get(str(entry.get("user_id")), ""),
            postedAt=plain(entry.get("created_at"), 80),
            deleted=deleted,
            bodyHtml=excerpt,
            attachments=[] if deleted else attachment_links(entry, base),
            replies=[],
        )
        index[eid] = reply, depth
        target.append(reply)
        nested = entry.get("replies")
        if isinstance(nested, list):
            for child in nested:
                append(child, reply["replies"], depth + 1)

    for root in roots:
        append(root, replies, 0)
    if isinstance(raw.get("new_entries"), list):
        for entry in raw["new_entries"]:
            record(entry)
            parent = entry.get("parent_id")
            if parent is None:
                append(entry, replies, 0)
            elif str(parent) in index:
                reply, depth = index[str(parent)]
                append(entry, reply["replies"], depth + 1)
            else:
                partial = True
    return dict(replies=replies, partial=partial)


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
    if operation == "canvas.groups":
        require(isinstance(raw, list) and len(raw) <= 300)
        return list(
            {
                entry["id"]: entry
                for entry in (community_group(item, cid) for item in raw)
                if entry
            }.values()
        )
    gid = identifier(value["groupId"]) if value.get("groupId") else None
    base = f"/groups/{gid}" if gid else f"/courses/{cid}"
    context_code = f"group_{gid}" if gid else f"course_{cid}"
    announcement = value.get("announcement") is True
    if operation == "canvas.topics":
        require(isinstance(raw, list) and len(raw) <= 300)
        return list(
            {
                entry["id"]: entry
                for entry in (
                    topic_summary(item, base, announcement)
                    for item in raw
                    if record(item).get("published") is not False
                    and item.get("context_code") in (None, context_code)
                    and (
                        not isinstance(item.get("is_announcement"), bool)
                        or item["is_announcement"] == announcement
                    )
                )
            }.values()
        )
    if operation == "canvas.topic":
        return normalize_topic(raw, value, base, context_code, announcement)
    if operation == "canvas.thread":
        return normalize_thread(record(raw), base)
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
