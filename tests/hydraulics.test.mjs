import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, convertUnit } from '../src/hydraulics.mjs';
import { createExample, createProject, createWorksheet } from '../src/model.mjs';

const example = () => {
  const { project, worksheet } = createExample();
  return { draft: worksheet.draft, limits: project.limits };
};

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function atRe(reynolds) {
  const { draft, limits } = example();
  draft.scenarios = [{
    ...draft.scenarios[0], density: '1024', viscosity: '0.0009765625',
    viscosityUnit: 'Pa·s', flowUnit: 'm³/s',
    flow: String(reynolds * 0.0009765625 / (1024 * 0.125) * (Math.PI / 256)),
  }];
  draft.options = [{ ...draft.options[0], diameter: '125', k: '0' }];
  return calculate(draft, limits).rows[0];
}

test('冷却水支线的四个组合及最大工况变更与独立参考表一致', () => {
  const { draft, limits } = example();
  const original = calculate(draft, limits);
  assert.equal(original.algorithm, 'darcy-weisbach-v1');
  assert.deepEqual(original.issues, []);
  assert.equal(original.rows.length, 4);
  const expected = [[14.34, 5.00], [31.05, 10.79]];
  for (const [i, scenario] of draft.scenarios.entries()) {
    for (const [j, option] of draft.options.entries()) {
      const row = original.rows.find(r => r.scenarioId === scenario.id && r.optionId === option.id);
      near(row.loss / 1000, expected[i][j], 0.0051);
      near(row.elevationPressure / 1000, 39.1089202, 0.001);
      near(row.staticDifference, row.loss + row.elevationPressure, 1e-8);
      assert.equal(row.status, 'pass');
    }
  }
  draft.scenarios[1].flow = '55';
  const revised = calculate(draft, limits);
  const maximum = revised.rows.filter(row => row.scenarioId === draft.scenarios[1].id);
  near(maximum[0].loss / 1000, 45.64, 0.0051);
  near(maximum[1].loss / 1000, 15.82, 0.0051);
  assert.deepEqual(revised.summaries.map(option => option.status), ['fail', 'pass']);
});

test('转换等价的工况、管径、粗糙度和黏度时保持计算值', () => {
  const { draft, limits } = example();
  const original = calculate(draft, limits);
  for (const scenario of draft.scenarios) {
    scenario.flow = convertUnit(scenario.flow, 'flow', 'm³/h', 'L/s');
    scenario.flowUnit = 'L/s';
    scenario.viscosity = '0.00089';
    scenario.viscosityUnit = 'Pa·s';
  }
  for (const option of draft.options) {
    option.diameter = convertUnit(option.diameter, 'diameter', 'mm', 'm');
    option.diameterUnit = 'm';
    option.roughness = '0.000045';
    option.roughnessUnit = 'm';
  }
  const converted = calculate(draft, limits);
  for (const [i, row] of converted.rows.entries()) {
    near(row.velocity, original.rows[i].velocity, 1e-12);
    near(row.loss, original.rows[i].loss, 1e-8);
  }
  assert.equal(convertUnit('', 'flow', 'm³/h', 'L/s'), '');
  assert.equal(convertUnit('无效值', 'flow', 'm³/h', 'L/s'), '无效值');
});

test('层流直管与 Hagen–Poiseuille 独立参考一致，负高差只影响静压差', () => {
  const { draft, limits } = example();
  const option = draft.options[0];
  const scenario = draft.scenarios[0];
  Object.assign(option, { diameter: '100', length: '10', elevation: '-1', k: '0' });
  Object.assign(scenario, { density: '1000', viscosity: '1', flow: String(Math.PI * 0.09) });
  const row = calculate(draft, limits).rows[0];
  assert.equal(row.regime, 'laminar');
  near(row.velocity, 0.01, 1e-12);
  near(row.reynolds, 1000, 1e-8);
  near(row.frictionLoss, 0.32, 1e-10);
  assert.equal(row.localLoss, 0);
  near(row.staticDifference, -9806.33, 1e-8);
  assert.equal(row.status, 'pass');
});

test('过渡区两端均停算，区间以外保留各流态结果', () => {
  assert.equal(atRe(1999).regime, 'laminar');
  assert.equal(atRe(4001).regime, 'turbulent');
  for (const boundary of [2000, 3000, 4000]) {
    const row = atRe(boundary);
    near(row.reynolds, boundary, 1e-10);
    assert.equal(row.regime, 'transition');
    assert.ok(row.velocity > 0 && row.elevationPressure > 0);
    assert.equal(row.frictionFactor, null);
    assert.equal(row.loss, null);
    assert.equal(row.pressureStatus, 'pending');
    assert.equal(row.status, 'pending');
  }
});

test('缺失的限值不判满足，已知超限优先，等于限值时满足', () => {
  const { draft, limits } = example();
  const first = calculate(draft, limits).rows[0];
  draft.limits.velocity = { mode: 'custom', value: String(first.velocity) };
  assert.equal(calculate(draft, limits).rows[0].velocityStatus, 'pass');
  draft.limits.pressure = { mode: 'none', value: '999' };
  assert.equal(calculate(draft, limits).rows[0].status, 'pending');
  draft.limits.velocity.value = '0';
  assert.equal(calculate(draft, limits).rows[0].status, 'fail');
  assert.equal(calculate(draft, limits).summaries[0].status, 'fail');
});

test('缺失 K 保留沿程损失，工况覆盖可明确使用 K=0，流态限制独立生效', () => {
  const { draft, limits } = example();
  const option = draft.options[0];
  option.k = '';
  const first = calculate(draft, limits).rows[0];
  assert.ok(first.frictionLoss > 0);
  assert.equal(first.localLoss, null);
  assert.equal(first.loss, null);
  const [scenario] = draft.scenarios;
  option.kOverrides[scenario.id] = { k: '0', source: '直管无管件', regime: 'laminar' };
  assert.equal(calculate(draft, limits).rows[0].loss, null);
  option.kOverrides[scenario.id].regime = 'turbulent';
  const covered = calculate(draft, limits).rows[0];
  assert.equal(covered.localLoss, 0);
  assert.equal(covered.loss, covered.frictionLoss);
  assert.equal(covered.input.kSource, '直管无管件');
});

test('不合法输入按路径报告，并与有效工况隔离', () => {
  const { draft, limits } = example();
  draft.scenarios[0].flow = '0';
  draft.options[0].roughness = draft.options[0].diameter;
  draft.limits.pressure = { mode: 'custom', value: '-1' };
  const result = calculate(draft, limits);
  assert.deepEqual(result.issues.map(issue => issue.path).sort(), [
    `scenarios.${draft.scenarios[0].id}.flow`, `options.${draft.options[0].id}.roughness`, 'limits.pressure',
  ].sort());
  assert.equal(result.rows[0].velocity, null);
  assert.equal(result.rows[2].frictionLoss, null);
  assert.ok(result.rows[3].loss > 0);
  assert.equal(result.rows[3].status, 'pending');
});

test('不同项目、示例及计算单拥有独立记录', () => {
  const project = createProject('循环水增容改造');
  const first = createWorksheet(project.id);
  const second = createWorksheet(project.id);
  const sample = createExample();
  assert.equal(first.projectId, project.id);
  assert.notEqual(first.id, second.id);
  assert.notEqual(sample.worksheet.id, createExample().worksheet.id);
  assert.equal(first.sequence, 0);
  assert.deepEqual(project.limits, { velocity: '', pressure: '' });
});
