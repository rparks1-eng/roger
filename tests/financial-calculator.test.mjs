import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFinancialCalculator } from '../src/client/financial-calculator.mjs';

function keypad() {
  const calculator = createFinancialCalculator();
  const keys = (sequence) => {
    for (const key of sequence.split(' ')) calculator.press(key);
    return calculator.getDisplay();
  };
  return { keys, display: calculator.getDisplay };
}

test('chain and AOS arithmetic, editing, percent, parentheses and numeric functions', () => {
  const { keys } = keypad();
  assert.equal(keys('3 + 2 * 4 =').value, '20.00');
  assert.equal(keys('7 * LPAREN 3 + 5 RPAREN =').value, '56.00');
  assert.equal(keys('4 9 8 + 7 %').value, '34.86');
  assert.equal(keys('=').value, '532.86');
  assert.equal(keys('1 4 / 2 5 % =').value, '56.00');
  assert.equal(keys('3 * 1 2 3 4 . 8 6 BACK BACK 5 6 =').value, '3,703.68');
  assert.equal(keys('2ND . DOWN DOWN DOWN DOWN 2ND ENTER 2ND CPT 3 + 2 * 4 =').value, '11.00');
  assert.equal(keys('9 SQRT SQUARE RECIP').value, '0.11');
  assert.equal(keys('1 LN 2ND LN').value, '1.00');
  assert.equal(keys('2 POW 3 =').value, '8.00');
  assert.equal(keys('5 2 2ND + 5 =').value, '2,598,960.00');
  assert.equal(keys('8 2ND - 3 =').value, '336.00');
  assert.equal(keys('5 2ND *').value, '120.00');
  assert.match(keys('6 / 0 =').error, /zero/);
  assert.equal(keys('CE 6 / 4 =').value, '1.50');
});

test('shift, stored constants, radians, trigonometry, random, memory and reset', () => {
  const { keys } = keypad();
  assert.deepEqual(keys('2ND').indicators, ['2nd']);
  assert.deepEqual(keys('2ND').indicators, []);
  assert.equal(keys('3 * 8 2ND % =').value, '24.00');
  assert.equal(keys('7 =').value, '56.00');
  assert.equal(keys('4 5 =').value, '360.00');
  assert.equal(keys('2ND CPT 9 0 2ND LPAREN').value, '1.00');
  assert.equal(keys('9 0 2ND RPAREN').value, '0.00');
  assert.equal(keys('1 INV 2ND POW').value, '45.00');
  assert.equal(keys('. 5 2ND INV 2ND LPAREN').value, '0.52');
  assert.equal(keys('5 2ND INV INV 2ND LPAREN').value, '2.31');
  assert.equal(keys('2ND . DOWN 2ND ENTER 2ND CPT').indicators.includes('RAD'), true);
  assert.equal(keys('1 INV 2ND POW').value, '0.79');
  assert.equal(keys('2 / 3 = 2ND STO * 3 =').value, '2.01');
  assert.equal(keys('7 STO 2ND / 2ND /').error, undefined);
  assert.equal(keys('1 4 . 9 5 STO 3 3 STO + 3 RCL 3').value, '17.95');
  assert.equal(keys('ON').powered, false);
  assert.equal(keys('9 ON RCL 3').value, '17.95');
  assert.equal(keys('2ND 0 DOWN DOWN DOWN + 2 ENTER').value, '19.95');
  assert.equal(keys('2ND CPT 4 + 5 = 2ND =').value, '9.00');
  assert.match(keys('2ND SIGN').label, /RST/);
  assert.equal(keys('ENTER RCL 3').value, '0.00');
  assert.ok(!keys('CE').indicators.includes('RAD'));
});

test('official mortgage sequence, BGN/END, periods, and amortization advance', () => {
  const { keys } = keypad();
  assert.equal(keys('2ND IY 1 2 ENTER DOWN').value, '12.00');
  const rate = keys('2ND CPT 3 0 2ND N N 7 5 0 0 0 PV 4 2 5 . 8 4 SIGN PMT CPT IY');
  assert.equal(rate.value, '5.50');
  assert.equal(rate.label, 'I/Y');
  assert.equal(keys('2ND PV DOWN 1 2 ENTER DOWN').label, 'BAL');
  assert.ok(keys('DOWN').value.startsWith('-'));
  assert.ok(keys('DOWN').value.startsWith('-'));
  assert.equal(keys('DOWN CPT').value, '13.00');
  assert.equal(keys('DOWN').value, '24.00');
  assert.equal(keys('2ND PMT 2ND ENTER').indicators.includes('BGN'), true);
  assert.equal(keys('2ND CPT 2ND FV RCL N').value, '0.00');
  assert.equal(keys('2ND IY').value, '12.00');
  assert.equal(keys('2ND PMT 2ND CE').value, 'END');
});

test('cash flow frequency, NPV, IRR, insert and delete', () => {
  const { keys } = keypad();
  assert.equal(keys('CF 1 0 0 SIGN ENTER DOWN 6 0 ENTER DOWN 2 ENTER').label, 'F01');
  assert.equal(keys('NPV 1 0 ENTER DOWN CPT').value, '4.13');
  assert.equal(keys('IRR CPT').value, '13.07');
  assert.equal(keys('CF DOWN 2ND DOWN').value, '0.00');
  assert.equal(keys('DOWN DOWN').value, '60.00');
  assert.equal(keys('CF DOWN 2ND UP').value, '60.00');
  assert.equal(keys('DOWN').value, '2.00');
  assert.match(keys('2ND CE IRR CPT').error, /positive and negative/);
});

test('the remaining alternate worksheets open and perform calculator entry and computation', () => {
  const { keys } = keypad();
  for (const [key, title] of [
    ['7', 'Statistics data'],
    ['8', 'Statistics'],
    ['9', 'Bond'],
    ['4', 'Depreciation'],
    ['5', 'Percent change'],
    ['6', 'Breakeven'],
    ['1', 'Date'],
    ['2', 'Interest conversion'],
    ['3', 'Profit margin'],
  ])
    assert.equal(keys('2ND ' + key).worksheet, title);
  assert.equal(keys('4 0 ENTER DOWN 1 0 0 ENTER DOWN CPT').value, '60.00');
  assert.equal(keys('2ND 5 8 0 ENTER DOWN 1 0 0 ENTER DOWN CPT').value, '25.00');
  assert.equal(keys('2ND 6 1 0 0 ENTER DOWN 4 ENTER DOWN 6 ENTER DOWN DOWN CPT').value, '50.00');
  assert.equal(keys('2ND 2 1 5 ENTER DOWN DOWN 1 2 ENTER UP CPT').value, '16.08');
  assert.equal(keys('2ND 1 1 . 0 1 2 4 ENTER DOWN 3 . 0 1 2 4 ENTER DOWN CPT').value, '60.00');
  assert.match(keys('UP CPT').value, /3-01-2024/);
  assert.equal(
    keys('2ND 7 2 ENTER DOWN 1 ENTER DOWN 4 ENTER DOWN 2 ENTER 2ND 8 DOWN DOWN').value,
    '3.00',
  );
  assert.equal(keys('CE CE CE').worksheet, undefined);
});

test('official bond worksheet with date entry and alternate day-count convention', () => {
  const { keys } = keypad();
  assert.equal(keys('2ND 9 6 . 1 2 0 6 ENTER').value, '6-12-2006');
  assert.equal(keys('DOWN 7 ENTER DOWN 1 2 . 3 1 0 7 ENTER DOWN DOWN 2ND ENTER').value, '360');
  assert.equal(keys('DOWN DOWN 8 ENTER DOWN CPT').value, '98.56');
  assert.equal(keys('DOWN').value, '3.15');
  assert.equal(keys('2ND CPT 2ND . 2ND CE DOWN DOWN 2ND ENTER 2ND CPT 2ND 9').value, '12-06-2006');
});
