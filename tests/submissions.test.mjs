import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionService } from '../src/server/submissions.mjs';
const assignment = {
  id: '9',
  name: 'Practice',
  submissionTypes: ['online_text_entry', 'online_url'],
  canSubmit: true,
};
const session = () => ({ token: 'synthetic-test-token' });
const input = {
  courseId: '7',
  assignmentId: '9',
  type: 'online_text_entry',
  content: 'My <own> work\nSecond line',
};
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
test('submission commit is a single-use exact reviewed payload with verified readback', async () => {
  let sent,
    posts = 0;
  const owner = session();
  const fetcher = async (url, options) => {
    assert.match(
      url,
      /^https:\/\/babson\.instructure\.com\/api\/v1\/courses\/7\/assignments\/9\/submissions/,
    );
    if (options.method === 'POST') {
      posts++;
      sent = JSON.parse(options.body).submission;
    }
    return Response.json({
      id: 12,
      assignment_id: 9,
      attempt: 1,
      submission_type: sent.submission_type,
      body: sent.body,
      workflow_state: 'submitted',
      submitted_at: '2026-10-15T10:00:00Z',
    });
  };
  const service = createSubmissionService({
    enabled: true,
    readAssignment: async () => assignment,
    fetcher,
  });
  const draft = await service.review(owner, input);
  const receipt = await service.commit(owner, { draftId: draft.draftId, confirm: true });
  assert.equal(receipt.verified, true);
  assert.equal(posts, 1);
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /expired or changed/,
  );
  assert.equal(posts, 1);
});
test('expired or reconnected drafts are denied before writes; failed sends are never retried', async () => {
  let now = 100,
    posts = 0;
  const owner = session();
  const service = createSubmissionService({
    enabled: true,
    clock: () => now,
    readAssignment: async () => assignment,
    fetcher: async () => {
      posts++;
      throw new Error('Network dropped');
    },
  });
  let draft = await service.review(owner, input);
  now += 600001;
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /expired or changed/,
  );
  assert.equal(posts, 0);
  draft = await service.review(owner, input);
  owner.token = 'different-token';
  await assert.rejects(service.commit(owner, { draftId: draft.draftId, confirm: true }));
  assert.equal(posts, 0);
  owner.token = 'synthetic-test-token';
  draft = await service.review(owner, input);
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /uncertain/,
  );
  assert.equal(posts, 1);
  assert.equal(owner.submissionDraft, undefined);
});
test('mismatched receipt cannot be described as verified', async () => {
  const owner = session(),
    service = createSubmissionService({
      enabled: true,
      readAssignment: async () => assignment,
      fetcher: async () =>
        Response.json({
          id: 1,
          assignment_id: 9,
          attempt: 1,
          submission_type: 'online_text_entry',
          body: 'OTHER WORK',
          workflow_state: 'submitted',
          submitted_at: '2026-10-15T10:00:00Z',
        }),
    });
  const draft = await service.review(owner, input);
  await assert.rejects(
    service.commit(owner, { draftId: draft.draftId, confirm: true }),
    /does not match/,
  );
});
