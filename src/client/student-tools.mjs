const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function mountStudentTools({ finance, grades, items, add }) {
  const financeResult = finance.querySelector('output');
  finance.addEventListener('input', () => (financeResult.value = ''));
  finance.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = finance.elements;
    const amount = fields.amount.valueAsNumber;
    const rate = fields.rate.valueAsNumber / 1200;
    const months = fields.months.valueAsNumber;
    const growth = Math.log1p(rate) * months;
    if (fields.kind.value === 'loan') {
      const payment = rate === 0 ? amount / months : (amount * rate) / -Math.expm1(-growth);
      financeResult.value = `${money.format(payment)} per month`;
    } else {
      financeResult.value = `${money.format(amount * Math.exp(growth))} after ${months} months`;
    }
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
