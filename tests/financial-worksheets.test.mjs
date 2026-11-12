import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorksheets } from '../src/client/financial-worksheets.mjs';

function enter(sheet, entries) {
  for (const [key, value] of Object.entries(entries)) sheet.write(key, value);
}
const row = (sheet, key) => sheet.rows().find((item) => item.key === key);
const round = (value, decimals = 2) => Number(value.toFixed(decimals));

test('TI bond price and yield example preserves coupon conventions and accrued interest', () => {
  const { BOND } = createWorksheets();
  enter(BOND, { SDT: 6.1206, CPN: 7, RDT: 12.3107, YLD: 8 });
  assert.equal(BOND.toggle('BASIS'), '360');
  assert.equal(round(BOND.compute('PRI')), 98.56);
  assert.equal(round(BOND.compute('AI')), 3.15);
  assert.equal(round(BOND.compute('YLD')), 8);
  BOND.clear();
  assert.equal(row(BOND, 'FREQ').value, '2/Y');
  assert.equal(row(BOND, 'RV').value, 100);
  assert.throws(() => BOND.compute('PRI'), /Redemption/);
});

test('bond price with one coupon remaining uses simple interest', () => {
  const { BOND } = createWorksheets();
  enter(BOND, { SDT: 9.3006, RDT: 12.3106, CPN: 8, YLD: 10 });
  BOND.toggle('BASIS');
  const price = 104 / (1 + 0.05 * 0.5) - 2;
  assert.equal(round(BOND.compute('PRI'), 5), round(price, 5));
  assert.equal(round(BOND.compute('YLD')), 10);
});

test('TI straight-line example rounds annual depreciation before carrying the balance', () => {
  const { DEPR } = createWorksheets();
  enter(DEPR, { LIF: 31.5, M01: 3.5, CST: 1_000_000 });
  assert.equal(DEPR.compute('DEP'), 25132.28);
  assert.equal(DEPR.compute('RBV'), 974867.72);
  assert.equal(DEPR.compute('YR'), 2);
  assert.equal(DEPR.compute('DEP'), 31746.03);
  assert.equal(DEPR.compute('RDV'), 943121.69);
  DEPR.write('SAL', 1_000_001);
  assert.throws(() => DEPR.compute('DEP'), /Salvage value/);
});

test('declining methods have independent factors and distinguish worksheet and device clearing', () => {
  const { DEPR } = createWorksheets();
  DEPR.toggle('METHOD');
  assert.equal(DEPR.toggle('METHOD'), 'DB');
  DEPR.write('METHOD', 150);
  enter(DEPR, { LIF: 5, CST: 1000, SAL: 100 });
  assert.equal(DEPR.compute('DEP'), 300);
  assert.equal(DEPR.toggle('METHOD'), 'DBX');
  assert.equal(row(DEPR, 'METHOD').display, 200);
  DEPR.clear();
  assert.equal(row(DEPR, 'METHOD').value, 'DBX');
  assert.equal(row(DEPR, 'CST').value, 0);
  DEPR.clear(true);
  assert.equal(row(DEPR, 'METHOD').value, 'SL');
});

test('TI date example and live date format changes preserve the underlying dates', () => {
  let european = false;
  const { DATE } = createWorksheets({ isEuropeanDate: () => european });
  enter(DATE, { DT1: 9.0403, DT2: 11.0103 });
  assert.equal(DATE.compute('DBD'), 58);
  assert.equal(DATE.compute('DT2'), 11.0103);
  assert.equal(row(DATE, 'DT2').display, '11-01-2003 SAT');
  european = true;
  assert.equal(row(DATE, 'DT2').display, '1-11-2003 SAT');
  assert.throws(() => DATE.write('DT2', 31.0225), /Invalid calendar date/);
  assert.equal(DATE.toggle('BASIS'), '360');
  assert.equal(DATE.compute('DBD'), 57);
  assert.throws(() => DATE.compute('DT1'), /ACT/);
  DATE.clear();
  assert.equal(row(DATE, 'BASIS').value, '360');
  DATE.clear(true);
  assert.equal(row(DATE, 'BASIS').value, 'ACT');
});

test('TI interest conversion and profit examples calculate the unknown in either direction', () => {
  const { ICONV, PROFIT } = createWorksheets();
  enter(ICONV, { NOM: 15, CY: 4 });
  assert.equal(round(ICONV.compute('EFF')), 15.87);
  assert.equal(round(ICONV.compute('NOM')), 15);
  ICONV.clear();
  assert.equal(row(ICONV, 'CY').value, 4);
  assert.throws(() => ICONV.write('CY', 0), /positive/);
  enter(PROFIT, { SEL: 125, MAR: 20 });
  assert.equal(PROFIT.compute('CST'), 100);
  assert.equal(PROFIT.compute('MAR'), 20);
});

test('breakeven and percent-change worksheets solve each relationship', () => {
  const { BRKEVN, CHANGE } = createWorksheets();
  enter(BRKEVN, { FC: 500, VC: 10, P: 20, PFT: 0 });
  assert.equal(BRKEVN.compute('Q'), 50);
  BRKEVN.write('Q', 60);
  assert.equal(BRKEVN.compute('PFT'), 100);
  enter(CHANGE, { OLD: 100, NEW: 121, PD: 2 });
  assert.equal(round(CHANGE.compute('CH')), 10);
  assert.equal(round(CHANGE.compute('PD')), 2);
  assert.equal(round(CHANGE.compute('OLD')), 100);
  CHANGE.clear();
  assert.equal(row(CHANGE, 'PD').value, 1);
});

test('paired statistics share editable data and produce linear and exponential predictions', () => {
  const { DATA, STAT } = createWorksheets();
  enter(DATA, { X01: 1, Y01: 5, X02: 2, Y02: 8, X03: 3, Y03: 11 });
  assert.equal(row(STAT, 'n').value, 3);
  assert.equal(row(STAT, 'Sx').value, 1);
  assert.equal(row(STAT, 'SUMXY').value, 54);
  assert.equal(row(STAT, 'a').value, 2);
  assert.equal(row(STAT, 'b').value, 3);
  STAT.write('XP', 4);
  assert.equal(STAT.compute('YP'), 14);
  assert.equal(STAT.compute('XP'), 4);
  DATA.clear();
  enter(DATA, { X01: 0, Y01: 2, X02: 1, Y02: 6, X03: 2, Y03: 18 });
  STAT.toggle('MODEL');
  assert.equal(STAT.toggle('MODEL'), 'EXP');
  assert.equal(round(row(STAT, 'a').value), 2);
  assert.equal(round(row(STAT, 'b').value), 3);
  STAT.write('XP', 3);
  assert.equal(round(STAT.compute('YP')), 54);
});

test('one-variable statistics apply frequencies and support insert, delete and worksheet clearing', () => {
  const { DATA, STAT } = createWorksheets();
  for (let step = 0; step < 4; step++) STAT.toggle('MODEL');
  enter(DATA, { X01: 2, Y01: 2, X02: 8, Y02: 1 });
  assert.equal(DATA.insert('X02'), 'X02');
  assert.equal(DATA.delete('X02'), 'X02');
  assert.equal(row(STAT, 'n').value, 3);
  assert.equal(row(STAT, 'XBAR').value, 4);
  assert.equal(row(STAT, 'SUMX2').value, 72);
  assert.equal(row(STAT, 'Sx').value, Math.sqrt(12));
  assert.equal(row(STAT, 'YBAR'), undefined);
  DATA.clear();
  assert.equal(row(STAT, 'MODEL').value, '1-V');
  assert.equal(row(STAT, 'n').value, null);
  STAT.clear();
  assert.equal(row(STAT, 'MODEL').value, 'LIN');
});
