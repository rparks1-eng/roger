// TVM and amortization conventions follow the BA II Plus guidebook appendix.
const MAX_MAGNITUDE = 1e100;
const MAX_GROUPS = 24;
const MAX_FREQUENCY = 9999;
const MIN_RATE_LOG = Math.log(Number.EPSILON / 2);
const MAX_RATE_LOG = Math.log(MAX_MAGNITUDE / 100);
const ROOT_TOLERANCE = 2e-13;

function checked(value) {
  if (!Number.isFinite(value) || Math.abs(value) >= MAX_MAGNITUDE)
    throw new RangeError('Result is outside the calculator range.');
  return value === 0 ? 0 : value;
}

function periodLogRate(annualRate, payments, compounds) {
  if (!(payments > 0 && compounds > 0)) throw new RangeError('P/Y and C/Y must be positive.');
  const rate = annualRate / compounds / 100;
  if (rate <= -1) throw new RangeError('Rate per compounding period must exceed −100%.');
  return Math.log1p(rate) * (compounds / payments);
}

function tvmFactors(periods, logRate, beginning) {
  if (logRate === 0) return [1, periods, 1];
  if (logRate > 0) {
    const discount = -periods * logRate;
    const denominator = beginning ? -Math.expm1(-logRate) : Math.expm1(logRate);
    return [1, -Math.expm1(discount) / denominator, Math.exp(discount)];
  }
  const growth = periods * logRate;
  const annuity = Math.expm1(growth) / Math.expm1(logRate);
  return [Math.exp(growth), annuity * (beginning ? Math.exp(logRate) : 1), 1];
}

function sparseTerms(entries) {
  const sums = new Map();
  for (const [exponent, coefficient] of entries)
    sums.set(exponent, (sums.get(exponent) ?? 0) + coefficient);
  return [...sums].filter(([, coefficient]) => coefficient !== 0).sort(([a], [b]) => a - b);
}

function signChanges(terms) {
  let count = 0;
  for (let index = 1; index < terms.length; index++)
    if (Math.sign(terms[index - 1][1]) !== Math.sign(terms[index][1])) count++;
  return count;
}

function polynomialValue(terms, logX) {
  const anchor = terms[logX < 0 ? 0 : terms.length - 1][0];
  let sum = 0;
  let total = 0;
  for (const [exponent, coefficient] of terms) {
    const weighted = coefficient * Math.exp((exponent - anchor) * logX);
    sum += weighted;
    total += Math.abs(weighted);
  }
  return sum / total;
}

function bisect(fn, low, high, sign) {
  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = low + (high - low) / 2;
    if (middle === low || middle === high) break;
    const next = Math.sign(fn(middle));
    if (next === 0) return middle;
    if (next === sign) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// Factoring out the lowest power before differentiating keeps the derivative
// sparse. Its roots split the interval into monotonic pieces, including tangencies.
function logRoots(terms, lower, upper) {
  const changes = signChanges(terms);
  if (!changes) return [];
  const first = terms[0][0];
  const scale = Math.max(...terms.map(([, coefficient]) => Math.abs(coefficient)));
  const derivative =
    changes === 1
      ? []
      : terms
          .slice(1)
          .map(([exponent, coefficient]) => [
            exponent - first,
            (coefficient / scale) * (exponent - first),
          ])
          .filter(([, coefficient]) => coefficient !== 0);
  const stops = [lower, ...logRoots(derivative, lower, upper), upper];
  const fn = (value) => polynomialValue(terms, value);
  const roots = [];
  let left = stops[0];
  let leftValue = fn(left);
  if (Math.abs(leftValue) <= ROOT_TOLERANCE) roots.push(left);
  for (const right of stops.slice(1)) {
    const rightValue = fn(right);
    if (Math.abs(rightValue) <= ROOT_TOLERANCE) roots.push(right);
    else if (Math.abs(leftValue) > ROOT_TOLERANCE && Math.sign(leftValue) !== Math.sign(rightValue))
      roots.push(bisect(fn, left, right, Math.sign(leftValue)));
    left = right;
    leftValue = rightValue;
  }
  return roots;
}

function closestRate(roots, convert, isValid) {
  const rates = roots.filter(isValid).map(convert).filter(Number.isFinite);
  if (!rates.length) throw new RangeError('No solution for these values.');
  return checked(rates.reduce((best, rate) => (Math.abs(rate) < Math.abs(best) ? rate : best)));
}

function solveRate(periods, present, payment, future, payments, compounds, beginning) {
  if (periods <= 0 || (present === 0 && payment === 0 && future === 0))
    throw new RangeError('Enter a positive number of periods and a cash flow.');
  const scale = Math.max(Math.abs(present), Math.abs(payment), Math.abs(future));
  const pv = present / scale;
  const pmt = payment / scale;
  const fv = future / scale;
  const residual = (logRate) => {
    const factors = tvmFactors(periods, logRate, beginning);
    const values = factors.map((factor, index) => factor * [pv, pmt, fv][index]);
    return (
      values.reduce((sum, value) => sum + value, 0) /
      values.reduce((sum, value) => sum + Math.abs(value), 0)
    );
  };
  if (Math.abs(residual(0)) <= ROOT_TOLERANCE) return 0;
  // Multiply the cash-flow equation by (1 − x), x = 1/(1 + period rate),
  // then verify each root against the original equation to discard x = 1.
  const terms = sparseTerms(
    beginning
      ? [
          [0, pv + pmt],
          [1, -pv],
          [periods, fv - pmt],
          [periods + 1, -fv],
        ]
      : [
          [0, pv],
          [1, pmt - pv],
          [periods, fv],
          [periods + 1, -fv - pmt],
        ],
  );
  const ratio = compounds / payments;
  return closestRate(
    logRoots(terms, -(MAX_RATE_LOG - Math.log(compounds)) * ratio, -MIN_RATE_LOG * ratio),
    (logX) => Math.expm1(-logX / ratio) * compounds * 100,
    (logX) => Math.abs(residual(-logX)) <= ROOT_TOLERANCE * 10,
  );
}

function solvePeriods(present, payment, future, logRate, beginning) {
  if (logRate === 0) return -(present + future) / payment;
  const rate = Math.expm1(logRate);
  const timing = beginning && logRate < 0 ? Math.exp(logRate) : 1;
  const factor = beginning && logRate > 0 ? -Math.expm1(-logRate) : rate;
  const denominator = payment * timing + present * factor;
  const numerator = payment * timing - future * factor;
  const relativeChange = (-(present + future) * factor) / denominator;
  const ratioLog =
    Math.abs(relativeChange) < 0.5 ? Math.log1p(relativeChange) : Math.log(numerator / denominator);
  const periods = ratioLog / logRate;
  if (!(periods >= 0)) throw new RangeError('No solution for the number of periods.');
  return periods;
}

export function solveTVM(target, { N, IY, PV, PMT, FV, PY = 1, CY = PY, BGN = false }) {
  const values = { N, IY, PV, PMT, FV };
  if (!Object.hasOwn(values, target)) throw new RangeError('Choose a TVM variable.');
  for (const [name, value] of Object.entries(values)) if (name !== target) checked(value);
  checked(PY);
  checked(CY);
  const logRate = periodLogRate(target === 'IY' ? 0 : IY, PY, CY);
  if (target === 'IY') return solveRate(N, PV, PMT, FV, PY, CY, BGN);
  if (target === 'N') {
    const periods = checked(solvePeriods(PV, PMT, FV, logRate, BGN));
    if (periods < 0) throw new RangeError('No solution for the number of periods.');
    return periods;
  }
  if (N < 0) throw new RangeError('Number of periods must be nonnegative.');
  const factors = tvmFactors(N, logRate, BGN);
  const keys = ['PV', 'PMT', 'FV'];
  const index = keys.indexOf(target);
  if (factors[index] === 0) throw new RangeError('No solution for these values.');
  const remaining = keys.reduce(
    (sum, key, position) => (position === index ? sum : sum + values[key] * factors[position]),
    0,
  );
  return checked(-remaining / factors[index]);
}

function rounded(value, decimals) {
  return Math.sign(value) * Number(Math.abs(value).toFixed(decimals));
}

export function amortize({ IY, PV, PMT, PY = 1, CY = PY, BGN = false }, first, last, decimals = 2) {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last < first ||
    last > MAX_FREQUENCY
  )
    throw new RangeError('Enter payment numbers from 1 to 9,999 in increasing order.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9)
    throw new RangeError('Choose 0–9 decimal places.');
  const rate = checked(Math.expm1(periodLogRate(checked(IY), checked(PY), checked(CY))));
  const payment = rounded(checked(PMT), decimals);
  let balance = rounded(checked(PV), decimals);
  let initialBalance = balance;
  for (let period = 1; period <= last; period++) {
    if (period === first) initialBalance = balance;
    const interest = BGN && period === 1 ? 0 : rounded(rounded(balance * rate, 12), decimals);
    balance = checked(rounded(balance + interest + payment, decimals));
  }
  const PRN = checked(rounded(balance - initialBalance, decimals));
  const INT = checked(rounded((last - first + 1) * payment - PRN, decimals));
  return { BAL: balance, PRN, INT };
}

function flowGroups(flows) {
  if (!Array.isArray(flows) || !flows.length || flows.length > MAX_GROUPS * MAX_FREQUENCY + 1)
    throw new RangeError('Enter CF0 and up to 24 additional cash flows.');
  const groups = [[0, 1, checked(flows[0])]];
  for (let index = 1; index < flows.length;) {
    const first = index;
    const amount = checked(flows[index++]);
    while (index < flows.length && flows[index] === amount) index++;
    groups.push([first, index - first, amount]);
    if (groups.length > MAX_GROUPS + 1) break;
  }
  if (
    groups.slice(1).reduce((count, [, length]) => count + Math.ceil(length / MAX_FREQUENCY), 0) >
    MAX_GROUPS
  )
    throw new RangeError('Enter no more than 24 cash flows with frequencies up to 9,999.');
  return groups;
}

function discountedFlows(groups, logRate, origin, scale) {
  let sum = 0;
  let total = 0;
  for (const [first, length, amount] of groups) {
    if (amount === 0) continue;
    const position = logRate < 0 ? first + length - 1 : first;
    const magnitude = Math.abs(logRate);
    const factor =
      magnitude === 0 ? length : Math.expm1(-magnitude * length) / Math.expm1(-magnitude);
    const weighted = (amount / scale) * Math.exp(-logRate * (position - origin)) * factor;
    sum += weighted;
    total += Math.abs(weighted);
  }
  return { sum, total };
}

export function cashFlowNPV(rate, flows) {
  const groups = flowGroups(flows);
  checked(rate);
  if (rate <= -100) throw new RangeError('Discount rate must exceed −100%.');
  const scale = Math.max(...groups.map(([, , amount]) => Math.abs(amount)));
  if (scale === 0) return 0;
  const logRate = Math.log1p(rate / 100);
  const origin = logRate < 0 ? flows.length - 1 : 0;
  const { sum } = discountedFlows(groups, logRate, origin, scale);
  if (sum === 0) return 0;
  const adjustment = -logRate * origin;
  return checked(
    adjustment > 700
      ? Math.sign(sum) * Math.exp(Math.log(Math.abs(sum)) + Math.log(scale) + adjustment)
      : sum * scale * Math.exp(adjustment),
  );
}

export function cashFlowIRR(flows) {
  const groups = flowGroups(flows);
  const scale = Math.max(...groups.map(([, , amount]) => Math.abs(amount)));
  if (
    scale === 0 ||
    !signChanges(groups.filter(([, , amount]) => amount !== 0).map(([, , amount]) => [0, amount]))
  )
    throw new RangeError('IRR requires both positive and negative cash flows.');
  const valid = (logX) => {
    const { sum, total } = discountedFlows(groups, -logX, logX > 0 ? flows.length - 1 : 0, scale);
    return Math.abs(sum / total) <= ROOT_TOLERANCE * 10;
  };
  if (valid(0)) return 0;
  const terms = sparseTerms(
    groups.flatMap(([first, length, amount]) => [
      [first, amount / scale],
      [first + length, -amount / scale],
    ]),
  );
  return closestRate(
    logRoots(terms, -MAX_RATE_LOG, -MIN_RATE_LOG),
    (logX) => Math.expm1(-logX) * 100,
    valid,
  );
}
