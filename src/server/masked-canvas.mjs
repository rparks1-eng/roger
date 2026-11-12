import { HttpError } from './security.mjs';

const assignmentNames = ['Reading response', 'Practice exercise', 'Case analysis', 'Project draft'];
const instructions = 'Review the assigned material and explain your reasoning in a short response.';
const grading = 'Sample grading: projects 45%, practice 35%, participation 20%.';
const officeHours = 'Sample office hours: Tuesdays, 2–3 PM, in the learning commons.';
const materialTypes = new Set(['Assignment', 'Page', 'File', 'ExternalUrl', 'ExternalTool']);
const sourceExcerpt = { grading: [{ excerpt: grading }], officeHours: [{ excerpt: officeHours }] };

// Aliases are scoped to one recording. Only issued aliases can address Canvas.
function aliases() {
  const forward = new Map();
  const reverse = new Map();
  return {
    issue(value) {
      const key = String(value);
      if (!forward.has(key)) {
        const alias = String(forward.size + 1);
        forward.set(key, alias);
        reverse.set(alias, key);
      }
      return forward.get(key);
    },
    resolve(alias) {
      if (!reverse.has(alias)) throw new HttpError(404, 'This recording item is unavailable.');
      return reverse.get(alias);
    },
  };
}

export function createMaskedCanvas({ adapter, connection, now = Date.now }) {
  const courses = aliases();
  const terms = aliases();
  const courseRecords = new Map();
  const scopes = new Map();
  function scope(id) {
    if (!scopes.has(id)) {
      scopes.set(id, {
        assignment: aliases(),
        page: aliases(),
        group: aliases(),
        topic: new Map(),
      });
    }
    return scopes.get(id);
  }
  function course(raw) {
    const id = courses.issue(raw.id);
    const record = {
      id,
      name: `Course ${id}`,
      code: `DEMO${100 + Number(id)}`,
      termId: raw.termId == null ? null : terms.issue(raw.termId),
    };
    courseRecords.set(id, record);
    return record;
  }
  function assignment(raw, courseId) {
    const id = scope(courseId).assignment.issue(raw.id);
    const index = Number(id) - 1;
    const status = ['unsubmitted', 'submitted', 'missing', 'unsubmitted'][index % 4];
    const due = new Date(now());
    due.setHours(23, 59, 0, 0);
    due.setDate(due.getDate() + (status === 'missing' || status === 'submitted' ? -1 : index % 7));
    return {
      id,
      name: `${assignmentNames[index % 4]} ${id}`,
      dueAt: due.toISOString(),
      status,
      submitted: status === 'submitted',
      points: 20,
      locked: false,
      submissionTypes: [],
      canSubmit: false,
      descriptionHtml: `<p>${instructions}</p>`,
    };
  }
  async function syllabus(token, id, signal) {
    const result = await adapter.readCanvasSyllabus(token, courses.resolve(id), { signal });
    return {
      candidates: result.candidates.map((source, index) => {
        // A file match proves discovery. No original bytes, filenames, or text reach the demo.
        const evidence =
          source.kind === 'page'
            ? Object.fromEntries(
                Object.entries(sourceExcerpt).filter(([key]) => source.evidence?.[key]?.length),
              )
            : sourceExcerpt;
        return {
          kind: 'page',
          title: index ? `Syllabus match ${index + 1}` : 'Course syllabus',
          via: source.kind === 'file' ? 'Canvas · document match' : 'Canvas · page match',
          note: 'Canvas found this syllabus. Passages shown here are samples for recording.',
          text:
            Object.values(evidence)
              .flat()
              .map(({ excerpt }) => excerpt)
              .join('\n') ||
            'Canvas found this syllabus source. Its original content is hidden in Demo mode.',
          evidence,
        };
      }),
      coverage: { reasons: [] },
    };
  }
  async function read(url, signal) {
    const { pathname, searchParams: query } = url;
    const token = await connection(signal);
    const options = { signal };
    if (pathname === '/api/canvas/courses') {
      const result = await adapter.listCanvasCourses(token, { ...options, now: now() });
      const inCurrentTerm = (item) => item.termId === result.currentTermId;
      const current = result.courses.filter(inCurrentTerm);
      const other = result.courses.filter((item) => !inCurrentTerm(item));
      return {
        courses: [...current, ...other].map(course),
        terms: result.terms.map(({ id }, index) => ({
          id: terms.issue(id),
          name: `Term ${index + 1}`,
        })),
        currentTermId: result.currentTermId == null ? null : terms.issue(result.currentTermId),
      };
    }
    if (pathname === '/api/canvas/assignments') {
      const ids = query.getAll('courseId');
      if (!ids.length || ids.length > 12) throw new HttpError(400, 'Select up to 12 demo courses.');
      const result = await adapter.listCanvasAssignments(token, ids.map(courses.resolve), options);
      return {
        courses: result.courses.map(({ courseId, assignments, issue }) => {
          const id = courses.issue(courseId);
          return {
            courseId: id,
            assignments: assignments.map((item) => assignment(item, id)),
            ...(issue ? { issue: 'Some assignments are currently unavailable.' } : {}),
          };
        }),
      };
    }
    const id = query.get('courseId') || query.get('id');
    const realId = courses.resolve(id);
    const lookup = scope(id);
    if (pathname === '/api/canvas/course') {
      const result = await adapter.readCanvasCourse(token, realId, options);
      return {
        course: courseRecords.get(id),
        assignments: result.assignments.map((item) => assignment(item, id)),
        modules: result.modules.map((module, index) => ({
          id: String(index + 1),
          name: `Module ${index + 1}`,
          locked: false,
          items: module.items.map((item, itemIndex) => {
            const type = materialTypes.has(item.type) ? item.type : 'Material';
            return {
              id: String(itemIndex + 1),
              title: `${type === 'ExternalUrl' || type === 'ExternalTool' ? 'Resource' : type} ${itemIndex + 1}`,
              type,
              locked: false,
              pageUrl: item.pageUrl ? lookup.page.issue(item.pageUrl) : null,
              assignmentId: item.assignmentId ? lookup.assignment.issue(item.assignmentId) : null,
            };
          }),
        })),
      };
    }
    if (pathname === '/api/canvas/assignment') {
      const result = await adapter.readCanvasAssignment(
        token,
        realId,
        lookup.assignment.resolve(query.get('assignmentId')),
        options,
      );
      return { assignment: assignment(result.assignment, id) };
    }
    if (pathname === '/api/canvas/syllabus') return syllabus(token, id, signal);
    if (pathname === '/api/canvas/page') {
      const alias = query.get('pageUrl');
      await adapter.readCanvasPage(token, realId, lookup.page.resolve(alias), options);
      return { page: { title: `Course page ${alias}`, bodyHtml: `<p>${instructions}</p>` } };
    }
    if (pathname === '/api/canvas/study-assignments') {
      const ids = query.getAll('assignmentId');
      if (!ids.length || ids.length > 5)
        throw new HttpError(400, 'Select up to five demo assignments.');
      const result = await adapter.readCanvasStudyAssignments(
        token,
        realId,
        ids.map(lookup.assignment.resolve),
        options,
      );
      return {
        assignments: result.assignments.map((item) => assignment(item, id)),
        unavailable: result.unavailable.map(lookup.assignment.issue),
      };
    }
    if (pathname === '/api/canvas/community' || pathname === '/api/canvas/topic') {
      const section = query.get('section');
      const groupId = query.get('groupId');
      if (section === 'groups' && !groupId && pathname.endsWith('/community')) {
        const result = await adapter.listCanvasCommunity(token, realId, { section }, options);
        return {
          groups: result.groups.map(({ id }) => {
            const alias = lookup.group.issue(id);
            return { id: alias, name: `Group ${alias}` };
          }),
        };
      }
      if (!['announcements', 'discussions'].includes(section))
        throw new HttpError(400, 'Choose announcements or discussions.');
      const key = `${section}:${groupId || ''}`;
      if (!lookup.topic.has(key)) lookup.topic.set(key, aliases());
      const topics = lookup.topic.get(key);
      const context = { section, groupId: groupId ? lookup.group.resolve(groupId) : null };
      const title = section === 'announcements' ? 'Announcement' : 'Discussion';
      const topic = ({ id }) => {
        const alias = topics.issue(id);
        return { id: alias, title: `${title} ${alias}`, author: 'Course participant' };
      };
      if (pathname.endsWith('/community')) {
        const result = await adapter.listCanvasCommunity(token, realId, context, options);
        return {
          group: groupId ? { id: groupId, name: `Group ${groupId}` } : null,
          topics: result.topics.map(topic),
        };
      }
      const result = await adapter.readCanvasCommunityTopic(
        token,
        realId,
        topics.resolve(query.get('topicId')),
        context,
        options,
      );
      return {
        topic: { ...topic(result.topic), bodyHtml: `<p>${instructions}</p>`, attachments: [] },
        replies: [],
      };
    }
    throw new HttpError(403, 'This Canvas action is unavailable while recording.');
  }
  async function answer({ message, courseId, assignmentId }, signal) {
    const named = /\bcourse\s+(\d+)\b/i.exec(message)?.[1];
    const id = named || courseId;
    const record = courseRecords.get(id);
    if (!record)
      return { text: 'Open a masked course or ask about Course 1 by name.', passages: [] };
    const topic = /office\s*hours/i.test(message)
      ? 'officeHours'
      : /grad|weight/i.test(message)
        ? 'grading'
        : '';
    if (topic) {
      const token = await connection(signal);
      const { candidates } = await syllabus(token, id, signal);
      const match = candidates.find(({ evidence }) => evidence[topic]?.length);
      return match
        ? {
            text: match.evidence[topic][0].excerpt + ' [1]',
            passages: [
              {
                title: match.title,
                section: match.via,
                text: match.evidence[topic][0].excerpt,
                destination: { courseId: id, section: 'syllabus' },
              },
            ],
          }
        : {
            text: 'Canvas did not return a displayable passage for that topic in Demo mode.',
            passages: [],
          };
    }
    if (assignmentId && id === courseId) {
      const url = new URL('http://localhost/api/canvas/assignment');
      url.search = new URLSearchParams({ courseId: id, assignmentId });
      const { assignment: item } = await read(url, signal);
      return {
        text: instructions + ' [1]',
        passages: [
          {
            title: item.name,
            section: 'Masked assignment',
            text: instructions,
            destination: { courseId: id, assignmentId },
          },
        ],
      };
    }
    return {
      text: 'Ask about grading or office hours, or open a masked assignment and ask about its instructions.',
      passages: [],
    };
  }
  return { read, answer };
}
