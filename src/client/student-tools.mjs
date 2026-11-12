const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const gradePoints = [
  ['A', 4],
  ['A−', 3.67],
  ['B+', 3.33],
  ['B', 3],
  ['B−', 2.67],
  ['C+', 2.33],
  ['C', 2],
  ['C−', 1.67],
  ['D+', 1.33],
  ['D', 1],
  ['D−', 0.67],
  ['F', 0],
];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function bindCalculator(form, calculate) {
  const output = form.querySelector('output');
  form.addEventListener('input', () => (output.value = ''));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    output.value = calculate(form.elements);
  });
}

function mountGpa(form, list, add) {
  function addCourse(focus = false) {
    const index = list.childElementCount + 1;
    const row = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = `Course ${index}`;
    const gradeLabel = document.createElement('label');
    gradeLabel.textContent = 'Letter grade';
    const grade = document.createElement('select');
    grade.add(new Option('Choose grade', ''));
    for (const [letter, points] of gradePoints) grade.add(new Option(letter, String(points)));
    gradeLabel.append(grade);
    const creditLabel = document.createElement('label');
    creditLabel.textContent = 'Credits';
    const credits = document.createElement('input');
    credits.type = 'number';
    credits.min = '0.01';
    credits.step = '0.01';
    creditLabel.append(credits);
    row.append(legend, gradeLabel, creditLabel);
    list.append(row);
    add.disabled = index === 12;
    if (focus) grade.focus();
  }
  addCourse();
  addCourse();
  add.addEventListener('click', () => addCourse(true));
  bindCalculator(form, () => {
    let points = 0;
    let credits = 0;
    for (const row of list.children) {
      const grade = row.querySelector('select');
      const credit = row.querySelector('input');
      if (!grade.value && !credit.value) continue;
      if (!grade.value || !credit.value) {
        (grade.value ? credit : grade).focus();
        return 'Enter both a letter grade and credits for each course you use.';
      }
      points += Number(grade.value) * credit.valueAsNumber;
      credits += credit.valueAsNumber;
    }
    return credits
      ? `${(points / credits).toFixed(2)} estimated GPA across ${percent.format(credits)} credits.`
      : 'Add at least one letter-graded course.';
  });
}

export function mountStudentTools({
  grades,
  items,
  add,
  gpa,
  gpaCourses,
  addGpaCourse,
  target,
  breakEven,
}) {
  mountGpa(gpa, gpaCourses, addGpaCourse);
  bindCalculator(target, ({ average, completed, target }) => {
    const remaining = 100 - completed.valueAsNumber;
    if (!remaining) return 'All course weight has been graded.';
    const needed =
      (target.valueAsNumber * 100 - average.valueAsNumber * completed.valueAsNumber) / remaining;
    if (needed <= 0) return 'Your graded work already covers this target.';
    const required = percent.format(Math.ceil(needed * 100 - 1e-8) / 100);
    return needed > 100 + 1e-8
      ? `You would need ${required}% on the remaining work. That exceeds 100%.`
      : `Aim for ${required}% across the remaining ${percent.format(remaining)}% of the course.`;
  });
  bindCalculator(breakEven, ({ fixed, price, variable }) => {
    const cents = (field) => Math.round(field.valueAsNumber * 100);
    const margin = cents(price) - cents(variable);
    if (margin <= 0) return 'The unit price must exceed the variable cost to cover fixed costs.';
    const units = Math.ceil(cents(fixed) / margin);
    return `Break even at ${units.toLocaleString()} units with ${money.format(margin / 100)} contribution per unit.`;
  });
  const gradesResult = grades.querySelector('output');
  function addGradeItem(focus = false) {
    const index = items.childElementCount + 1;
    const row = document.createElement('fieldset');
    const name = document.createElement('legend');
    name.textContent = `Item ${index}`;
    row.append(name);
    for (const [field, title, min] of [
      ['score', 'Score (%)', '0'],
      ['weight', 'Weight (%)', '0.01'],
    ]) {
      const label = document.createElement('label');
      label.textContent = title;
      const input = document.createElement('input');
      input.type = 'number';
      input.name = `${field}-${index}`;
      input.min = min;
      input.max = '100';
      input.step = '0.01';
      label.append(input);
      row.append(label);
    }
    items.append(row);
    add.disabled = index === 12;
    if (focus) row.querySelector('input').focus();
  }
  addGradeItem();
  addGradeItem();
  add.addEventListener('click', () => addGradeItem(true));
  grades.addEventListener('input', () => (gradesResult.value = ''));
  grades.addEventListener('submit', (event) => {
    event.preventDefault();
    let weightedScore = 0;
    let weightUnits = 0;
    for (const row of items.children) {
      const [score, weight] = row.querySelectorAll('input');
      if (score.value === '' && weight.value === '') continue;
      if (score.value === '' || weight.value === '') {
        gradesResult.value = 'Enter both a score and a weight for each item you use.';
        (score.value === '' ? score : weight).focus();
        return;
      }
      const units = Math.round(weight.valueAsNumber * 100);
      weightUnits += units;
      weightedScore += score.valueAsNumber * units;
    }
    if (!weightUnits || weightUnits > 10000) {
      gradesResult.value = weightUnits
        ? 'Weights cannot add up to more than 100%.'
        : 'Add at least one graded item.';
      return;
    }
    const average = percent.format(weightedScore / weightUnits);
    const coverage = percent.format(weightUnits / 100);
    gradesResult.value = `${average}% average across ${coverage}% of the course weight.`;
  });
}
