import { amortize, cashFlowIRR, cashFlowNPV, solveTVM } from './financial-math.mjs';
import { createWorksheets } from './financial-worksheets.mjs';

const tvmKeys = ['N', 'IY', 'PV', 'PMT', 'FV'];
const labelFor = (key) => ({ IY: 'I/Y', PY: 'P/Y', CY: 'C/Y' })[key] ?? key;
const initialTVM = () => ({ N: 0, IY: 0, PV: 0, PMT: 0, FV: 0, PY: 1, CY: 1, BGN: false });
const initialFormat = () => ({
  decimals: 2,
  angle: 'DEG',
  dateFormat: 'US',
  numberFormat: 'US',
  method: 'Chn',
});
const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, POW: 3, NPR: 3, NCR: 3 };
const frame = () => ({ numbers: [], operators: [] });
const number = (key, value, extra = {}) => ({ key, label: labelFor(key), value, ...extra });
const setting = (key, value, options) => number(key, value, { options });
const output = (key, value, extra = {}) => number(key, value, { readOnly: true, ...extra });
const digit = (key) => /^[0-9]$/.test(key);
const finite = (value, message = 'The result is outside the calculator’s range.') => {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e100) throw new RangeError(message);
  return Object.is(value, -0) ? 0 : value;
};
const whole = (value, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`Enter a whole number from ${min} to ${max}.`);
  return value;
};

function countSelections(n, r, ordered) {
  whole(n, 1, 1_000_000);
  whole(r, 1, n);
  if (!ordered) r = Math.min(r, n - r);
  let result = 1;
  for (let index = 0; index < r; index++) {
    result = finite((result * (n - index)) / (ordered ? 1 : index + 1));
  }
  return Math.round(result);
}

const operations = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => {
    if (!b) throw new RangeError('Cannot divide by zero.');
    return a / b;
  },
  POW: (a, b) => {
    if (a < 0 && !Number.isInteger(b)) {
      const reciprocal = Math.round(1 / b);
      if (reciprocal % 2 && Math.abs(reciprocal * b - 1) < 1e-12) return -Math.pow(-a, b);
    }
    return a ** b;
  },
  NPR: (n, r) => countSelections(n, r, true),
  NCR: (n, r) => countSelections(n, r, false),
};

function reduceFrame(expression) {
  const op = expression.operators.pop();
  const right = expression.numbers.pop();
  const left = expression.numbers.pop();
  const result = finite(operations[op](left, right));
  expression.numbers.push(result);
  return result;
}

function formatValue(value, format, raw) {
  if (typeof value === 'string') return value;
  if (raw !== null) {
    const [integer, fraction] = raw.split('.');
    const euro = format.numberFormat === 'EUR';
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, euro ? '.' : ',');
    return fraction === undefined ? grouped : grouped + (euro ? ',' : '.') + fraction;
  }
  const locale = format.numberFormat === 'EUR' ? 'de-DE' : 'en-US';
  const decimals = format.decimals;
  const magnitude = Math.abs(value);
  if (magnitude >= 1e10 || (magnitude !== 0 && magnitude < 1e-9))
    return value.toExponential(decimals === 9 ? 8 : Math.min(decimals, 7));
  if (decimals === 9)
    return new Intl.NumberFormat(locale, { maximumSignificantDigits: 10 }).format(value);
  const integerDigits = magnitude < 1 ? 1 : Math.floor(Math.log10(magnitude)) + 1;
  const places = Math.min(decimals, Math.max(0, 10 - integerDigits));
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value);
}

export function createFinancialCalculator() {
  let registers = initialTVM();
  let format = initialFormat();
  let memory = Array(10).fill(0);
  let cash = { initial: 0, items: [], rate: 0, npv: 0, irr: 0 };
  let payments = { first: 1, last: 1 };
  let randomSeed = null;
  let answer = 0;
  let constant = null;
  let expressions = [frame()];
  let value = 0;
  let entry = null;
  let ready = true;
  let worksheet = null;
  let index = 0;
  let label = '';
  let error = null;
  let powered = true;
  let second = false;
  let compute = false;
  let inverse = false;
  let hyperbolic = false;
  let memoryAction = null;
  let resetPending = false;
  let amortization = null;
  let clearCount = 0;

  const worksheets = createWorksheets({
    isEuropeanDate: () => format.dateFormat === 'EUR',
    isEuropeanNumber: () => format.numberFormat === 'EUR',
    decimals: () => format.decimals,
  });
  Object.assign(worksheets, {
    PY: {
      title: 'Payments and compounding',
      rows: () => [number('PY', registers.PY), number('CY', registers.CY)],
      write(key, amount) {
        registers[key] = whole(amount, 1, 9999);
        if (key === 'PY') registers.CY = registers.PY;
      },
      clear() {
        registers.PY = registers.CY = 1;
      },
    },
    BGN: {
      title: 'Payment timing',
      rows: () => [setting('TIMING', registers.BGN ? 'BGN' : 'END', ['END', 'BGN'])],
      toggle() {
        registers.BGN = !registers.BGN;
      },
      clear() {
        registers.BGN = false;
      },
    },
    AMORT: {
      title: 'Amortization',
      rows: () => [
        number('P1', payments.first, { compute: true }),
        number('P2', payments.last, { compute: true }),
        ...['BAL', 'PRN', 'INT'].map((key) =>
          output(key, amortization?.[key] ?? 0, { auto: true }),
        ),
      ],
      write(key, amount) {
        payments[key === 'P1' ? 'first' : 'last'] = whole(amount, 1, 9999);
        amortization = null;
      },
      compute(key) {
        if (key === 'P1' || key === 'P2') {
          const width = payments.last - payments.first + 1;
          const next = payments.last + 1;
          if (width <= 0) throw new RangeError('P2 must be at least P1.');
          payments.last = whole(next + width - 1, 1, 9999);
          payments.first = next;
          amortization = null;
          return key === 'P1' ? payments.first : payments.last;
        }
        amortization ??= amortize(registers, payments.first, payments.last, format.decimals);
        return amortization[key];
      },
      clear() {
        payments = { first: 1, last: 1 };
        amortization = null;
      },
    },
    FORMAT: {
      title: 'Calculator format',
      rows: () => [
        number('DEC', format.decimals),
        setting('ANGLE', format.angle, ['DEG', 'RAD']),
        setting('DATE', format.dateFormat, ['US', 'EUR']),
        setting('SEPARATORS', format.numberFormat, ['US', 'EUR']),
        setting('METHOD', format.method, ['Chn', 'AOS']),
      ],
      write(_key, amount) {
        format.decimals = whole(amount, 0, 9);
        amortization = null;
      },
      toggle(key) {
        const options = {
          ANGLE: ['angle', 'DEG', 'RAD'],
          DATE: ['dateFormat', 'US', 'EUR'],
          SEPARATORS: ['numberFormat', 'US', 'EUR'],
          METHOD: ['method', 'Chn', 'AOS'],
        };
        const [property, first, last] = options[key];
        format[property] = format[property] === first ? last : first;
      },
      clear() {
        format = initialFormat();
        amortization = null;
      },
    },
    MEM: {
      title: 'Memory',
      rows: () => memory.map((amount, slot) => number(`M${slot}`, amount)),
      write(key, amount) {
        memory[Number(key.slice(1))] = amount;
      },
      clear() {
        memory.fill(0);
      },
    },
    CF: {
      title: 'Cash flow',
      rows() {
        const items = cash.items.flatMap(({ amount, count }, position) => {
          const digits = String(position + 1).padStart(2, '0');
          return [number('C' + digits, amount), number('F' + digits, count)];
        });
        if (cash.items.length < 24)
          items.push(number('C' + String(cash.items.length + 1).padStart(2, '0'), 0));
        return [number('CF0', cash.initial), ...items];
      },
      write(key, amount) {
        if (key === 'CF0') cash.initial = amount;
        else {
          const position = Number(key.slice(1)) - 1;
          const item = (cash.items[position] ??= { amount: 0, count: 1 });
          if (key.startsWith('C')) item.amount = amount;
          else {
            if (amount < 0.5 || amount > 9999)
              throw new RangeError('Enter a cash flow frequency from 0.5 to 9999.');
            item.count = Math.round(amount);
          }
        }
        cash.npv = cash.irr = 0;
      },
      insert(key) {
        if (key === 'CF0' || cash.items.length >= 24) return key;
        const position = Number(key.slice(1)) - 1;
        cash.items.splice(position, 0, { amount: 0, count: 1 });
        cash.npv = cash.irr = 0;
        return 'C' + key.slice(1);
      },
      delete(key) {
        if (key === 'CF0') return key;
        cash.items.splice(Number(key.slice(1)) - 1, 1);
        cash.npv = cash.irr = 0;
        return 'C' + key.slice(1);
      },
      clear() {
        cash = { ...cash, initial: 0, items: [], npv: 0, irr: 0 };
      },
    },
    NPV: {
      title: 'Net present value',
      rows: () => [number('I', cash.rate), output('NPV', cash.npv)],
      write(_key, amount) {
        if (amount <= -100) throw new RangeError('The discount rate must be above −100%.');
        cash.rate = amount;
        cash.npv = 0;
      },
      compute(key) {
        if (key === 'NPV') cash.npv = cashFlowNPV(cash.rate, cashFlows());
        return cash.npv;
      },
      clear() {
        cash.rate = cash.npv = 0;
      },
    },
    IRR: {
      title: 'Internal rate of return',
      rows: () => [output('IRR', cash.irr)],
      compute() {
        cash.irr = cashFlowIRR(cashFlows());
        return cash.irr;
      },
      clear() {
        cash.irr = 0;
      },
    },
  });

  function cashFlows() {
    return [cash.initial, ...cash.items.flatMap(({ amount, count }) => Array(count).fill(amount))];
  }

  function displayValue(amount, result = false) {
    value = finite(amount);
    entry = null;
    ready = true;
    if (result) answer = value;
  }

  function clearExpression() {
    expressions = [frame()];
    entry = null;
    constant = null;
    label = '';
  }

  function activeRows() {
    return worksheet ? worksheets[worksheet].rows() : [];
  }

  function activateRow(position) {
    const rows = activeRows();
    index = rows.length ? ((position % rows.length) + rows.length) % rows.length : 0;
    const row = rows[index];
    if (!row) return;
    ready = false;
    entry = null;
    expressions = [frame()];
    const amount = row.auto ? worksheets[worksheet].compute(row.key) : row.value;
    value = typeof amount === 'number' ? amount : 0;
    if (row.auto) answer = value;
  }

  function openWorksheet(key) {
    clearExpression();
    worksheet = key;
    activateRow(0);
  }

  function quit() {
    worksheet = null;
    resetPending = false;
    clearExpression();
    displayValue(0);
  }

  function type(key) {
    const raw = entry ?? '';
    if (key === '.') {
      if (raw.includes('.')) return;
      entry = (raw || '0') + '.';
    } else {
      if (raw.replace(/\D/g, '').length >= 10) return;
      entry = raw === '0' ? key : raw === '-0' ? '-' + key : raw + key;
    }
    value = Number(entry);
    label = '';
    ready = true;
  }

  function mathOperator(key) {
    const current = expressions.at(-1);
    if (!ready && current.operators.length) {
      current.operators[current.operators.length - 1] = key;
      return;
    }
    current.numbers.push(value);
    while (
      current.operators.length &&
      (format.method === 'Chn' || precedence[current.operators.at(-1)] >= precedence[key])
    )
      value = reduceFrame(current);
    current.operators.push(key);
    entry = null;
    ready = false;
    label = '';
  }

  function finishExpression(current) {
    current.numbers.push(value);
    while (current.operators.length) value = reduceFrame(current);
    displayValue(value, true);
  }

  function equals() {
    if (constant && expressions.length === 1 && !expressions[0].operators.length) {
      displayValue(operations[constant.op](value, constant.amount), true);
      return;
    }
    while (expressions.length > 1) finishExpression(expressions.pop());
    finishExpression(expressions[0]);
    expressions = [frame()];
  }

  function applyPercent() {
    const current = expressions.at(-1);
    const operation = current.operators.at(-1);
    const base = operation === '+' || operation === '-' ? current.numbers.at(-1) : 1;
    displayValue((value / 100) * (base ?? 1), true);
  }

  function trig(key) {
    const method = { LPAREN: 'sin', RPAREN: 'cos', POW: 'tan' }[key];
    const functionName = (inverse ? 'a' : '') + method + (hyperbolic ? 'h' : '');
    let input = value;
    if (!hyperbolic && !inverse && format.angle === 'DEG') input *= Math.PI / 180;
    const quarterTurns = input / (Math.PI / 2);
    const exactQuarter = Math.round(quarterTurns);
    const cardinal = !hyperbolic && !inverse && Math.abs(exactQuarter - quarterTurns) < 1e-13;
    let result = Math[functionName](input);
    if (cardinal) {
      const quadrant = ((exactQuarter % 4) + 4) % 4;
      result =
        method === 'sin'
          ? [0, 1, 0, -1][quadrant]
          : method === 'cos'
            ? [1, 0, -1, 0][quadrant]
            : quadrant % 2
              ? NaN
              : 0;
    }
    if (!hyperbolic && inverse && format.angle === 'DEG') result *= 180 / Math.PI;
    inverse = hyperbolic = false;
    displayValue(finite(result, 'This angle or value is outside the function domain.'), true);
  }

  function enter() {
    if (resetPending) {
      registers = initialTVM();
      format = initialFormat();
      memory = Array(10).fill(0);
      randomSeed = null;
      answer = 0;
      for (const sheet of Object.values(worksheets)) sheet.clear(true);
      quit();
      label = 'RST';
      return;
    }
    if (!worksheet) return;
    const row = activeRows()[index];
    if (!row || row.readOnly || (row.options && !row.editable) || !ready) return;
    if (expressions.length > 1 || expressions[0].operators.length) equals();
    worksheets[worksheet].write(row.key, value);
    activateRow(index);
  }

  function solve() {
    const row = activeRows()[index];
    if (!(row?.compute || row?.readOnly) || !worksheets[worksheet].compute) return;
    const amount = worksheets[worksheet].compute(row.key);
    if (row.date && typeof amount === 'number') {
      activateRow(index);
      answer = amount;
    } else if (typeof amount === 'number') displayValue(amount, true);
  }

  function random() {
    if (randomSeed === null) randomSeed = Math.floor(Math.random() * 2147483646) + 1;
    randomSeed = (randomSeed * 16807) % 2147483647 || 1;
    displayValue(randomSeed / 2147483647, true);
  }

  function editRows(action) {
    const rows = activeRows();
    const key = rows[index]?.key;
    const change = worksheets[worksheet]?.[action]?.(key);
    if (change)
      activateRow(
        Math.max(
          0,
          activeRows().findIndex((row) => row.key === change),
        ),
      );
  }

  const secondaryWorksheets = {
    IY: 'PY',
    PV: 'AMORT',
    PMT: 'BGN',
    7: 'DATA',
    8: 'STAT',
    9: 'BOND',
    4: 'DEPR',
    5: 'CHANGE',
    6: 'BRKEVN',
    1: 'DATE',
    2: 'ICONV',
    3: 'PROFIT',
    0: 'MEM',
    '.': 'FORMAT',
  };

  function shift(key) {
    if (secondaryWorksheets[key]) {
      openWorksheet(secondaryWorksheets[key]);
      return;
    }
    switch (key) {
      case 'CPT':
        quit();
        break;
      case 'ENTER': {
        const row = activeRows()[index];
        if (row?.options) {
          worksheets[worksheet].toggle(row.key);
          activateRow(index);
        }
        break;
      }
      case 'UP':
        editRows('delete');
        break;
      case 'DOWN':
        editRows('insert');
        break;
      case 'N':
        displayValue(value * registers.PY, true);
        break;
      case 'FV':
        for (const variable of tvmKeys) registers[variable] = 0;
        amortization = null;
        quit();
        break;
      case '%': {
        const op = expressions.at(-1).operators.at(-1);
        if (op && ready) constant = { op, amount: value };
        break;
      }
      case '/':
        if (memoryAction?.kind === 'STO') {
          randomSeed = whole(value, 1, 2147483646);
          memoryAction = null;
        } else random();
        break;
      case 'SIN':
      case 'INV':
        hyperbolic = !hyperbolic;
        break;
      case 'LPAREN':
      case 'RPAREN':
      case 'POW':
        trig(key);
        break;
      case '*': {
        const n = whole(value, 0, 69);
        let product = 1;
        for (let i = 2; i <= n; i++) product *= i;
        displayValue(product, true);
        break;
      }
      case 'LN':
        displayValue(Math.exp(value), true);
        break;
      case 'STO':
        displayValue(
          Number(formatValue(value, { ...format, numberFormat: 'US' }, null).replaceAll(',', '')),
          true,
        );
        break;
      case '-':
        mathOperator('NPR');
        break;
      case '+':
        mathOperator('NCR');
        break;
      case 'CE':
        if (worksheet) {
          worksheets[worksheet].clear();
          activateRow(0);
        } else quit();
        break;
      case '=':
        displayValue(answer);
        break;
      case 'SIGN':
        resetPending = true;
        break;
    }
  }

  function primary(key) {
    if (memoryAction) {
      const action = memoryAction;
      if (action.kind === 'STO' && !action.op && Object.hasOwn(operations, key)) {
        action.op = key;
        return;
      }
      memoryAction = null;
      if (digit(key)) {
        if (action.kind === 'RCL') displayValue(memory[Number(key)]);
        else {
          memory[Number(key)] = action.op
            ? finite(operations[action.op](memory[Number(key)], value))
            : value;
          entry = null;
        }
        return;
      }
      if (action.kind === 'RCL' && tvmKeys.includes(key)) {
        displayValue(registers[key]);
        label = labelFor(key);
        return;
      }
    }
    if (key === 'ENTER') return enter();
    if (resetPending) {
      if (key === 'CE') quit();
      return;
    }
    if (tvmKeys.includes(key)) {
      if (compute) {
        if (worksheet) throw new RangeError('Quit this worksheet before computing a TVM variable.');
        registers[key] = solveTVM(key, registers);
        displayValue(registers[key], true);
      } else {
        if (key === 'N' && value < 0)
          throw new RangeError('The number of periods cannot be negative.');
        registers[key] = value;
        displayValue(value);
      }
      amortization = null;
      label = labelFor(key);
      return;
    }
    if (digit(key) || key === '.') return type(key);
    if ((inverse || hyperbolic) && ['LPAREN', 'RPAREN', 'POW'].includes(key)) return trig(key);
    if (Object.hasOwn(operations, key)) return mathOperator(key);
    if (['CF', 'NPV', 'IRR'].includes(key)) return openWorksheet(key);
    switch (key) {
      case 'CPT':
        if (worksheet) solve();
        else compute = true;
        break;
      case 'UP':
      case 'DOWN':
        if (worksheet) activateRow(index + (key === 'DOWN' ? 1 : -1));
        break;
      case 'STO':
      case 'RCL':
        memoryAction = { kind: key, op: null };
        break;
      case 'BACK':
        if (entry !== null) {
          entry = entry.slice(0, -1);
          if (entry === '-' || entry === '') entry = '0';
          value = Number(entry);
        }
        break;
      case 'CE':
        if (worksheet) {
          if (clearCount >= 3) quit();
          else activateRow(index);
        } else if (entry !== null) {
          displayValue(0);
          label = '';
        } else quit();
        break;
      case 'SIGN':
        if (entry !== null) {
          entry = entry.startsWith('-') ? entry.slice(1) : '-' + entry;
          value = Number(entry);
        } else displayValue(-value);
        break;
      case '=':
        equals();
        break;
      case '%':
        applyPercent();
        break;
      case 'SQRT':
        displayValue(finite(Math.sqrt(value), 'Square root requires a nonnegative value.'), true);
        break;
      case 'SQUARE':
        displayValue(value ** 2, true);
        break;
      case 'RECIP':
        displayValue(operations['/'](1, value), true);
        break;
      case 'LN':
        displayValue(finite(Math.log(value), 'Logarithm requires a positive value.'), true);
        break;
      case 'SIN':
      case 'INV':
        inverse = !inverse;
        break;
      case 'LPAREN':
        if (expressions.length >= 16) throw new RangeError('Too many open parentheses.');
        expressions.push(frame());
        entry = null;
        ready = false;
        break;
      case 'RPAREN':
        if (expressions.length > 1) finishExpression(expressions.pop());
        break;
    }
  }

  function press(key) {
    if (key === 'ON') {
      powered = !powered;
      return;
    }
    if (!powered) return;
    clearCount = key === 'CE' ? clearCount + 1 : 0;
    if (error && key !== 'CE') return;
    if (error) {
      error = null;
      entry = null;
      expressions = [frame()];
      if (!worksheet) value = 0;
      ready = false;
      return;
    }
    if (key === '2ND') {
      second = !second;
      return;
    }
    try {
      if (second) {
        second = false;
        shift(key);
        compute = false;
      } else {
        if (constant && !digit(key) && !['=', '.', 'SIGN'].includes(key)) constant = null;
        primary(key);
        if (key !== 'CPT') compute = false;
      }
    } catch (exception) {
      error = exception instanceof Error ? exception.message : 'Calculation could not finish.';
      second = compute = inverse = hyperbolic = false;
      memoryAction = null;
    }
  }

  function getDisplay() {
    if (!powered) return { value: '', label: '', indicators: [], powered };
    const rows = activeRows();
    const row = rows[index];
    const current = row && !ready ? (row.display ?? row.value) : value;
    const indicators = [];
    if (second) indicators.push('2nd');
    if (compute) indicators.push('CPT');
    if (inverse) indicators.push('INV');
    if (hyperbolic) indicators.push('HYP');
    if (registers.BGN) indicators.push('BGN');
    if (format.angle === 'RAD') indicators.push('RAD');
    if (memoryAction) indicators.push(memoryAction.kind);
    if (constant) indicators.push('K');
    if (resetPending || (row && !row.readOnly && (!row.options || row.editable)))
      indicators.push('ENTER');
    if (row?.options) indicators.push('SET');
    if (row?.compute || (row?.readOnly && !row.auto)) indicators.push('COMPUTE');
    if (row && rows.length > 1) indicators.push('↑↓');
    if (row && worksheet === 'DATA') indicators.push('DEL', 'INS');
    if (row && worksheet === 'CF' && index > 0) {
      if (Number(row.key.slice(1)) <= cash.items.length) indicators.push('DEL');
      if (cash.items.length < 24) indicators.push('INS');
    }
    return {
      powered,
      label: resetPending ? 'RST ?' : (row?.label ?? label),
      value: error ? 'Error' : formatValue(current ?? 0, format, entry),
      indicators,
      worksheet: worksheet ? worksheets[worksheet].title : undefined,
      error: error ?? undefined,
    };
  }

  return { press, getDisplay };
}
