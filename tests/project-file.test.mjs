import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculate } from '../src/hydraulics.mjs';
import { createExample, createWorksheet } from '../src/model.mjs';
import { parseBackup, serializeBackup } from '../src/project-file.mjs';

function fixture() {
  const { project, worksheet } = createExample();
  const calculation = calculate(worksheet.draft, project.limits);
  const snapshot = {
    worksheetId: worksheet.id,
    sequence: 1,
    createdAt: project.createdAt,
    projectName: project.name,
    schemaVersion: 1,
    algorithm: calculation.algorithm,
    draft: structuredClone(worksheet.draft),
    calculation,
  };
  worksheet.sequence = 1;
  worksheet.revision = 2;
  worksheet.draft.scenarios[1].flow = '55';
  const incomplete = createWorksheet(project.id);
  return { project, worksheets: [worksheet, incomplete], revisions: [snapshot] };
}

function roundTrip({ project, worksheets, revisions }) {
  return parseBackup(serializeBackup(project, worksheets, revisions));
}

test('备份导入保留草稿与历史结果，复制项目和计算单标识并重连历史', () => {
  const original = fixture();
  const restored = roundTrip(original);
  assert.notEqual(restored.project.id, original.project.id);
  assert.notEqual(restored.worksheets[0].id, original.worksheets[0].id);
  assert.equal(restored.worksheets[0].projectId, restored.project.id);
  assert.equal(restored.revisions[0].worksheetId, restored.worksheets[0].id);
  assert.equal(restored.worksheets[0].draft.scenarios[1].flow, '55');
  assert.equal(restored.revisions[0].draft.scenarios[1].flow, '45');
  assert.deepEqual(restored.revisions[0].calculation, original.revisions[0].calculation);
  assert.deepEqual(restored.worksheets[1].draft, original.worksheets[1].draft);
  assert.equal(restored.worksheets[0].sequence, 1);
});

test('导入拒绝损坏文件、外部格式和未来版本', () => {
  const { project, worksheets, revisions } = fixture();
  const payload = JSON.parse(serializeBackup(project, worksheets, revisions));
  assert.throws(() => parseBackup('{'), /无法读取/);
  assert.throws(() => parseBackup('{}'), /不是工艺计算工作台/);
  assert.throws(() => parseBackup(JSON.stringify({ ...payload, schemaVersion: 2 })), /版本不受支持/);
});

test('导入在创建副本之前拒绝无效引用、重复记录和缺失快照', () => {
  for (const invalidate of [
    ({ worksheets }) => { worksheets[0].projectId = 'other-project'; },
    ({ worksheets }) => { worksheets[0].draft.options[0].kOverrides = { missing: { k: '0', source: '', regime: 'any' } }; },
    ({ revisions }) => { revisions[0].calculation.rows[0].scenarioId = 'missing-scenario'; },
    ({ revisions }) => { revisions.push(revisions[0]); },
    ({ revisions }) => { revisions.pop(); },
  ]) {
    const source = fixture();
    invalidate(source);
    const file = serializeBackup(source.project, source.worksheets, source.revisions);
    assert.throws(() => parseBackup(file, () => assert.fail('无效文件不应生成项目副本标识')), /无效/);
  }
});

test('导入拒绝非有限数，保留合法零值和带符号高差', () => {
  const original = fixture();
  const option = original.worksheets[0].draft.options[0];
  option.k = '0';
  option.elevation = '-4';
  const restored = roundTrip(original);
  assert.equal(restored.worksheets[0].draft.options[0].k, '0');
  assert.equal(restored.worksheets[0].draft.options[0].elevation, '-4');
  original.revisions[0].draft.options[0].k = '1e999';
  assert.throws(() => roundTrip(original), /\.k 无效/);
  original.revisions[0].draft.options[0].k = '0';
  original.revisions[0].calculation.rows[0].loss = -12;
  assert.throws(() => roundTrip(original), /\.loss 无效/);
});

test('待修正的草稿输入可备份和恢复', () => {
  const original = fixture();
  original.worksheets[0].draft.scenarios[0].flow = '尚待确认';
  const restored = roundTrip(original);
  const draft = restored.worksheets[0].draft;
  assert.equal(draft.scenarios[0].flow, '尚待确认');
  assert(calculate(draft, restored.project.limits).issues.some(issue => issue.path.endsWith('.flow')));
});
