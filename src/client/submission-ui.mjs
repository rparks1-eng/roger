const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
export function mountSubmissionForm({ container, assignment, courseId, api, status }) {
  const panel = el('section');
  panel.className = 'submission-panel';
  panel.append(el('h3', 'Submit your work'));
  const types = (assignment.submissionTypes ?? assignment.submission_types ?? []).filter((type) =>
    ['online_text_entry', 'online_url'].includes(type),
  );
  if (!types.length) {
    panel.append(
      el(
        'p',
        'This assignment needs a file upload, discussion, quiz, or external tool. Those submission flows are not supported here yet.',
      ),
    );
    container.append(panel);
    return;
  }
  const form = el('form'),
    select = el('select');
  select.setAttribute('aria-label', 'Submission type');
  for (const type of types) {
    const option = el('option', type === 'online_text_entry' ? 'Text entry' : 'Website URL');
    option.value = type;
    select.append(option);
  }
  const label = el('label', 'Your work'),
    input = el('textarea');
  input.rows = 7;
  input.required = true;
  input.maxLength = 24000;
  input.setAttribute('aria-label', 'Submission content');
  label.append(input);
  const review = el('button', 'Review submission');
  review.type = 'submit';
  review.className = 'button button-primary';
  const output = el('div');
  output.className = 'submission-review';
  output.setAttribute('aria-live', 'polite');
  form.append(select, label, review);
  panel.append(
    el(
      'p',
      'Nothing is sent when you write or review. Live submission requires a separate confirmation.',
    ),
    form,
    output,
  );
  container.append(panel);
  let generation = 0,
    pending = false;
  const reset = () => {
    generation++;
    output.replaceChildren();
  };
  input.addEventListener('input', reset);
  select.addEventListener('change', reset);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    review.disabled = true;
    const current = ++generation;
    try {
      const draft = await api('/api/canvas/submission/review', {
        body: {
          courseId: String(courseId),
          assignmentId: String(assignment.id),
          type: select.value,
          content: input.value,
        },
      });
      if (current !== generation) return;
      const preview = el('pre', draft.content);
      output.replaceChildren(el('h4', `Review: ${draft.title}`), preview);
      if (!draft.liveEnabled) {
        output.append(
          el(
            'p',
            'Draft reviewed. Nothing has been submitted. Live sending is disabled in this preview until the integration is approved.',
          ),
        );
        return;
      }
      const agree = el('label'),
        checkbox = el('input');
      checkbox.type = 'checkbox';
      agree.append(
        checkbox,
        document.createTextNode(' I approve this exact work being submitted to this assignment.'),
      );
      const send = el('button', 'Confirm and submit to Canvas');
      send.type = 'button';
      send.className = 'button button-primary';
      send.disabled = true;
      checkbox.addEventListener('change', () => (send.disabled = !checkbox.checked));
      output.append(agree, send);
      send.addEventListener(
        'click',
        async () => {
          if (!checkbox.checked || current !== generation) return;
          send.disabled = true;
          input.disabled = true;
          select.disabled = true;
          review.disabled = true;
          try {
            const receipt = await api('/api/canvas/submission/commit', {
              body: { draftId: draft.draftId, confirm: true },
            });
            output.replaceChildren(
              el(
                'p',
                `Canvas confirmed attempt ${receipt.attempt} · ${new Date(receipt.submittedAt).toLocaleString()}`,
              ),
            );
            status('Submission receipt verified with Canvas.');
          } catch (error) {
            output.replaceChildren(el('p', error.message));
            status(error.message);
          } finally {
            input.disabled = false;
            select.disabled = false;
            review.disabled = false;
          }
        },
        { once: true },
      );
    } catch (error) {
      if (current === generation) {
        output.replaceChildren(el('p', error.message));
        status(error.message);
      }
    } finally {
      pending = false;
      review.disabled = false;
    }
  });
}
