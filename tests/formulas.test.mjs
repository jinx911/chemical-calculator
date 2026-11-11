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

test('新增的十项工艺计算与独立参考值一致', () => {
  const expected = {
    'pipe-loss': 48.6722820825, 'hydrostatic-pressure': 39.1089202, 'pressure-head': 10.2278456668,
    'motor-input': 6, 'latent-heat': 1100, 'mix-temperature': 56, 'volume-flow': 50,
    'gas-flow': 945.1023132205, 'residence-time': 30, 'horizontal-tank': 2.4567393972,
  };
  for (const [id, reference] of Object.entries(expected)) {
    const { outputs } = calculate(id);
    assert(Math.abs(outputs[0] - reference) / reference < 1e-8, id + ': ' + outputs[0]);
  }
  const [total, straight, local] = calculate('pipe-loss').outputs;
  assert.equal(total, straight + local);
  assert.equal(calculate('pipe-loss', { k: { raw: '0' } }).outputs[2], 0);
});

test('气量换算支持绝压单位和绝对温度，拒绝无效温压', () => {
  const gas = calculate('gas-flow', {
    p1: { raw: '2.01325', unit: 'bar' }, t1: { raw: '308.15', unit: 'K' },
  });
  assert(Math.abs(gas.outputs[0] - calculate('gas-flow').outputs[0]) < 1e-9);
  assert.match(calculate('gas-flow', { p2: { raw: '0' } }).errors.p2, /大于 0/);
  assert.match(calculate('gas-flow', { t2: { raw: '-273.15' } }).errors.t2, /绝对温度/);
});

test('卧式圆筒从空罐到满罐按内径校验液深，极低液位仍有有效体积', () => {
  const tank = height => calculate('horizontal-tank', { h: { raw: height } });
  assert.equal(tank('0').outputs[0], 0);
  assert(Math.abs(tank('1').outputs[0] - 2 * Math.PI) < 1e-12);
  assert.deepEqual(tank('2').outputs, [4 * Math.PI, 4 * Math.PI, 100]);
  assert(tank('1e-8').outputs[0] > 0);
  assert.match(tank('2.01').message, /不能超过筒体内径/);
});
