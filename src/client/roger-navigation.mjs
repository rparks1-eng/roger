const normalized = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const meaningful = (value) =>
  normalized(value)
    .split(' ')
    .filter(
      (word) =>
        word.length > 2 &&
        ![
          'the',
          'and',
          'for',
          'class',
          'course',
          'assignment',
          'about',
          'this',
          'that',
          'open',
          'pull',
          'please',
          'show',
        ].includes(word),
    );
function score(query, item) {
  const name = normalized(item.name);
  const courseCode = String(item.code || '').match(/\b[A-Za-z]{2,5}[ -]?\d{3,5}\b/);
  const code = normalized(courseCode?.[0] || item.code).replaceAll(' ', '');
  if (code && query.replaceAll(' ', '').includes(code)) return 100;
  if (name.length > 3 && ` ${query} `.includes(` ${name} `)) return 90;
  const words = meaningful(name);
  const matches = words.filter((word) => query.split(' ').includes(word)).length;
  return matches >= Math.min(2, words.length) && matches ? (matches / words.length) * 70 : 0;
}
/** Deterministic navigation uses only the connected account's visible index. */
export function resolveNavigation(message, index, current = {}) {
  const query = normalized(message);
  const explicit = /\b(open|show|pull|take|go|bring)\b/.test(query);
  const section = /\bsyllabus\b/.test(query)
    ? 'syllabus'
    : /\b(modules|materials|readings)\b/.test(query)
      ? 'materials'
      : /\bstudy\b/.test(query) && explicit
        ? 'study'
        : 'assignments';
  const courses = (index.courses || [])
    .map((item) => ({ ...item, score: score(query, item) }))
    .filter((item) => item.score)
    .sort((a, b) => b.score - a.score);
  const course = courses[0] && courses[0].score > (courses[1]?.score || 0) ? courses[0] : null;
  const assignments = (index.assignments || [])
    .filter((item) => !course || String(item.courseId) === String(course.id))
    .map((item) => ({ ...item, score: score(query, item) }))
    .filter((item) => item.score)
    .sort((a, b) => b.score - a.score);
  if (assignments[0] && assignments[0].score > (assignments[1]?.score || 0)) {
    const item = assignments[0];
    return {
      target: { courseId: item.courseId, assignmentId: item.id },
      label: item.name,
      explicit,
    };
  }
  if (assignments.length > 1)
    return {
      choices: assignments.slice(0, 8).map((item) => ({
        label: item.name,
        target: { courseId: item.courseId, assignmentId: item.id },
      })),
      explicit,
    };
  if (course) return { target: { courseId: course.id, section }, label: course.name, explicit };
  if (courses.length > 1)
    return {
      choices: courses
        .slice(0, 8)
        .map((item) => ({ label: item.name, target: { courseId: item.id, section } })),
      explicit,
    };
  if (explicit && /\b(this|that|current) (class|course)\b/.test(query) && current.courseId)
    return {
      target: { courseId: current.courseId, section },
      label: current.courseTitle,
      explicit,
    };
  return null;
}
