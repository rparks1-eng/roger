import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSubmissionService } from '../src/server/submissions.mjs';
import { qaScratch } from '../scripts/quality/scratch.mjs';
const assignment = {
  id: '9',
  name: 'Practice',
  submissionTypes: ['online_text_entry', 'online_url'],
  canSubmit: true,
};
const session = () => ({ token: 'synthetic-test-token', profile: { id: '17' } });
const input = {
  courseId: '7',
  assignmentId: '9',
  type: 'online_text_entry',
  content: 'My <own> work\nSecond line',
};
let scratch;
before(async () => {
  scratch = await qaScratch();
});
after(() => scratch?.close());
function journal(t, filename = path.join(scratch.work, `submission-${randomUUID()}.sqlite`)) {
  const database = new DatabaseSync(filename);
  t.after(() => {
    if (database.isOpen) database.close();
  });
  return { database, filename };
}
function fixture({ send, read } = {}) {
  const identity = { id: 12, assignment_id: 9, user_id: '17' };
  let current = { ...identity, attempt: null, workflow_state: 'unsubmitted' };
  let posts = 0;
  return {
    get posts() {
      return posts;
    },
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    async fetcher(url, options) {
      const route = 'https://babson.instructure.com/api/v1/courses/7/assignments/9/submissions';
      assert.equal(url, options.method === 'POST' ? route : route + '/17');
      if (options.method === 'GET') return read ? read(current) : Response.json(current);
      posts++;
      const payload = JSON.parse(options.body).submission;
      const receipt = {
        ...identity,
        ...payload,
        attempt: (current.attempt || 0) + 1,
        workflow_state: 'submitted',
        submitted_at: '2026-10-15T10:00:00Z',
      };
      if (send) return send(receipt, (accepted = receipt) => (current = accepted));
      current = receipt;
      return Response.json(receipt);
    },
  };
}
const liveFixture = (database, fetcher, options = {}) =>
  createSubmissionService({
    enabled: true,
    journalDatabase: database,
    readAssignment: async () => assignment,
    fetcher,
    ...options,
  });

test('submission review escapes text and cannot perform a live write by default', async () => {
  let writes = 0;
  const service = createSubmissionService({
      readAssignment: async () => assignment,
      fetcher: async () => {
        writes++;
        throw new Error('No live request');
      },
    }),
    owner = session();
  const draft = await service.review(owner, input);
  assert.equal(draft.liveEnabled, false);
  assert.equal(draft.content, input.content);
  assert.equal(owner.submissionDraft.payload.body, '<p>My &lt;own&gt; work<br>Second line</p>');
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /not enabled/,
  );
  assert.equal(writes, 0);
  assert.ok(!JSON.stringify(draft).includes(owner.token));
});
test('submission review denies locks, pledges, groups, invalid type and unsafe URLs', async () => {
  for (const extra of [
    { locked: true },
    { requiresPledge: true },
    { groupCategoryId: 3 },
    { canSubmit: false },
  ]) {
    const service = createSubmissionService({
      readAssignment: async () => ({ ...assignment, ...extra }),
    });
    await assert.rejects(service.review(session(), input));
  }
  const service = createSubmissionService({ readAssignment: async () => assignment });
  for (const content of ['javascript:alert(1)', 'https://name:pass@example.com/', 'not a url'])
    await assert.rejects(service.review(session(), { ...input, type: 'online_url', content }));
  await assert.rejects(service.review(session(), { ...input, type: 'online_upload' }));
});
test('the enabled service rejects memory-only or missing journals', () => {
  assert.throws(() => createSubmissionService({ enabled: true }), /durable local journal/);
  const database = new DatabaseSync(':memory:');
  try {
    assert.throws(
      () => createSubmissionService({ enabled: true, journalDatabase: database }),
      /durable local journal/,
    );
  } finally {
    database.close();
  }
});
test('submission commit is a single-use exact reviewed payload with verified readback', async (t) => {
  const canvas = fixture();
  const owner = session();
  const { database } = journal(t);
  const service = liveFixture(database, canvas.fetcher);
  const draft = await service.review(owner, input);
  const receipt = await service.commit(owner, { draftId: draft.draftId, confirm: true });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.attempt, 1);
  assert.equal(canvas.current.body, '<p>My &lt;own&gt; work<br>Second line</p>');
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /expired or changed/,
  );
  await assert.rejects(service.review(owner, input), /already confirmed/);
  assert.equal(canvas.posts, 1);
});
test('expired or reconnected drafts are denied before writes; failed sends are never retried', async (t) => {
  let now = 100;
  const owner = session();
  const canvas = fixture({
    send() {
      throw new Error('Network dropped');
    },
  });
  const { database } = journal(t);
  const service = liveFixture(database, canvas.fetcher, { clock: () => now });
  let draft = await service.review(owner, input);
  now += 600001;
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /expired or changed/,
  );
  assert.equal(canvas.posts, 0);
  draft = await service.review(owner, input);
  owner.token = 'different-token';
  await assert.rejects(service.commit(owner, { draftId: draft.draftId, confirm: true }));
  assert.equal(canvas.posts, 0);
  owner.token = 'synthetic-test-token';
  draft = await service.review(owner, input);
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /uncertain/,
  );
  await assert.rejects(service.review(owner, input), /uncertain/);
  await assert.rejects(service.review(owner, { ...input, content: 'Different work' }), /uncertain/);
  assert.equal(canvas.posts, 1);
  assert.equal(owner.submissionDraft, undefined);
});
test('mismatched receipt cannot be described as verified', async (t) => {
  const owner = session();
  const canvas = fixture({
    send(receipt, accept) {
      accept({ ...receipt, body: 'OTHER WORK' });
      return Response.json(receipt);
    },
  });
  const { database } = journal(t);
  const service = liveFixture(database, canvas.fetcher);
  const draft = await service.review(owner, input);
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /uncertain/,
  );
  await assert.rejects(service.review(owner, input), /uncertain/);
  assert.equal(canvas.posts, 1);
});

test('a lost send and receipt are reconciled on restart without another POST', async (t) => {
  let offline = false;
  let loseFirstResponse = true;
  const canvas = fixture({
    send(receipt, accept) {
      accept();
      if (!loseFirstResponse) return Response.json(receipt);
      offline = true;
      loseFirstResponse = false;
      throw new Error('Accepted, then connection closed');
    },
    read(current) {
      if (offline) throw new Error('Unavailable');
      return Response.json(current);
    },
  });
  const owner = session();
  const { database, filename } = journal(t);
  const service = liveFixture(database, canvas.fetcher);
  const draft = await service.review(owner, input);
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /uncertain/,
  );
  database.close();
  const reopened = journal(t, filename);
  const restarted = liveFixture(reopened.database, canvas.fetcher);
  const reconnected = { ...session(), token: 'newly-connected-synthetic-token' };
  await assert.rejects(restarted.review(reconnected, input), /uncertain/);
  offline = false;
  await assert.rejects(
    restarted.review(reconnected, input),
    /confirmed the earlier send as attempt 1/,
  );
  await assert.rejects(restarted.review(reconnected, input), /already confirmed/);
  assert.equal(canvas.posts, 1);
  const rows = reopened.database.prepare('SELECT * FROM canvas_submission_journal').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receipt_id, '12');
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-token|Second line|body/);
  const next = await restarted.review(reconnected, { ...input, content: 'New work' });
  const verified = await restarted.commit(reconnected, { draftId: next.draftId, confirm: true });
  assert.equal(verified.attempt, 2);
  assert.equal(canvas.posts, 2);
});

test('two browser sessions cannot reserve concurrent sends for the same attempt', async (t) => {
  let complete;
  const hold = new Promise((resolve) => (complete = resolve));
  let notify;
  const started = new Promise((resolve) => (notify = resolve));
  const canvas = fixture({
    async send(receipt, accept) {
      notify();
      await hold;
      accept();
      return Response.json(receipt);
    },
  });
  const a = journal(t);
  const b = journal(t, a.filename);
  const serviceA = liveFixture(a.database, canvas.fetcher);
  const serviceB = liveFixture(b.database, canvas.fetcher);
  const alice = session();
  const otherTab = session();
  const first = await serviceA.review(alice, input);
  const second = await serviceB.review(otherTab, { ...input, content: 'Alternate work' });
  const sending = serviceA.commit(alice, { draftId: first.draftId, confirm: true });
  await started;
  try {
    await assert.rejects(
      serviceB.commit(otherTab, { draftId: second.draftId, confirm: true }),
      /uncertain/,
    );
    assert.equal(canvas.posts, 1);
  } finally {
    complete();
    await sending;
  }
});

test('a changed Canvas attempt invalidates review and an open journal transaction cannot send', async (t) => {
  const owner = session();
  const canvas = fixture();
  const { database } = journal(t);
  const service = liveFixture(database, canvas.fetcher);
  const old = await service.review(owner, input);
  canvas.current = { ...canvas.current, attempt: 1 };
  await assert.rejects(
    service.commit(owner, { draftId: old.draftId, confirm: true }),
    /changed since/,
  );
  const current = await service.review(owner, input);
  database.exec('BEGIN');
  try {
    await assert.rejects(
      service.commit(owner, { draftId: current.draftId, confirm: true }),
      /could not reserve/,
    );
  } finally {
    database.exec('ROLLBACK');
  }
  assert.equal(canvas.posts, 0);
});
