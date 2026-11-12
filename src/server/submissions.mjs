/** Reviewed, single-use submission drafts. Live writes are off unless explicitly enabled. */
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
const ORIGIN = 'https://babson.instructure.com';
const ID = /^[1-9]\d{0,15}$/;
const UNCERTAIN =
  'Submission outcome is uncertain. Roger will block another send for this assignment until it can verify the attempt in Canvas.';
const identifier = (value) => {
  if (!ID.test(String(value ?? ''))) throw new HttpError(400, 'Choose an assignment.');
  return String(value);
};
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function journalFor(database) {
  if (!database?.location?.())
    throw new Error('Enabled submissions require a durable local journal.');
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS canvas_submission_journal (
      account_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      previous_id TEXT NOT NULL,
      previous_attempt INTEGER NOT NULL,
      receipt_id TEXT,
      PRIMARY KEY (account_id, course_id, assignment_id)
    ) STRICT;
  `);
  const read = database.prepare(`
    SELECT * FROM canvas_submission_journal
    WHERE account_id = ? AND course_id = ? AND assignment_id = ?
  `);
  const reserve = database.prepare(`
    INSERT INTO canvas_submission_journal
      (account_id, course_id, assignment_id, claim_id, digest, previous_id, previous_attempt)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT count(*) FROM canvas_submission_journal) < 2048
    ON CONFLICT (account_id, course_id, assignment_id) DO UPDATE SET
      claim_id = excluded.claim_id, digest = excluded.digest,
      previous_id = excluded.previous_id, previous_attempt = excluded.previous_attempt,
      receipt_id = NULL
    WHERE canvas_submission_journal.receipt_id IS NOT NULL
      AND canvas_submission_journal.previous_attempt + 1 <= excluded.previous_attempt
      AND canvas_submission_journal.digest <> excluded.digest
  `);
  const verify = database.prepare(`
    UPDATE canvas_submission_journal SET receipt_id = ?
    WHERE account_id = ? AND course_id = ? AND assignment_id = ? AND claim_id = ?
      AND receipt_id IS NULL
  `);
  return {
    read: (scope) => read.get(...scope),
    reserve(scope, claim) {
      // The reservation must be committed on disk before a remote write can start.
      if (database.isTransaction) return false;
      return (
        reserve.run(
          ...scope,
          claim.claim_id,
          claim.digest,
          claim.previous_id,
          claim.previous_attempt,
        ).changes === 1
      );
    },
    verify(scope, claim, receiptId) {
      if (database.isTransaction) return false;
      if (verify.run(receiptId, ...scope, claim.claim_id).changes === 1) return true;
      const current = read.get(...scope);
      return current?.claim_id === claim.claim_id && current.receipt_id === receiptId;
    },
  };
}

const digest = (type, content) =>
  createHash('sha256')
    .update(JSON.stringify([type, content]))
    .digest('hex');

function submissionIdentity(value, [accountId, , assignmentId]) {
  return String(value?.user_id) === accountId && String(value?.assignment_id) === assignmentId;
}

function attempt(value, scope) {
  const id = String(value?.id ?? '');
  const count = value?.attempt ?? 0;
  if (
    !submissionIdentity(value, scope) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (id && !ID.test(id)) ||
    (!id && count !== 0)
  )
    throw new HttpError(502, 'Canvas did not identify the current submission attempt.');
  return { id, attempt: count };
}

function matchesReceipt(value, scope, claim) {
  const type = value?.submission_type;
  const content = type === 'online_url' ? value?.url : value?.body;
  const receiptId = String(value?.id ?? '');
  return (
    submissionIdentity(value, scope) &&
    ID.test(receiptId) &&
    (!claim.previous_id || receiptId === claim.previous_id) &&
    value.attempt === claim.previous_attempt + 1 &&
    Number.isFinite(Date.parse(value.submitted_at)) &&
    ['submitted', 'graded', 'pending_review'].includes(value.workflow_state) &&
    typeof content === 'string' &&
    digest(type, content) === claim.digest
  );
}

export function createSubmissionService({
  enabled = false,
  clock = Date.now,
  fetcher = fetch,
  readAssignment,
  journalDatabase,
} = {}) {
  const journal = enabled ? journalFor(journalDatabase) : null;
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
  function allowed(assignment, type, courseId, assignmentId) {
    if (
      String(assignment?.id) !== assignmentId ||
      (assignment.courseId != null && String(assignment.courseId) !== courseId)
    )
      throw new HttpError(502, 'Canvas returned a different assignment.');
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
  function scopeFor(session, courseId, assignmentId) {
    const account = String(session.profile?.id ?? '');
    if (!ID.test(account) || !session.token)
      throw new HttpError(409, 'Reconnect Canvas before reviewing a live submission.');
    return [account, courseId, assignmentId];
  }
  const routeFor = ([, course, assignment]) =>
    `/api/v1/courses/${course}/assignments/${assignment}/submissions`;
  const readCurrent = (token, scope, signal) =>
    transport(token, `${routeFor(scope)}/${scope[0]}`, { signal });
  async function reconcile(token, scope, claim, { sent, signal } = {}) {
    const receipt = await readCurrent(token, scope, signal);
    if (
      !matchesReceipt(receipt, scope, claim) ||
      (sent != null &&
        (!matchesReceipt(sent, scope, claim) || String(sent.id) !== String(receipt.id)))
    )
      return null;
    if (!journal.verify(scope, claim, String(receipt.id))) return null;
    return {
      verified: true,
      id: receipt.id,
      attempt: receipt.attempt,
      submittedAt: receipt.submitted_at,
      state: receipt.workflow_state,
    };
  }
  function assertAvailable(row, payloadDigest) {
    if (!row) return;
    if (!row.receipt_id) throw new HttpError(409, UNCERTAIN);
    if (row.digest === payloadDigest)
      throw new HttpError(
        409,
        `Canvas already confirmed this work as attempt ${row.previous_attempt + 1}.`,
      );
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
      const token = session.token;
      const scope = enabled ? scopeFor(session, courseId, assignmentId) : null;
      const payloadDigest = digest(type, payload.url ?? payload.body);
      let baseline = null;
      if (scope) {
        const row = journal.read(scope);
        if (row && !row.receipt_id) {
          const receipt = await reconcile(token, scope, row, { signal }).catch(() => null);
          if (!receipt) throw new HttpError(409, UNCERTAIN);
          throw new HttpError(
            409,
            `Canvas confirmed the earlier send as attempt ${receipt.attempt}. Review again if you need to submit different work.`,
          );
        }
        assertAvailable(row, payloadDigest);
        const current = await readCurrent(token, scope, signal);
        baseline = attempt(current, scope);
        if (
          baseline.attempt > 0 &&
          matchesReceipt(current, scope, {
            previous_id: baseline.id,
            previous_attempt: baseline.attempt - 1,
            digest: payloadDigest,
          })
        )
          throw new HttpError(
            409,
            `Canvas already recorded this work as attempt ${baseline.attempt}.`,
          );
      }
      const assignment = await readAssignment(token, courseId, assignmentId, { signal });
      allowed(assignment, type, courseId, assignmentId);
      if (
        session.token !== token ||
        (scope && scopeFor(session, courseId, assignmentId)[0] !== scope[0])
      )
        throw new HttpError(409, 'Your Canvas connection changed. Review the submission again.');
      if (scope) assertAvailable(journal.read(scope), payloadDigest);
      const draft = {
        id: randomUUID(),
        courseId,
        assignmentId,
        title: assignment.title ?? assignment.name ?? 'Assignment',
        type,
        content,
        payload,
        expires: clock() + 10 * 60_000,
        token,
        scope,
        digest: payloadDigest,
        baseline,
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
      allowed(assignment, draft.type, draft.courseId, draft.assignmentId);
      const scope = scopeFor(session, draft.courseId, draft.assignmentId);
      if (session.token !== token || scope[0] !== draft.scope?.[0])
        throw new HttpError(409, 'Your Canvas connection changed. Review the submission again.');
      assertAvailable(journal.read(scope), draft.digest);
      const current = attempt(await readCurrent(token, scope, signal), scope);
      if (
        session.token !== token ||
        scopeFor(session, draft.courseId, draft.assignmentId)[0] !== scope[0] ||
        current.id !== draft.baseline.id ||
        current.attempt !== draft.baseline.attempt
      )
        throw new HttpError(409, 'Canvas changed since this review. Review the submission again.');
      signal?.throwIfAborted();
      const claim = {
        claim_id: draft.id,
        digest: draft.digest,
        previous_id: draft.baseline.id,
        previous_attempt: draft.baseline.attempt,
      };
      if (!journal.reserve(scope, claim))
        throw new HttpError(
          409,
          'The submission journal could not reserve this send. Check Canvas.',
        );
      const sent = await transport(token, routeFor(scope), {
        body: { submission: draft.payload },
        signal,
      }).catch(() => undefined);
      const receipt = await reconcile(token, scope, claim, { sent, signal }).catch(() => null);
      if (!receipt) throw new HttpError(502, UNCERTAIN);
      return receipt;
    },
  };
}
