import assert from 'node:assert/strict';
import test from 'node:test';
import { solveTVM, amortize, cashFlowNPV, cashFlowIRR } from '../src/client/financial-math.mjs';

const round = (value) => Number(value.toFixed(2));
const mortgage = { N: 360, IY: 6.125, PV: 120000, PMT: 0, FV: 0, PY: 12, CY: 12 };

test('TI mortgage TVM and amortization examples match for three payment ranges', () => {
  const terms = { ...mortgage, PMT: solveTVM('PMT', mortgage) };
  assert.equal(round(terms.PMT), -729.13);
  assert.deepEqual(amortize(terms, 1, 9), { BAL: 118928.63, PRN: -1071.37, INT: -5490.8 });
  assert.deepEqual(amortize(terms, 10, 21), { BAL: 117421.6, PRN: -1507.03, INT: -7242.53 });
  assert.deepEqual(amortize(terms, 22, 33), { BAL: 115819.62, PRN: -1601.98, INT: -7147.58 });
  assert.throws(() => amortize(terms, 5, 4), /payment numbers/);
});

test('TI annual interest and beginning-of-period future value match the guidebook', () => {
  const loan = { N: 360, PV: 75000, PMT: -425.84, FV: 0, PY: 12, CY: 12 };
  assert.equal(round(solveTVM('IY', loan)), 5.5);
  const savings = { N: 240, IY: 7.5, PV: 0, PMT: -200, PY: 12, CY: 12, BGN: true };
  assert.equal(round(solveTVM('FV', savings)), 111438.31);
});

test('TVM solves all registers and distinguishes compounding and payment frequencies', () => {
  const input = { N: 16, IY: 6, PV: -2500, PMT: -75, PY: 4, CY: 12, BGN: true };
  const terms = { ...input, FV: solveTVM('FV', input) };
  for (const key of ['N', 'IY', 'PV', 'PMT'])
    assert.ok(Math.abs(solveTVM(key, terms) - terms[key]) < 1e-7, key);
  const noInterest = { N: 12, IY: 0, PV: 1200, PMT: -100, FV: 0 };
  assert.equal(solveTVM('PMT', noInterest), -100);
  assert.equal(solveTVM('N', noInterest), 12);
  assert.equal(solveTVM('IY', noInterest), 0);
});

test('TI cash-flow example matches NPV and IRR after the guided edits', () => {
  const flows = [-7000, 3000, 4000, 5000, 5000, 5000, 5000];
  assert.equal(round(cashFlowNPV(20, flows)), 7266.44);
  const rate = cashFlowIRR(flows);
  assert.equal(round(rate), 52.71);
  assert.ok(Math.abs(cashFlowNPV(rate, flows)) < 1e-7);
  assert.throws(() => cashFlowIRR([10, 20]), /positive and negative/);
  assert.throws(() => cashFlowNPV(-100, flows), /exceed/);
});
