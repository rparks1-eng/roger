/** Reviewed, single-use submission drafts. Live writes are off unless explicitly enabled. */
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
const ORIGIN = 'https://babson.instructure.com';
const identifier = (value) => {
  if (!/^[1-9]\d{0,15}$/.test(String(value ?? '')))
    throw new HttpError(400, 'Choose an assignment.');
  return String(value);
};
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function createSubmissionService({
  enabled = false,
  clock = Date.now,
  fetcher = fetch,
  readAssignment,
} = {}) {
  async function transport(token, pathname, { body, signal } = {}) {
    const response = await fetcher(ORIGIN + pathname, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
        : AbortSignal.timeout(12_000),
    });
    if (!response.ok)
      throw new HttpError(
        response.status === 403 ? 403 : 502,
        'Canvas did not confirm this submission. Check Canvas before retrying.',
      );
    if (Number(response.headers.get('content-length')) > 1024 * 1024)
      throw new HttpError(502, 'Canvas returned an oversized receipt.');
    const reader = response.body.getReader();
    let size = 0;
    const parts = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(502, 'Canvas returned an oversized receipt.');
        }
        parts.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(parts).toString());
  }
  function allowed(assignment, type) {
    const locked = assignment.locked ?? assignment.locked_for_user;
    if (locked || assignment.canSubmit === false || assignment.can_submit === false)
      throw new HttpError(409, 'Canvas currently does not allow you to submit this assignment.');
    if (
      assignment.requiresPledge ||
      assignment.academic_integrity_pledge ||
      assignment.groupCategoryId ||
      assignment.group_category_id
    )
      throw new HttpError(409, 'Use Canvas for this assignment’s pledge or group submission.');
    const types = assignment.submissionTypes ?? assignment.submission_types ?? [];
    if (!types.includes(type))
      throw new HttpError(400, 'That submission type is not accepted by this assignment.');
  }
  return {
    async review(session, input, { signal } = {}) {
      if (
        !input ||
        Object.keys(input).some(
          (key) => !['courseId', 'assignmentId', 'type', 'content'].includes(key),
        )
      )
        throw new HttpError(400, 'Check the submission draft.');
      const courseId = identifier(input.courseId),
        assignmentId = identifier(input.assignmentId),
        type = input.type;
      if (
        !['online_text_entry', 'online_url'].includes(type) ||
        typeof input.content !== 'string' ||
        !input.content.trim() ||
        input.content.length > 24_000
      )
        throw new HttpError(400, 'Enter text or a website URL, up to 24,000 characters.');
      const content = input.content.trim();
      let payload;
      if (type === 'online_url') {
        let url;
        try {
          url = new URL(content);
        } catch {
          throw new HttpError(400, 'Enter a complete https:// website URL.');
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new HttpError(400, 'Use an HTTP or HTTPS URL without credentials.');
        payload = { submission_type: type, url: url.href };
      } else
        payload = {
          submission_type: type,
          body: `<p>${escape(content).replaceAll('\n', '<br>')}</p>`,
        };
      const assignment = await readAssignment(session.token, courseId, assignmentId, { signal });
      allowed(assignment, type);
      const draft = {
        id: randomUUID(),
        courseId,
        assignmentId,
        title: assignment.title ?? assignment.name ?? 'Assignment',
        type,
        content,
        payload,
        expires: clock() + 10 * 60_000,
        token: session.token,
      };
      session.submissionDraft = draft;
      return {
        draftId: draft.id,
        title: draft.title,
        courseId,
        assignmentId,
        type,
        content,
        expiresAt: new Date(draft.expires).toISOString(),
        liveEnabled: enabled,
      };
    },
    async commit(session, input, { signal } = {}) {
      if (!enabled)
        throw new HttpError(
          403,
          'Live submissions are not enabled in this local preview. The reviewed draft has not been sent.',
        );
      const draft = session.submissionDraft;
      if (
        !input ||
        Object.keys(input).some((key) => !['draftId', 'confirm'].includes(key)) ||
        input.confirm !== true ||
        !draft ||
        input.draftId !== draft.id ||
        draft.expires < clock() ||
        draft.token !== session.token
      )
        throw new HttpError(
          409,
          'This review expired or changed. Review the exact submission again.',
        );
      // Claim before any asynchronous operation: never retry a potentially accepted write.
      delete session.submissionDraft;
      const token = draft.token;
      const assignment = await readAssignment(token, draft.courseId, draft.assignmentId, {
        signal,
      });
      allowed(assignment, draft.type);
      if (session.token !== token)
        throw new HttpError(409, 'Your Canvas connection changed. Review the submission again.');
      const route = `/api/v1/courses/${draft.courseId}/assignments/${draft.assignmentId}/submissions`;
      let sent;
      try {
        sent = await transport(token, route, { body: { submission: draft.payload }, signal });
      } catch {
        throw new HttpError(
          502,
          'Submission outcome is uncertain. Check Canvas before reviewing or submitting again.',
        );
      }
      let receipt;
      try {
        receipt = await transport(token, route + '/self', { signal });
      } catch {
        throw new HttpError(
          502,
          'The send request completed, but receipt verification failed. Check Canvas; do not blindly retry.',
        );
      }
      if (
        !sent.id ||
        receipt.id !== sent.id ||
        receipt.attempt !== sent.attempt ||
        !receipt.submitted_at ||
        receipt.submission_type !== draft.type ||
        !['submitted', 'graded', 'pending_review'].includes(receipt.workflow_state)
      )
        throw new HttpError(
          502,
          'Canvas accepted the request, but its receipt could not be verified. Check Canvas; do not blindly retry.',
        );
      if (
        String(receipt.assignment_id) !== draft.assignmentId ||
        String(sent.assignment_id) !== draft.assignmentId ||
        (draft.type === 'online_url'
          ? receipt.url !== draft.payload.url || sent.url !== draft.payload.url
          : receipt.body !== draft.payload.body || sent.body !== draft.payload.body)
      )
        throw new HttpError(
          502,
          'The Canvas receipt does not match the reviewed work. Check Canvas; do not blindly retry.',
        );
      return {
        verified: true,
        id: receipt.id,
        attempt: receipt.attempt,
        submittedAt: receipt.submitted_at,
        state: receipt.workflow_state,
      };
    },
  };
}
