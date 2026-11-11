import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/hydraulics.mjs';
import { createExample } from '../src/model.mjs';
import { compareRevisions } from '../src/report.mjs';

function snapshot(draft, limits) {
  const calculation = calculate(draft, limits);
  return { draft: structuredClone(draft), calculation, algorithm: calculation.algorithm };
}

test('version comparison keeps the original inputs and detects only affected combinations', () => {
  const { project, worksheet: { draft } } = createExample();
  const before = snapshot(draft, project.limits);
  draft.scenarios[1].flow = '55';
  draft.selection = { optionId: draft.options[1].id, reason: '最大工况阻力压降在项目限值内' };
  const after = snapshot(draft, project.limits);
  const changes = compareRevisions(before, after);
  assert.deepEqual(changes.find(change => change.field === '工况 · 最大工况 / 流量数值'), {
    field: '工况 · 最大工况 / 流量数值', before: '45', after: '55',
  });
  assert.deepEqual(changes.find(change => change.field === '最大工况 / 内径 102.3 mm · 组合校核'), {
    field: '最大工况 / 内径 102.3 mm · 组合校核', before: '满足', after: '超限',
  });
  assert(changes.some(change => change.field === '选定方案' && change.after === '内径 128.2 mm'));
  assert(!changes.some(change => change.field.includes('正常工况')));
  assert.equal(before.draft.scenarios[1].flow, '45');
  assert.deepEqual(compareRevisions(before, before), []);
});

test('comparison uses stable identities when names or ordering change', () => {
  const { project, worksheet: { draft } } = createExample();
  const before = snapshot(draft, project.limits);
  draft.options.reverse();
  draft.options[0].name = '扩大管径方案';
  const after = snapshot(draft, project.limits);
  assert.deepEqual(compareRevisions(before, after), [
    { field: '方案 · 扩大管径方案 / 名称', before: '内径 128.2 mm', after: '扩大管径方案' },
  ]);
});
