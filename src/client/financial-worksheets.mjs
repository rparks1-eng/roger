// Worksheet math and entry order follow the Texas Instruments BA II Plus Guidebook.
const DAY = 86_400_000;
const DEFAULT_DATE = Date.UTC(1990, 11, 31);
const MIN_DATE = Date.UTC(1980, 0, 1);
const MAX_DATE = Date.UTC(2079, 11, 31);
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const countMethods = ['ACT', '360'];

function check(condition, message = 'Invalid worksheet value.') {
  if (!condition) throw new RangeError(message);
}

function number(value) {
  check(Number.isFinite(value) && Math.abs(value) < 1e100, 'Worksheet result is out of range.');
  return Object.is(value, -0) ? 0 : value;
}

function field(key, label = key, details = {}) {
  return { key, label, ...details };
}

const auto = (key, label) => field(key, label, { auto: true, readOnly: true });
const select = (key, options) => field(key, key, { options });
const dateField = (key, label) => field(key, label, { date: true });

function calendarParts(stamp) {
  const date = new Date(stamp);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

function decodeDate(value, european) {
  const fixed = Math.round(value * 10_000);
  check(
    Math.abs(fixed - value * 10_000) < 1e-7 && value > 0,
    'Enter a date as MM.DDYY or DD.MMYY.',
  );
  const leading = Math.trunc(fixed / 10_000);
  const trailing = Math.trunc(fixed / 100) % 100;
  const month = european ? trailing : leading;
  const day = european ? leading : trailing;
  const year = (fixed % 100 < 80 ? 2000 : 1900) + (fixed % 100);
  const stamp = Date.UTC(year, month - 1, day);
  const [actualYear, actualMonth, actualDay] = calendarParts(stamp);
  check(
    year === actualYear && month === actualMonth && day === actualDay,
    'Invalid calendar date.',
  );
  return stamp;
}

function formatDate(stamp, european) {
  const [year, month, day] = calendarParts(stamp);
  const [first, second] = european ? [day, month] : [month, day];
  const padded = String(second).padStart(2, '0');
  return {
    value: first + (second * 100 + (year % 100)) / 10_000,
    display: `${first}-${padded}-${year}`,
  };
}

function dayCount(start, end, method) {
  if (method === 'ACT') return (end - start) / DAY;
  if (start > end) return -dayCount(end, start, method);
  const [year1, month1, day1] = calendarParts(start);
  const [year2, month2, day2] = calendarParts(end);
  return (
    (year2 - year1) * 360 +
    (month2 - month1) * 30 +
    (day1 >= 30 ? Math.min(day2, 30) : day2) -
    Math.min(day1, 30)
  );
}

function worksheet(
  title,
  defaults,
  fields,
  { solve, validate, reset, european, enterOption, display } = {},
) {
  const values = { ...defaults };
  const definitions = () => (typeof fields === 'function' ? fields(values) : fields);
  const lookup = (key) => definitions().find((row) => row.key === key);
  return {
    title,
    rows() {
      return definitions().map((row) => {
        const { key } = row;
        if (row.auto) {
          try {
            return { ...row, value: number(solve(key, values)) };
          } catch {
            return { ...row, value: null };
          }
        }
        if (row.date)
          return { ...row, ...formatDate(values[key], european()), ...display?.(key, values) };
        return { ...row, value: values[key], ...display?.(key, values) };
      });
    },
    write(key, value) {
      const row = lookup(key);
      check(row && !row.readOnly, 'This worksheet value cannot be entered.');
      if (row.options) {
        check(row.editable && enterOption, 'Use 2nd SET to change this setting.');
        enterOption(values, number(value));
        return;
      }
      const result = row.date ? decodeDate(value, european()) : number(value);
      validate?.(key, result);
      values[key] = result;
    },
    compute(key) {
      const row = lookup(key);
      check(row?.auto || row?.compute, 'This worksheet value cannot be computed.');
      const result = number(solve(key, values));
      if (row.date) {
        check(result >= MIN_DATE && result <= MAX_DATE, 'Date outside 1980–2079.');
        values[key] = result;
        return formatDate(result, european()).value;
      }
      if (!row.auto) values[key] = result;
      return result;
    },
    toggle(key) {
      const options = lookup(key)?.options;
      check(options?.length, 'Use ENTER to store this value.');
      values[key] = options[(options.indexOf(values[key]) + 1) % options.length];
      return values[key];
    },
    clear(all = false) {
      const next = reset?.(values, all) ?? defaults;
      Object.assign(values, next);
    },
  };
}

const computable = (key, label, more) => field(key, label, { compute: true, ...more });

function createDate(european) {
  let computedDate = '';
  return worksheet(
    'Date',
    { DT1: DEFAULT_DATE, DT2: DEFAULT_DATE, DBD: 0, BASIS: 'ACT' },
    [
      computable('DT1', 'Date 1', { date: true }),
      computable('DT2', 'Date 2', { date: true }),
      computable('DBD', 'Days between dates'),
      select('BASIS', countMethods),
    ],
    {
      european,
      reset: (_values, all) => {
        computedDate = '';
        if (!all) return { DT1: DEFAULT_DATE, DT2: DEFAULT_DATE, DBD: 0 };
        return undefined;
      },
      validate: (key, value) => {
        if (key === 'DBD') check(Number.isInteger(value), 'Enter a whole number of days.');
        computedDate = '';
      },
      solve(key, v) {
        if (key === 'DBD') return dayCount(v.DT1, v.DT2, v.BASIS);
        check(v.BASIS === 'ACT', 'Date calculation requires ACT day count.');
        computedDate = key;
        return key === 'DT1' ? v.DT2 - v.DBD * DAY : v.DT1 + v.DBD * DAY;
      },
      display(key, v) {
        if (key === computedDate) {
          const label = WEEKDAYS[new Date(v[key]).getUTCDay()];
          return { display: formatDate(v[key], european()).display + ' ' + label };
        }
        return undefined;
      },
    },
  );
}

function previousCoupon(redemption, periods, frequency) {
  const [year, month, day] = calendarParts(redemption);
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const targetMonth = month - periods * (12 / frequency);
  const last = endOfMonth(year, targetMonth);
  return Date.UTC(
    year,
    targetMonth - 1,
    day === endOfMonth(year, month) ? last : Math.min(day, last),
  );
}

function bondSchedule({ SDT, CPN, RDT, RV, BASIS, FREQ }) {
  check(RDT > SDT, 'Redemption must follow settlement.');
  const frequency = FREQ === '2/Y' ? 2 : 1;
  const coupon = CPN / frequency;
  let remaining = 0;
  let next = RDT;
  let previous = next;
  while (previous > SDT) {
    next = previous;
    previous = previousCoupon(RDT, ++remaining, frequency);
  }
  const period = dayCount(previous, next, BASIS);
  const accruedFraction = dayCount(previous, SDT, BASIS) / period;
  const untilNext = dayCount(SDT, next, BASIS) / period;
  const accrued = coupon * accruedFraction;
  const price = (yieldRate) => {
    const rate = yieldRate / (frequency * 100);
    check(rate > -1, 'Yield is outside the coupon period domain.');
    if (remaining === 1) return (RV + coupon) / (1 + rate * untilNext) - accrued;
    const growth = Math.log1p(rate);
    let present = RV * Math.exp(-(remaining - 1 + untilNext) * growth);
    for (let k = 0; k < remaining; k++) present += coupon * Math.exp(-(k + untilNext) * growth);
    return present - accrued;
  };
  return { frequency, coupon, accrued, untilNext, remaining, price };
}

function createBond(european) {
  return worksheet(
    'Bond',
    {
      SDT: DEFAULT_DATE,
      CPN: 0,
      RDT: DEFAULT_DATE,
      RV: 100,
      BASIS: 'ACT',
      FREQ: '2/Y',
      YLD: 0,
      PRI: 0,
    },
    [
      dateField('SDT', 'Settlement date'),
      field('CPN', 'Annual coupon rate'),
      dateField('RDT', 'Redemption date'),
      field('RV', 'Redemption value'),
      select('BASIS', countMethods),
      select('FREQ', ['2/Y', '1/Y']),
      computable('YLD', 'Yield to redemption'),
      computable('PRI', 'Price per 100'),
      auto('AI', 'Accrued interest'),
    ],
    {
      european,
      validate(key, value) {
        if (['CPN', 'RV', 'PRI'].includes(key))
          check(value >= 0, 'Enter a nonnegative bond value.');
      },
      solve(key, v) {
        const { price, accrued, coupon, untilNext, remaining, frequency } = bondSchedule(v);
        if (key === 'AI') return accrued;
        if (key === 'PRI') return price(v.YLD);
        check(
          v.PRI + accrued > 0 && v.RV + coupon > 0,
          'Enter a positive bond price before computing yield.',
        );
        if (remaining === 1) {
          check(untilNext > 0, 'Yield is undefined on the settlement date.');
          const rate = ((v.RV + coupon) / (v.PRI + accrued) - 1) / untilNext;
          check(rate > -1, 'Yield is outside the coupon period domain.');
          return rate * frequency * 100;
        }
        let low = -frequency * 100 + 1e-8;
        let high = 100;
        while (price(high) > v.PRI && high < 1e10) high *= 2;
        check(price(low) >= v.PRI && price(high) <= v.PRI, 'No bond yield for this price.');
        for (let index = 0; index < 120; index++) {
          const mid = (low + high) / 2;
          if (price(mid) > v.PRI) low = mid;
          else high = mid;
        }
        return (low + high) / 2;
      },
    },
  );
}

function depreciation(v, decimals) {
  const { METHOD, LIF, M01, DT1, CST, SAL, YR } = v;
  check(CST >= SAL, 'Salvage value cannot exceed cost.');
  const factor = 10 ** Math.max(0, Math.min(9, decimals));
  const round = (value) => Math.round(value * factor + Number.EPSILON * value * factor) / factor;
  const life = METHOD === 'SL' || METHOD === 'SLF' ? LIF : Math.trunc(LIF);
  const startYear = new Date(DT1).getUTCFullYear();
  const first =
    METHOD === 'SLF'
      ? dayCount(DT1, Date.UTC(startYear + 1, 0, 1), '360') / 360
      : (13 - (METHOD === 'DBF' ? Math.trunc(M01) : M01)) / 12;
  const base = round(CST) - round(SAL);
  const last = Math.ceil(life + 1 - first - 1e-10);
  let balance = base;
  let expense = 0;
  for (let year = 1; year <= Math.min(YR, last); year++) {
    const fraction = year === 1 ? first : 1;
    const remainingLife = life - (year === 1 ? 0 : first + year - 2);
    const straight = base / life;
    if (year === last) expense = balance;
    else if (METHOD === 'SL' || METHOD === 'SLF') expense = straight * fraction;
    else if (METHOD === 'SYD')
      expense = (remainingLife * (year === 1 ? fraction : 1) * base) / ((life * (life + 1)) / 2);
    else {
      let annual = ((balance + round(SAL)) * v[METHOD]) / (life * 100);
      if (METHOD === 'DBX' || METHOD === 'DBF') annual = Math.max(annual, balance / remainingLife);
      expense = Math.min(annual, balance) * fraction;
    }
    expense = Math.min(balance, round(expense));
    balance = round(balance - expense);
  }
  return { DEP: YR > last ? 0 : expense, RBV: round(balance + round(SAL)), RDV: balance };
}

function createDepreciation(european, europeanNumber, decimals) {
  const reset = { LIF: 1, YR: 1, CST: 0, SAL: 0 };
  return worksheet(
    'Depreciation',
    {
      ...reset,
      METHOD: 'SL',
      M01: 1,
      DT1: DEFAULT_DATE,
      DB: 200,
      DBX: 200,
      DBF: 200,
    },
    ({ METHOD }) => [
      field('METHOD', METHOD.startsWith('DB') ? METHOD : 'Method', {
        options:
          european() || europeanNumber()
            ? ['SL', 'SYD', 'DB', 'DBX', 'SLF', 'DBF']
            : ['SL', 'SYD', 'DB', 'DBX'],
        editable: METHOD.startsWith('DB'),
      }),
      field('LIF', 'Asset life in years'),
      field('M01', 'Starting month'),
      ...(METHOD === 'SLF' ? [dateField('DT1', 'Starting date')] : []),
      field('CST', 'Cost'),
      field('SAL', 'Salvage'),
      computable('YR', 'Year to compute'),
      auto('DEP', 'Depreciation'),
      auto('RBV', 'Remaining book value'),
      auto('RDV', 'Remaining depreciable value'),
    ],
    {
      european,
      reset: (_values, all) => (all ? undefined : reset),
      enterOption(v, value) {
        check(value > 0, 'Enter a positive declining-balance percentage.');
        v[v.METHOD] = value;
      },
      display(key, v) {
        if (key === 'METHOD' && v.METHOD.startsWith('DB')) return { display: v[v.METHOD] };
        return undefined;
      },
      validate(key, value) {
        if (key === 'LIF')
          check(value > 0 && value <= 10_000, 'Enter an asset life up to 10,000 years.');
        if (key === 'M01')
          check(value >= 1 && value < 13, 'Starting month must be from 1 to less than 13.');
        if (key === 'YR')
          check(Number.isInteger(value) && value > 0, 'Enter a positive whole year.');
        if (key === 'CST' || key === 'SAL') check(value >= 0, 'Enter a nonnegative asset value.');
      },
      solve(key, v) {
        if (key === 'YR') return v.YR + 1;
        if (v.METHOD !== 'SL' && v.METHOD !== 'SLF')
          check(Number.isInteger(v.LIF), 'This depreciation method requires a whole-year life.');
        return depreciation(v, decimals())[key];
      },
    },
  );
}

function summarize(values, weights) {
  const n = weights.reduce((sum, value) => sum + value, 0);
  check(n > 0, 'Enter at least one observation.');
  const sum = values.reduce((total, value, index) => total + value * weights[index], 0);
  const mean = sum / n;
  const sumSquares = values.reduce((total, value, index) => total + value ** 2 * weights[index], 0);
  const squares = values.reduce(
    (total, value, index) => total + (value - mean) ** 2 * weights[index],
    0,
  );
  return {
    n,
    sum,
    mean,
    sumSquares,
    squares,
    sample: n > 1 ? Math.sqrt(squares / (n - 1)) : NaN,
    population: Math.sqrt(squares / n),
  };
}

function statistics(points, model) {
  const oneVariable = model === '1-V';
  const logX = model === 'Ln' || model === 'PWR';
  const logY = model === 'EXP' || model === 'PWR';
  const x = points.map(([x]) => (logX ? Math.log(x) : x));
  const y = points.map(([, y]) => (logY ? Math.log(y) : y));
  const weights = oneVariable ? y : x.map(() => 1);
  check(
    weights.every((value) => Number.isInteger(value) && value >= 0),
    'Enter whole-number frequencies in 1-V mode.',
  );
  check(
    x.every(Number.isFinite) && y.every(Number.isFinite),
    'Regression requires positive values on its logarithmic axes.',
  );
  const sx = summarize(x, weights);
  const result = {
    n: sx.n,
    XBAR: sx.mean,
    Sx: sx.sample,
    sx: sx.population,
    SUMX: sx.sum,
    SUMX2: sx.sumSquares,
  };
  if (oneVariable) return result;
  const sy = summarize(y, weights);
  const covariance = x.reduce(
    (sum, value, index) => sum + (value - sx.mean) * (y[index] - sy.mean),
    0,
  );
  const slope = covariance / sx.squares;
  const intercept = sy.mean - slope * sx.mean;
  return {
    ...result,
    YBAR: sy.mean,
    Sy: sy.sample,
    sy: sy.population,
    a: logY ? Math.exp(intercept) : intercept,
    b: model === 'EXP' ? Math.exp(slope) : slope,
    r: covariance / Math.sqrt(sx.squares * sy.squares),
    SUMY: sy.sum,
    SUMY2: sy.sumSquares,
    SUMXY: x.reduce((sum, value, index) => sum + value * y[index], 0),
    predictX(value) {
      const transformed = ((logY ? Math.log(value) : value) - intercept) / slope;
      return logX ? Math.exp(transformed) : transformed;
    },
    predictY(value) {
      const transformed = intercept + slope * (logX ? Math.log(value) : value);
      return logY ? Math.exp(transformed) : transformed;
    },
  };
}

function createStatistics() {
  const points = [];
  const keyFor = (index, axis) => axis + String(index + 1).padStart(2, '0');
  function dataIndex(key) {
    check(/^[XY]\d{2}$/.test(key), 'Choose a data row.');
    const index = Number(key.slice(1)) - 1;
    check(index >= 0 && index < 50 && index <= points.length, 'Enter up to 50 data points.');
    return index;
  }
  const stat = worksheet(
    'Statistics',
    { MODEL: 'LIN', XP: 0, YP: 0 },
    ({ MODEL }) => [
      select('MODEL', ['LIN', 'Ln', 'EXP', 'PWR', '1-V']),
      auto('n', 'Observations'),
      auto('XBAR', 'x̄'),
      auto('Sx', 'Sx'),
      auto('sx', 'σx'),
      ...(MODEL === '1-V'
        ? []
        : [
            auto('YBAR', 'ȳ'),
            auto('Sy', 'Sy'),
            auto('sy', 'σy'),
            auto('a', 'a'),
            auto('b', 'b'),
            auto('r', 'r'),
            computable('XP', 'X′'),
            computable('YP', 'Y′'),
          ]),
      auto('SUMX', 'ΣX'),
      auto('SUMX2', 'ΣX²'),
      ...(MODEL === '1-V' ? [] : [auto('SUMY', 'ΣY'), auto('SUMY2', 'ΣY²'), auto('SUMXY', 'ΣXY')]),
    ],
    {
      solve(key, values) {
        const result = statistics(points, values.MODEL);
        if (key === 'XP') return result.predictX(values.YP);
        if (key === 'YP') return result.predictY(values.XP);
        return result[key];
      },
    },
  );
  return {
    DATA: {
      title: 'Statistics data',
      rows() {
        return Array.from({ length: Math.min(50, points.length + 1) }, (_, index) => {
          const [x, y] = points[index] ?? [0, 1];
          const xKey = keyFor(index, 'X');
          const yKey = keyFor(index, 'Y');
          return [
            { ...field(xKey), value: x },
            { ...field(yKey), value: y },
          ];
        }).flat();
      },
      write(key, value) {
        const index = dataIndex(key);
        const input = number(value);
        if (index === points.length) points.push([0, 1]);
        points[index][key[0] === 'X' ? 0 : 1] = input;
      },
      clear() {
        points.length = 0;
        // Preserve the current model while discarding predictions based on old data.
        const model = stat.rows()[0].value;
        stat.clear();
        while (stat.rows()[0].value !== model) stat.toggle('MODEL');
      },
      insert(key) {
        const index = dataIndex(key);
        check(points.length < 50, 'The data worksheet already has 50 entries.');
        points.splice(index, 0, [0, 1]);
        return key;
      },
      delete(key) {
        const index = dataIndex(key);
        if (index < points.length) points.splice(index, 1);
        return keyFor(Math.min(points.length, index), key[0]);
      },
    },
    STAT: stat,
  };
}

function numericWorksheet(title, defaults, labels, solve, options) {
  return worksheet(
    title,
    defaults,
    Object.entries(labels).map(([key, label]) =>
      options?.entryOnly?.includes(key) ? field(key, label) : computable(key, label),
    ),
    { solve: (key, values) => solve(values)[key], ...options },
  );
}

export function createWorksheets({
  isEuropeanDate = () => false,
  isEuropeanNumber = () => false,
  decimals = () => 2,
} = {}) {
  return {
    ...createStatistics(),
    DATE: createDate(isEuropeanDate),
    BOND: createBond(isEuropeanDate),
    DEPR: createDepreciation(isEuropeanDate, isEuropeanNumber, decimals),
    CHANGE: numericWorksheet(
      'Percent change',
      { OLD: 0, NEW: 0, CH: 0, PD: 1 },
      { OLD: 'Old value', NEW: 'New value', CH: '%CH', PD: '#PD' },
      ({ OLD, NEW, CH, PD }) => ({
        OLD: NEW / (1 + CH / 100) ** PD,
        NEW: OLD * (1 + CH / 100) ** PD,
        CH: ((NEW / OLD) ** (1 / PD) - 1) * 100,
        PD: Math.log(NEW / OLD) / Math.log1p(CH / 100),
      }),
    ),
    ICONV: numericWorksheet(
      'Interest conversion',
      { NOM: 0, EFF: 0, CY: 1 },
      { NOM: 'Nominal rate', EFF: 'Effective annual rate', CY: 'C/Y' },
      ({ NOM, EFF, CY }) => ({
        NOM: 100 * CY * Math.expm1(Math.log1p(EFF / 100) / CY),
        EFF: 100 * Math.expm1(CY * Math.log1p(NOM / (100 * CY))),
      }),
      {
        entryOnly: ['CY'],
        validate(key, value) {
          if (key === 'CY')
            check(
              Number.isInteger(value) && value > 0,
              'Enter a positive whole number of compounding periods.',
            );
        },
        reset: (_values, all) => (all ? undefined : { NOM: 0, EFF: 0 }),
      },
    ),
    PROFIT: numericWorksheet(
      'Profit margin',
      { CST: 0, SEL: 0, MAR: 0 },
      { CST: 'Cost', SEL: 'Selling price', MAR: 'Gross margin' },
      ({ CST, SEL, MAR }) => ({
        CST: SEL * (1 - MAR / 100),
        SEL: CST / (1 - MAR / 100),
        MAR: (100 * (SEL - CST)) / SEL,
      }),
    ),
    BRKEVN: numericWorksheet(
      'Breakeven',
      { FC: 0, VC: 0, P: 0, PFT: 0, Q: 0 },
      {
        FC: 'Fixed cost',
        VC: 'Variable cost per unit',
        P: 'Unit price',
        PFT: 'Profit',
        Q: 'Quantity',
      },
      ({ FC, VC, P, PFT, Q }) => ({
        FC: (P - VC) * Q - PFT,
        VC: P - (FC + PFT) / Q,
        P: VC + (FC + PFT) / Q,
        PFT: (P - VC) * Q - FC,
        Q: (FC + PFT) / (P - VC),
      }),
    ),
  };
}
