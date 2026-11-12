export const demoCourses = [
  {
    name: 'Designing Better Cities',
    code: 'DEMO201',
    alias: 'better cities',
    assignment: 'Neighborhood redesign brief',
    otherAssignments: [
      ['Intersection field notes', 'Record crossing times and sketch a busy intersection.'],
      ['Street design review', 'Compare two street layouts using the criteria in the field guide.'],
      ['Transit map critique', 'Mark three points where a transit map could be clearer.'],
    ],
    instructions:
      'Submit a two-page redesign brief with a labeled street sketch, two observations from your site visit, and one change that improves pedestrian safety.',
    grading:
      'The redesign project counts for 40%, weekly field notes for 30%, and the final presentation for 30%.',
    officeHours: 'Office hours are Tuesdays, 2–3 PM, in Studio 204.',
    reading: 'Street design field guide',
    topic: /\b(pedestrian|crossing|visibility|street|curb)\b/,
    excerpt:
      'Curb extensions shorten the crossing distance and make people waiting to cross more visible to drivers. Compare sight lines from both sides of the street.',
  },
  {
    name: 'Everyday Astronomy',
    code: 'DEMO202',
    alias: 'astronomy',
    assignment: 'Night sky observation log',
    otherAssignments: [
      ['Constellation sketch', 'Sketch one constellation and label its brightest stars.'],
      [
        'Build a seasonal sky map',
        'Mark the horizon, cardinal directions, and three seasonal objects.',
      ],
      [
        'Scale of the solar system',
        'Draw a scale model and explain where you rounded the distances.',
      ],
    ],
    instructions:
      'Record the Moon at the same time on three evenings. For each observation, note the date, time, phase, and direction, and add a sketch.',
    grading: 'Observation logs count for 50%, quizzes for 25%, and the final sky map for 25%.',
    officeHours: 'Office hours are Wednesdays, 11 AM–noon, in Observatory 105.',
    reading: 'A guide to lunar phases',
    topic: /\b(moon|lunar|phase|phases)\b/,
    excerpt:
      'The Moon reflects sunlight. Its phase changes because we see different portions of its sunlit half as it orbits Earth.',
  },
  {
    name: 'The Science of Food',
    code: 'DEMO203',
    alias: 'science of food',
    assignment: 'Kitchen experiment write-up',
    otherAssignments: [
      ['Blind taste test notes', 'Summarize observations from the blind taste test.'],
      ['Heat and texture lab', 'Compare texture at three temperatures and explain your results.'],
      [
        'Recipe variables worksheet',
        'Identify the independent variable and two controls in the sample recipe.',
      ],
    ],
    instructions:
      'Change one variable in a simple recipe. Submit your hypothesis, a table of results, and a paragraph explaining whether the evidence supports your prediction.',
    grading:
      'Kitchen experiments count for 45%, reading checks for 25%, and the final report for 30%.',
    officeHours: 'Office hours are Thursdays, 1–2 PM, in Kitchen Lab 12.',
    reading: 'How browning works',
    topic: /\b(brown|browning|maillard|searing)\b/,
    excerpt:
      'The Maillard reaction occurs when amino acids and reducing sugars react during cooking. Dry surfaces and higher heat generally encourage browning.',
  },
  {
    name: 'Sound and Storytelling',
    code: 'DEMO204',
    alias: 'storytelling',
    assignment: 'Audio story outline',
    otherAssignments: [
      ['Ambient sound walk', 'Record and label three distinct sounds from one location.'],
      [
        'Interview rough cut',
        'Edit a short interview using an introduction, a main clip, and room tone.',
      ],
      ['Listening journal', 'Describe how sound establishes the setting in two scenes.'],
    ],
    instructions:
      'Submit a one-page outline with a hook, three scene beats, and a list of interview clips or ambient sounds you plan to record.',
    grading:
      'The audio story counts for 50%, production exercises for 30%, and peer feedback for 20%.',
    officeHours: 'Office hours are Fridays, 10–11 AM, in Media Studio 3.',
    reading: 'Recording sound on location',
    topic: /\b(ambient|ambience|room tone|background noise)\b/,
    excerpt:
      'Room tone is the background sound of a space when nobody is speaking. Record at least 30 seconds so you can smooth edits between interview clips.',
  },
];

export const demoCourse = (id) => demoCourses[Number(id) - 1];

export function demoAssignment(courseId, index) {
  const course = demoCourse(courseId);
  return index === 1
    ? [course.assignment, course.instructions]
    : course.otherAssignments[index - 2];
}

export function demoPages(course) {
  return [
    {
      pageUrl: 'syllabus',
      title: course.name + ' syllabus',
      paragraphs: [course.grading, course.officeHours],
    },
    { pageUrl: 'review-notes', title: course.reading, paragraphs: [course.excerpt] },
  ];
}

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const includes = (query, phrase) => ` ${query} `.includes(` ${normalize(phrase)} `);

export function answerDemo({ message, courseId, assignmentId }, assignments) {
  const query = normalize(message);
  const topic = (course) => course.topic.test(query) || includes(query, course.reading);
  const named = demoCourses.filter((course) =>
    [
      course.name,
      course.code,
      course.alias,
      course.assignment,
      course.reading,
      ...course.otherAssignments.map(([title]) => title),
    ].some((value) => includes(query, value)),
  );
  const relevant = named.length ? named : demoCourses.filter(topic);
  const active = demoCourse(courseId);
  const course = relevant.length === 1 ? relevant[0] : relevant.length ? null : active;
  const noAnswer = {
    text: 'I couldn’t find that in the demo materials. Try naming a demo course or assignment, or ask about its grading, office hours, or readings.',
    passages: [],
  };
  if (!course) return noAnswer;

  const id = String(demoCourses.indexOf(course) + 1);
  const [syllabus, reading] = demoPages(course);
  const passages = [];
  const cite = (title, section, text, destination) =>
    passages.push({ title, section, text, destination: { courseId: id, ...destination } });
  const lines = [];
  const add = (text) => lines.push(`${text} [${passages.length}]`);
  const grading = /\b(grad(?:e|ing) breakdown|grading|weighted|weights|count toward)\b/.test(query);
  const officeHours = /\b(office hours|meet the instructor)\b/.test(query);
  if (grading || officeHours) {
    const text = [
      ...(grading ? [course.grading] : []),
      ...(officeHours ? [course.officeHours] : []),
    ].join(' ');
    cite(syllabus.title, 'Syllabus', text, { pageUrl: syllabus.pageUrl });
    add(text);
  }

  const due = /\b(due|deadline|when.*submit)\b/.test(query) && !officeHours;
  const points = /\b(points|how much.*worth)\b/.test(query) && !grading;
  const requirements =
    /\b(requirements|instructions|turn in|hand in|what.*(submit|include)|need to do)\b/.test(query);
  const records = assignments(id);
  const namedAssignment = records.find((record) => includes(query, record.name));
  if (due || points || requirements || (!lines.length && namedAssignment)) {
    const selected =
      namedAssignment ||
      (course === active && records.find((record) => record.id === assignmentId)) ||
      records[0];
    const metadata = [];
    if (due) {
      const deadline = new Date(selected.dueAt).toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      metadata.push(`${selected.name} is due ${deadline}.`);
    }
    if (points) metadata.push(`${selected.name} is worth ${selected.points} points.`);
    if (requirements || !metadata.length)
      metadata.push(demoAssignment(id, Number(selected.id.at(-1)))[1]);
    if (metadata.length) {
      const text = metadata.join(' ');
      cite(selected.name, 'Assignment', text, { assignmentId: selected.id });
      add(text);
    }
  }
  if (topic(course) || /\b(reading|reading notes)\b/.test(query)) {
    cite(reading.title, 'Course reading', course.excerpt, { pageUrl: reading.pageUrl });
    add(course.excerpt);
  }
  return lines.length ? { text: lines.join('\n\n'), passages } : noAnswer;
}
