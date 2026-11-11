import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formulas, calculateFormula } from '../src/formulas.mjs';

function calculate(id, overrides = {}) {
  const formula = formulas.find(item => item.id === id);
  const values = Object.fromEntries(formula.fields.map(item => [item.key, {
    raw: String(item.example), unit: Object.keys(item.units)[0], ...overrides[item.key],
  }]));
  return calculateFormula(formula, values);
}

test('九项工艺速算使用已知参考值和正确的工程单位', () => {
  const expected = {
    'pipe-velocity': 1.85874717, 'pipe-diameter': 113.8776, reynolds: 171896.79775,
    'pump-power': 5.33472, 'sensible-heat': 83.6, lmtd: 37.44438,
    'heat-area': 5, 'mass-flow': 54835, blend: 8,
  };
  for (const [id, reference] of Object.entries(expected)) {
    const { outputs } = calculate(id);
    assert(Math.abs(outputs[0] - reference) / reference < 0.001, id + ': ' + outputs[0]);
  }
  assert.equal(calculate('sensible-heat', { dt: { raw: '-20' } }).outputs[0], -83.6);
  assert.equal(calculate('mass-flow', { q: { raw: '0' } }).outputs[0], 0);
});

test('流量和直径换算保持结果一致', () => {
  const result = calculate('pipe-velocity', { q: { raw: String(55 / 3.6), unit: 'L/s' }, d: { raw: '0.1023', unit: 'm' } });
  assert(Math.abs(result.outputs[0] - calculate('pipe-velocity').outputs[0]) < 1e-12);
  assert.equal(calculate('lmtd', { coldOut: { raw: '50' } }).outputs[0], 40);
});

test('非法参数、零分母和换热端温差不适用时不给出结果', () => {
  assert.match(calculate('pump-power', { eff: { raw: '101' } }).errors.eff, /100/);
  assert.match(calculate('reynolds', { mu: { raw: '0' } }).errors.mu, /大于 0/);
  assert.match(calculate('lmtd', { coldOut: { raw: '95' } }).message, /两端/);
  assert.match(calculate('blend', { m1: { raw: '0' }, m2: { raw: '0' } }).message, /至少一股/);
});
