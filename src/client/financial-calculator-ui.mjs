import { createFinancialCalculator } from './financial-calculator.mjs';

const KEYS = [
  [
    ['CPT', 'CPT', 'QUIT'],
    ['ENTER', 'ENTER', 'SET'],
    ['UP', '↑', 'DEL'],
    ['DOWN', '↓', 'INS'],
    ['ON', 'ON/OFF'],
  ],
  [
    ['2ND', '2nd'],
    ['CF', 'CF'],
    ['NPV', 'NPV'],
    ['IRR', 'IRR'],
    ['BACK', '→'],
  ],
  [
    ['N', 'N', '×P/Y'],
    ['IY', 'I/Y', 'P/Y'],
    ['PV', 'PV', 'AMORT'],
    ['PMT', 'PMT', 'BGN'],
    ['FV', 'FV', 'CLR TVM'],
  ],
  [
    ['%', '%', 'K'],
    ['SQRT', '√x'],
    ['SQUARE', 'x²'],
    ['RECIP', '1/x'],
    ['/', '÷', 'RAND'],
  ],
  [
    ['INV', 'INV', 'HYP'],
    ['LPAREN', '(', 'SIN'],
    ['RPAREN', ')', 'COS'],
    ['POW', 'yˣ', 'TAN'],
    ['*', '×', 'x!'],
  ],
  [
    ['LN', 'LN', 'eˣ'],
    ['7', '7', 'DATA'],
    ['8', '8', 'STAT'],
    ['9', '9', 'BOND'],
    ['-', '−', 'nPr'],
  ],
  [
    ['STO', 'STO', 'ROUND'],
    ['4', '4', 'DEPR'],
    ['5', '5', 'Δ%'],
    ['6', '6', 'BRKEVN'],
    ['+', '+', 'nCr'],
  ],
  [
    ['RCL', 'RCL'],
    ['1', '1', 'DATE'],
    ['2', '2', 'ICONV'],
    ['3', '3', 'PROFIT'],
    ['=', '=', 'ANS'],
  ],
  [
    ['CE', 'CE/C', 'CLR WORK'],
    ['0', '0', 'MEM'],
    ['.', '.', 'FORMAT'],
    ['SIGN', '+/−', 'RESET'],
  ],
];
const keyboard = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowRight: 'BACK',
  Backspace: 'BACK',
  Escape: 'CE',
  Enter: '=',
  Delete: 'CE',
  '(': 'LPAREN',
  ')': 'RPAREN',
  '^': 'POW',
};
const keyNames = {
  UP: 'Previous worksheet value',
  DOWN: 'Next worksheet value',
  BACK: 'Backspace',
  SQRT: 'Square root',
  SQUARE: 'Square',
  RECIP: 'Reciprocal',
  POW: 'Raise to a power',
  SIGN: 'Change sign',
  '/': 'Divide',
  '*': 'Multiply',
  '-': 'Subtract',
  '+': 'Add',
  '=': 'Equals',
  LPAREN: 'Open parenthesis',
  RPAREN: 'Close parenthesis',
  '.': 'Decimal point',
};

export function mountFinancialCalculator({ root, keypad, output, label, flags }) {
  const calculator = createFinancialCalculator();
  const buttons = new Map();
  for (const [id, text, alternate] of KEYS.flat()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.key = id;
    if (keyNames[id]) button.setAttribute('aria-label', keyNames[id]);
    if (alternate) button.setAttribute('aria-description', `Second function: ${alternate}`);
    const legend = document.createElement('span');
    legend.className = 'finance-key-legend';
    legend.setAttribute('aria-hidden', 'true');
    legend.textContent = alternate || '';
    const cap = document.createElement('span');
    cap.className = 'finance-key-cap';
    cap.textContent = text;
    button.append(legend, cap);
    button.addEventListener('click', () => press(id));
    buttons.set(id, button);
    keypad.append(button);
  }
  const update = () => {
    const display = calculator.getDisplay();
    const shifted = display.indicators.some((flag) => flag.toLowerCase() === '2nd');
    root.dataset.shifted = String(shifted);
    root.dataset.powered = String(display.powered);
    label.textContent = display.powered ? display.label || display.worksheet || '' : '';
    flags.textContent = display.powered ? display.indicators.join('  ') : '';
    output.value = display.powered ? display.value : '';
    output.title = display.error || '';
    if (display.error) output.setAttribute('aria-label', display.error);
    else output.removeAttribute('aria-label');
    buttons.get('2ND').setAttribute('aria-pressed', String(shifted));
    buttons.get('ON').setAttribute('aria-pressed', String(display.powered));
  };
  function press(key) {
    calculator.press(key);
    update();
  }
  root.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (event.key === 'Enter' && event.target !== root) return;
    const key =
      event.key === 'Enter' && calculator.getDisplay().worksheet
        ? 'ENTER'
        : keyboard[event.key] || event.key;
    if (!buttons.has(key)) return;
    event.preventDefault();
    press(key);
  });
  update();
}
