import { formatNumber, formulaDetails, statusLabel } from './presentation.mjs';

const scenarioFields = {
  name: '名称', flow: '流量数值', flowUnit: '流量单位', density: '密度', viscosity: '动力黏度数值',
  viscosityUnit: '动力黏度单位', source: '物性依据',
};
const optionFields = {
  name: '名称', diameter: '实际内径数值', diameterUnit: '内径单位', length: '管长',
  roughness: '绝对粗糙度数值', roughnessUnit: '粗糙度单位', elevation: '高差',
  k: 'K', kSource: 'K 依据', kRegime: 'K 适用流态',
};
const metrics = [
  ['velocity', '流速（m/s）', 1], ['reynolds', '雷诺数', 1], ['frictionFactor', 'Darcy 摩阻因子', 1],
  ['frictionLoss', '沿程损失（kPa）', 0.001], ['localLoss', '局部损失（kPa）', 0.001],
  ['loss', '阻力压降（kPa）', 0.001], ['elevationPressure', '高差压力项（kPa）', 0.001],
  ['staticDifference', '静压差（kPa）', 0.001],
];

function readable(value) {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'number' ? formatNumber(value, 8) : String(value);
}

function addChange(changes, field, before, after) {
  if (Object.is(before, after)) return;
  const oldText = readable(before);
  const newText = readable(after);
  changes.push({
    field,
    before: oldText === newText && typeof before === 'number' ? String(before) : oldText,
    after: oldText === newText && typeof after === 'number' ? String(after) : newText,
  });
}

function compareItems(changes, type, oldItems, newItems, fields, compareExtra) {
  const before = new Map(oldItems.map(item => [item.id, item]));
  const after = new Map(newItems.map(item => [item.id, item]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldItem = before.get(id);
    const newItem = after.get(id);
    const label = type + ' · ' + (newItem?.name || oldItem?.name || '未命名');
    if (!oldItem || !newItem) {
      addChange(changes, label, oldItem ? '已有' : null, newItem ? '新增' : '已删除');
      continue;
    }
    for (const [key, title] of Object.entries(fields)) {
      addChange(changes, label + ' / ' + title, oldItem[key], newItem[key]);
    }
    compareExtra?.(changes, label, oldItem, newItem);
  }
}

function compareOverrides(changes, label, oldItem, newItem, scenarioNames) {
  const before = oldItem.kOverrides ?? {};
  const after = newItem.kOverrides ?? {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    for (const [key, title] of [['k', 'K'], ['source', 'K 依据'], ['regime', 'K 适用流态']]) {
      addChange(changes, label + ' / ' + (scenarioNames.get(id) || '工况') + ' / ' + title,
        before[id]?.[key], after[id]?.[key]);
    }
  }
}

function compareResults(changes, before, after) {
  const key = row => JSON.stringify([row.scenarioId, row.optionId]);
  const oldRows = new Map(before.rows.map(row => [key(row), row]));
  for (const row of after.rows) {
    const previous = oldRows.get(key(row));
    if (!previous) continue;
    const label = row.scenarioName + ' / ' + row.optionName + ' · ';
    for (const [field, title, factor] of metrics) {
      const scaled = result => result[field] == null ? null : result[field] * factor;
      addChange(changes, label + title, scaled(previous), scaled(row));
    }
    for (const [field, title] of [['status', '组合校核'], ['velocityStatus', '流速校核'], ['pressureStatus', '阻力压降校核']]) {
      addChange(changes, label + title, statusLabel(previous[field]), statusLabel(row[field]));
    }
    addChange(changes, label + '计算说明', (previous.diagnostics ?? []).join('；'), (row.diagnostics ?? []).join('；'));
  }
}

export function compareRevisions(before, after) {
  if (!before || !after) return [];
  const changes = [];
  const oldDraft = before.draft;
  const newDraft = after.draft;
  for (const [key, title] of Object.entries({ line: '管线编号', medium: '介质', from: '入口', to: '出口' })) {
    addChange(changes, title, oldDraft[key], newDraft[key]);
  }
  addChange(changes, '计算方法版本', before.algorithm, after.algorithm);
  for (const [key, title, factor] of [['velocity', '流速上限（m/s）', 1], ['pressure', '阻力压降上限（kPa）', 0.001]]) {
    const limit = snapshot => snapshot.calculation.limits[key] == null ? null : snapshot.calculation.limits[key] * factor;
    addChange(changes, title, limit(before), limit(after));
    const mode = { inherit: '继承项目', custom: '计算单自定义', none: '不校核' };
    addChange(changes, title + '来源', mode[oldDraft.limits[key].mode], mode[newDraft.limits[key].mode]);
  }
  const scenarioNames = new Map([...oldDraft.scenarios, ...newDraft.scenarios].map(item => [item.id, item.name]));
  compareItems(changes, '工况', oldDraft.scenarios, newDraft.scenarios, scenarioFields);
  compareItems(changes, '方案', oldDraft.options, newDraft.options, optionFields,
    (...args) => compareOverrides(...args, scenarioNames));
  const selected = draft => draft.options.find(item => item.id === draft.selection.optionId)?.name;
  addChange(changes, '选定方案', selected(oldDraft), selected(newDraft));
  addChange(changes, '选型理由', oldDraft.selection.reason, newDraft.selection.reason);
  compareResults(changes, before.calculation, after.calculation);
  return changes;
}

function element(tag, content) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

function table(headers, rows) {
  const node = element('table');
  const head = node.createTHead().insertRow();
  for (const label of headers) {
    const th = element('th', label);
    th.scope = 'col';
    head.append(th);
  }
  const body = node.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const cell of cells) row.insertCell().textContent = cell;
  }
  return node;
}

function measurement(value, unit) {
  return value == null || value === '' ? '—' : value + ' ' + unit;
}

function addInputs(report, draft, calculation) {
  report.append(element('h2', '输入条件与取值依据'), table(
    ['工况', '体积流量', '密度（kg/m³）', '动力黏度', '物性依据'],
    draft.scenarios.map(item => [item.name, measurement(item.flow, item.flowUnit), readable(item.density),
      measurement(item.viscosity, item.viscosityUnit), readable(item.source)]),
  ), table(['候选方案', '实际内径', '管长（m）', '粗糙度', '高差（m）', 'K 与取值依据'],
    draft.options.map(item => [item.name, measurement(item.diameter, item.diameterUnit), readable(item.length),
      measurement(item.roughness, item.roughnessUnit), readable(item.elevation),
      readable(item.k) + ' / ' + readable(item.kSource)]),
  ));
  const modes = { inherit: '继承项目限值', custom: '计算单自定义', none: '不校核' };
  const velocity = measurement(calculation.limits.velocity, 'm/s');
  const pressure = calculation.limits.pressure == null ? '—' : measurement(calculation.limits.pressure / 1000, 'kPa');
  report.append(element('p', '流速上限 ' + velocity + '（' + modes[draft.limits.velocity.mode] +
    '），阻力压降上限 ' + pressure + '（' + modes[draft.limits.pressure.mode] + '）。'));
}

function formatChecked(value, limit, digits) {
  const display = formatNumber(value, digits);
  if (value == null || limit == null || value === limit || display !== formatNumber(limit, digits)) return display;
  return String(value);
}

function addResults(report, calculation) {
  const headers = ['工况 / 方案', '流速 m/s', '沿程 kPa', '局部 kPa', '阻力 kPa', '高差 kPa', '静压差 kPa', '校核'];
  const rows = calculation.rows.map(row => {
    const kPa = value => value == null ? null : value / 1000;
    const pressure = key => formatNumber(kPa(row[key]), 2);
    return [row.scenarioName + ' / ' + row.optionName, formatChecked(row.velocity, calculation.limits.velocity, 3),
      pressure('frictionLoss'), pressure('localLoss'), formatChecked(kPa(row.loss), kPa(calculation.limits.pressure), 2),
      pressure('elevationPressure'), pressure('staticDifference'),
      statusLabel(row.status)];
  });
  report.append(element('h2', '工况与候选方案比选'), table(headers, rows));
}

function addFormulae(report, calculation) {
  report.append(element('h2', '公式与代入'));
  for (const row of calculation.rows) {
    const section = element('section');
    section.append(element('h3', row.scenarioName + ' / ' + row.optionName));
    for (const item of formulaDetails(row)) section.append(element('p', item.label + '：' + item.value));
    section.append(element('p', '流速校核：' + statusLabel(row.velocityStatus) +
      '；阻力压降校核：' + statusLabel(row.pressureStatus)));
    if (row.diagnostics?.length) section.append(element('p', row.diagnostics.join('；')));
    report.append(section);
  }
}

export function printReport(project, snapshot) {
  const report = document.getElementById('report');
  if (!report) throw new Error('找不到计算书区域。');
  const { draft, calculation } = snapshot;
  const selection = draft.options.find(option => option.id === draft.selection.optionId);
  const version = snapshot.sequence ? '版本 ' + snapshot.sequence : '草稿预览';
  report.replaceChildren(
    element('h1', '管径比选与压降计算书'),
    element('p', (snapshot.projectName || project.name) + ' / ' + draft.line + ' / ' + version),
    element('p', '介质：' + readable(draft.medium) + '；流向：' + readable(draft.from) + ' → ' + readable(draft.to)),
    element('p', '计算时间：' + new Date(snapshot.createdAt).toLocaleString('zh-CN') +
      '；方法版本：' + snapshot.algorithm),
    element('p', '适用范围：稳态、单相、不可压牛顿液体，满流等内径圆管单段，无轴功。'),
  );
  addInputs(report, draft, calculation);
  addResults(report, calculation);
  report.append(element('h2', '选型记录'), element('p', '选定方案：' + (selection?.name ?? '未选定')),
    element('p', '选型理由：' + readable(draft.selection.reason)),
    element('p', '方法来源：美国 EPA EPANET 2.2 · Analysis Algorithms'));
  addFormulae(report, calculation);
  window.print();
}
