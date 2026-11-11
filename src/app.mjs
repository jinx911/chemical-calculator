import { calculate, convertUnit, UNITS } from './hydraulics.mjs';
import { createExample, createOption, createProject, createScenario, createWorksheet, scenarioLabel, optionLabel } from './model.mjs';
import { openStorage } from './storage.mjs';
import { serializeBackup } from './project-file.mjs';
import { compareRevisions, printReport } from './report.mjs';
import { formatNumber, formulaDetails, regimeLabel, statusLabel } from './presentation.mjs';

const workspace = document.querySelector('#workspace');
const sidebar = document.querySelector('#sidebar');
const notice = document.querySelector('#notice');
const importInput = document.querySelector('#import-project');
const state = {
  storage: null, projects: [], worksheets: [], revisions: [], project: null, worksheet: null,
  projectDirty: false, draftDirty: false, projectEdit: 0, draftEdit: 0, pending: null,
  saveQueue: Promise.resolve(), timer: null, busy: false, from: null, to: null,
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const regimeChoices = [['any', '所有适用流态'], ['laminar', '仅层流'], ['turbulent', '仅湍流']];
const pressure = (value, digits = 2) => formatNumber(value == null ? null : value / 1000, digits);
const safeName = (value, fallback) => value?.trim() || fallback;
const option = ([value, label], selected) =>
  `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
const optionsHtml = (options, selected) => options.map(item => option(item, selected)).join('');
const badge = status => `<span class="status ${['pass', 'fail', 'pending'].includes(status) ? status : 'pending'}">${esc(statusLabel(status))}</span>`;
const action = (label, key, css = '', attr = '') =>
  `<button type="button" class="button ${css}" data-action="${key}" ${attr}>${label}</button>`;

let noticeTimer;
function announce(message, isError = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
  if (!isError) noticeTimer = setTimeout(() => { notice.hidden = true; }, 3200);
}

function rememberLocation() {
  try {
    if (state.project) {
      sessionStorage.setItem('chemical-calculator.active', JSON.stringify([state.project.id, state.worksheet?.id]));
    } else {
      sessionStorage.removeItem('chemical-calculator.active');
    }
  } catch {
    // Location restoration is optional when the browser restricts session storage.
  }
}

function setSaveStatus(message) {
  const field = document.querySelector('#save-status');
  if (field) field.textContent = message;
}

async function writeChanges() {
  if (state.projectDirty) {
    const edit = state.projectEdit;
    const saved = await state.storage.putProject(structuredClone(state.project));
    if (state.projectEdit === edit) {
      state.project = saved ?? state.project;
      state.projectDirty = false;
    }
    state.projects = state.projects.map(project => project.id === saved?.id ? saved : project);
  }
  if (state.draftDirty) {
    const edit = state.draftEdit;
    const saved = await state.storage.saveDraft(structuredClone(state.worksheet));
    state.worksheet = state.draftEdit === edit
      ? saved
      : { ...state.worksheet, revision: saved.revision, updatedAt: saved.updatedAt };
    state.worksheets = state.worksheets.map(sheet => sheet.id === saved.id ? state.worksheet : sheet);
    state.draftDirty = state.draftEdit !== edit;
  }
  if (state.projectDirty || state.draftDirty) {
    scheduleSave();
  } else {
    setSaveStatus('草稿已保存到此浏览器');
  }
}

function flushSave() {
  clearTimeout(state.timer);
  const pending = state.saveQueue.catch(() => {}).then(writeChanges);
  state.saveQueue = pending;
  return pending;
}

function scheduleSave() {
  clearTimeout(state.timer);
  setSaveStatus('正在保存草稿…');
  state.timer = setTimeout(() => {
    flushSave().catch(error => {
      setSaveStatus('草稿尚未保存，可导出项目文件');
      announce(error.message, true);
    });
  }, 250);
}

function run(task, { flush = true } = {}) {
  return async (...args) => {
    if (state.busy) return;
    state.busy = true;
    try {
      if (flush) {
        do {
          await flushSave();
        } while (state.projectDirty || state.draftDirty);
      }
      await task(...args);
    } catch (error) {
      if (state.projectDirty || state.draftDirty) setSaveStatus('草稿尚未保存，可导出项目文件');
      announce(error.message || '操作未完成，请重试。', true);
    } finally {
      state.busy = false;
    }
  };
}

function field(label, path, value, { wide, numeric, unit, select, textarea, disabled } = {}) {
  const id = `field-${path}`;
  const props = `id="${esc(id)}" data-path="${esc(path)}" aria-describedby="${esc(id)}-error"${disabled ? ' disabled' : ''}`;
  let control = `<input ${props} type="text" ${numeric ? 'inputmode="decimal" spellcheck="false"' : ''} value="${esc(value)}">`;
  if (textarea) control = `<textarea ${props} rows="2">${esc(value)}</textarea>`;
  if (select) control = `<select ${props}>${optionsHtml(select, value)}</select>`;
  if (unit) {
    control = `<div class="field-group">${control}<select aria-label="${esc(label)}单位" data-unit="${unit.quantity}" data-path="${esc(unit.path)}">${optionsHtml(UNITS[unit.quantity].map(item => [item, item]), unit.value)}</select></div>`;
  }
  return `<div class="field${wide ? ' wide' : ''}"><label for="${esc(id)}">${label}</label>${control}<span class="field-error" id="${esc(id)}-error"></span></div>`;
}

function section(title, body, buttons = '', attributes = '') {
  return `<section class="section" ${attributes}><header class="section-head"><h2>${title}</h2>${buttons}</header>${body}</section>`;
}

function renderSidebar() {
  const projectButtons = state.projects.map(project =>
    `<button type="button" data-action="open-project" data-id="${esc(project.id)}" ${project.id === state.project?.id && !state.worksheet ? 'aria-current="page"' : ''}>${esc(project.name)}</button>`);
  const sheetButtons = state.worksheets.map(sheet =>
    `<button type="button" data-action="open-worksheet" data-id="${esc(sheet.id)}" ${sheet.id === state.worksheet?.id ? 'aria-current="page"' : ''}>${esc(safeName(sheet.draft.line, '新计算单'))}<small>${sheet.sequence ? `已存 ${sheet.sequence} 个版本` : '草稿'}</small></button>`);
  sidebar.innerHTML = `
    <button type="button" class="side-action" data-action="home">工作台首页</button>
    <h2>项目</h2><div class="side-list">${projectButtons.join('')}${!projectButtons.length ? '<p class="hint">暂无项目</p>' : ''}</div>
    <button type="button" class="side-action" data-action="new-project">＋ 新建项目</button>
    ${state.project ? `<h2>计算单</h2><div class="side-list">${sheetButtons.join('')}</div><button type="button" class="side-action" data-action="new-worksheet">＋ 新建计算单</button>` : ''}
  `;
}

function renderHome() {
  return `
    <section class="hero" aria-labelledby="home-title">
      <h1 id="home-title">比较管径，校核压降</h1>
      <p>填入正常和最大流量，比较不同管径下的流速和压降，看看哪些方案满足你的项目限值。</p>
      <div class="toolbar">
        ${action('开始管径比选', 'start-calculation', 'primary')}
        ${action('试算冷却水管线', 'example', 'secondary', 'id="open-example"')}
      </div>
    </section>
    <section class="section home-files">
      <header class="section-head"><div><h2>继续已有项目</h2><p class="muted">用自己保存或同事发来的项目文件继续修改和计算。</p></div>
      ${action('打开项目文件', 'select-import')}</header>
    </section>
  `;
}

function projectLimits(project) {
  return `<div class="grid">
    ${field('项目流速上限（m/s）', 'project.limits.velocity', project.limits.velocity, { numeric: true })}
    ${field('项目阻力压降上限（kPa）', 'project.limits.pressure', project.limits.pressure, { numeric: true })}
  </div><p class="hint">留空表示未设置。计算单可继承项目限值，也可单独设置。</p>`;
}

function renderProject() {
  const project = state.project;
  const sheets = state.worksheets.map(sheet => `<li>${action(esc(safeName(sheet.draft.line, '新计算单')), 'open-worksheet', '', `data-id="${esc(sheet.id)}"`)} <span class="hint">${sheet.sequence ? `V${sheet.sequence}` : '草稿'}</span></li>`);
  return `
    <div class="page-title"><p class="crumb">本机项目</p><h1>${esc(project.name)}</h1></div>
    <div class="toolbar top-actions">${action('添加管线计算', 'new-worksheet', 'primary')}</div>
    ${section('计算单', sheets.length ? `<ul>${sheets.join('')}</ul>` : '<p class="muted">创建计算单后可填写工况和候选管径。</p>')}
    ${section('项目限值', projectLimits(project))}
    ${renderProjectFile()}
    <p class="hint" id="save-status" role="status">保存在此浏览器</p>
  `;
}

function renderProjectFile() {
  return section('备份或交给同事继续算',
    '<p class="muted">项目文件包含输入、草稿和历史版本。换电脑或交给同事时，从工作台首页点「打开项目文件」即可继续。</p>',
    action('下载项目文件', 'export', '', 'id="export-project"'));
}

function inputUnit(path, key, row) {
  return { quantity: key, path: `${path}.${key}Unit`, value: row[`${key}Unit`] };
}

function scenarioCard(row, index, count) {
  const path = `scenarios.${row.id}`;
  return `<article class="card"><header><h3>工况 ${index + 1}</h3>
    ${action('移除', 'remove-scenario', 'small remove', `data-id="${esc(row.id)}" aria-label="移除工况 ${index + 1}" ${count <= 1 ? 'disabled' : ''}`)}
    </header><div class="grid">
      ${field('工况名称（可选）', `${path}.name`, row.name, { wide: true })}
      ${field('体积流量', `${path}.flow`, row.flow, { numeric: true, unit: inputUnit(path, 'flow', row) })}
      ${field('密度（kg/m³）', `${path}.density`, row.density, { numeric: true })}
      ${field('动力黏度', `${path}.viscosity`, row.viscosity, { numeric: true, unit: inputUnit(path, 'viscosity', row) })}
      ${field('物性来源（可选）', `${path}.source`, row.source, { wide: true })}
    </div></article>`;
}

function overrides(row, scenarios, path) {
  return `<details data-key="${esc(path)}-overrides"><summary>给个别工况单独填写 K 值</summary>
    ${scenarios.map((scenario, index) => {
      const item = row.kOverrides[scenario.id] ?? {};
      const base = `${path}.kOverrides.${scenario.id}`;
      return `<div class="grid"><h3 class="wide" data-override-scenario="${esc(scenario.id)}">${esc(scenarioLabel(scenario, index))}</h3>
        ${field('该工况的 K 值', `${base}.k`, item.k ?? '', { numeric: true })}
        ${field('适用流态', `${base}.regime`, item.regime ?? 'any', { select: regimeChoices })}
        ${field('K 值依据', `${base}.source`, item.source ?? '', { wide: true })}</div>`;
    }).join('')}<p class="hint">该工况的 K 值留空时，使用方案的默认值。</p></details>`;
}

function optionCard(row, index, count, scenarios) {
  const path = `options.${row.id}`;
  return `<article class="card"><header><h3>方案 ${index + 1}</h3>
    ${action('移除', 'remove-option', 'small remove', `data-id="${esc(row.id)}" aria-label="移除方案 ${index + 1}" ${count <= 1 ? 'disabled' : ''}`)}
    </header><div class="grid">
      ${field('方案名称（可选）', `${path}.name`, row.name, { wide: true })}
      ${field('实际内径', `${path}.diameter`, row.diameter, { numeric: true, unit: inputUnit(path, 'diameter', row) })}
      ${field('管长（m）', `${path}.length`, row.length, { numeric: true })}
      ${field('绝对粗糙度', `${path}.roughness`, row.roughness, { numeric: true, unit: inputUnit(path, 'roughness', row) })}
      ${field('出口减入口高差（m）', `${path}.elevation`, row.elevation, { numeric: true })}
      ${field('管件总阻力系数 K', `${path}.k`, row.k, { numeric: true })}
      ${field('适用流态', `${path}.kRegime`, row.kRegime, { select: regimeChoices })}
      ${field('K 值依据', `${path}.kSource`, row.kSource, { wide: true })}
    </div>${overrides(row, scenarios, path)}</article>`;
}

const limitFields = [['velocity', '流速', 'm/s'], ['pressure', '阻力压降', 'kPa']];

function worksheetLimits(draft) {
  return `<div class="grid">
    ${limitFields.map(([key, label, unit]) => {
      const setting = draft.limits[key];
      const value = setting.mode === 'inherit' ? state.project.limits[key]
        : setting.mode === 'custom' ? setting.value : '';
      return `<div>${field(`${label}上限（${unit}）`, `limits.${key}.value`, value,
        { numeric: true })}<div class="limit-source">
          <span class="hint" data-limit-source="${key}"></span>
          ${action('恢复项目上限', 'inherit-limit', 'small', `data-id="${key}" hidden`)}
        </div></div>`;
    }).join('')}
  </div><p class="hint">按项目规定填写。留空的项目只计算数值；高差压力项不计入阻力压降上限。</p>`;
}

function updateLimitHints() {
  for (const [key] of limitFields) {
    const setting = state.worksheet.draft.limits[key];
    const inherited = setting.mode === 'inherit';
    const input = document.querySelector(`[data-path="limits.${key}.value"]`);
    document.querySelector(`[data-limit-source="${key}"]`).textContent = input.value.trim() === ''
      ? '未设置上限' : inherited ? '沿用项目上限' : '仅用于这条管线';
    document.querySelector(`[data-action="inherit-limit"][data-id="${key}"]`).hidden =
      inherited || !state.project.limits[key];
  }
}

function formatDate(date) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('zh-CN', { hour12: false });
}

function renderWorksheet() {
  const { draft } = state.worksheet;
  const selection = [['', '暂未选定'], ...draft.options.map((item, index) => [item.id, optionLabel(item, index)])];
  return `
    <div class="page-title">
      <p class="crumb">${esc(state.project.name)} / 管径与压降</p>
      <h1 id="sheet-title">${esc(safeName(draft.line, '新建管线比选'))}</h1>
      <nav class="toolbar top-actions" aria-label="计算单操作">
        <a class="button" href="#conditions-panel">填写计算条件</a>
        <a class="button" href="#versions-panel">历史版本与计算书</a>
        <span class="hint" id="save-status" role="status">${state.draftDirty ? '正在保存草稿…' : '草稿已保存到此浏览器'}</span>
      </nav>
    </div>
    <section class="section results-panel" id="results-panel" aria-labelledby="results-title">
      <header class="section-head result-head"><div><h2 id="results-title">管径比选结果</h2><p class="muted">更改流量、管径或限值后，结果会自动更新。</p></div>
        <a class="button" id="handoff-link" href="#handoff-panel" hidden>记录选型并出计算书</a>
      </header>
      <div id="results"></div>
    </section>
    <div class="conditions-head" id="conditions-panel">
      <h2>计算条件</h2><a href="#results-panel">返回比选结果</a>
    </div>
    ${section('工况', `<p class="hint reuse-hint">新增工况沿用上一工况的物性，可修改。每个工况单独填写流量。</p><div class="cards">${draft.scenarios.map((row, index) => scenarioCard(row, index, draft.scenarios.length)).join('')}</div>`, action('＋ 添加工况', 'add-scenario', 'small'))}
    ${section('候选管径', `<p class="hint reuse-hint">新增方案沿用上一方案的管长、粗糙度和高差，可修改。实际内径和 K 值单独填写。确认无局部损失时，K 填 0。</p><div class="cards">${draft.options.map((row, index) => optionCard(row, index, draft.options.length, draft.scenarios)).join('')}</div>`, action('＋ 添加候选管径', 'add-option', 'small'))}
    ${section('校核限值', worksheetLimits(draft), '', 'id="limits-panel"')}
    ${section('计算书上的管线资料', `<div class="grid">
      ${field('管线编号或名称', 'line', draft.line)}${field('液体介质', 'medium', draft.medium)}
      ${field('入口位置', 'from', draft.from)}${field('出口位置', 'to', draft.to)}
    </div>`)}
    ${section('选型与计算书', `<div class="grid">
      ${field('选定方案', 'selection.optionId', draft.selection.optionId || '', { select: selection })}
      ${field('选型理由', 'selection.reason', draft.selection.reason, { textarea: true })}
    </div>
    <p class="hint" id="handoff-hint"></p>
    <div class="toolbar handoff-actions">
      ${action('保存并打印计算书', 'save-and-print', 'primary', 'id="save-print"')}
      ${action('仅保存本次结果', 'save-version', '', 'id="save-version"')}
    </div>`, '', 'id="handoff-panel"')}
    ${section('历史版本与计算书', '<div id="versions"></div>', '', 'id="versions-panel"')}
    ${renderProjectFile()}
  `;
}

function compareValue(value, limit, digits, formatter) {
  const displayed = formatter(value, digits);
  if (value == null || limit == null || value === limit || displayed !== formatter(limit, digits)) return displayed;
  return Number(value.toPrecision(14)).toString();
}

function rowConclusion(row) {
  if (row.velocityStatus === 'fail' && row.pressureStatus === 'fail') return '流速和压降均超限';
  if (row.velocityStatus === 'fail') return '流速超限';
  if (row.pressureStatus === 'fail') return '压降超限';
  if (row.status === 'pass') return '满足限值';
  if (row.loss == null) return '待确认压降';
  return '待填写校核上限';
}

function renderRow(row, limits) {
  const key = `${row.scenarioId}:${row.optionId}`;
  const loss = row.loss == null ? null : row.loss / 1000;
  const limit = limits.pressure == null ? null : limits.pressure / 1000;
  return `<tr>
    <td>${esc(row.scenarioName)}</td><td>${esc(row.optionName)}</td>
    <td class="num">${esc(compareValue(row.velocity, limits.velocity, 3, formatNumber))}</td>
    <td class="num">${esc(compareValue(loss, limit, 2, formatNumber))}</td>
    <td><span class="status ${esc(row.status)}">${rowConclusion(row)}</span></td><td>${action('查看计算依据', 'row-details', 'small', `data-id="${esc(key)}" aria-controls="formula-detail" aria-expanded="${key === state.openRow}"`)}</td>
  </tr>`;
}

function renderFormula(row, limits) {
  const panel = document.querySelector('#formula-detail');
  if (!panel || !row) return;
  panel.className = 'result-detail';
  panel.innerHTML = `
    <h3>${esc(row.scenarioName)} · ${esc(row.optionName)}</h3>
    <p class="detail-pressures">沿程损失 ${esc(pressure(row.frictionLoss))} kPa · 局部损失 ${esc(pressure(row.localLoss))} kPa · 高差压力项 ${esc(pressure(row.elevationPressure))} kPa · 进出口静压差 ${esc(pressure(row.staticDifference))} kPa</p>
    <p class="hint">${esc(regimeLabel(row.regime))} · 流速 ${badge(row.velocityStatus)} · 阻力压降 ${badge(row.pressureStatus)}</p>
    <p class="hint">生效限值：流速 ${limits.velocity == null ? '未设置' : `${esc(formatNumber(limits.velocity, 8))} m/s`}，阻力压降 ${limits.pressure == null ? '未设置' : `${esc(pressure(limits.pressure, 8))} kPa`}</p>
    ${row.diagnostics?.length ? `<ul class="hint">${row.diagnostics.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
    <dl>${formulaDetails(row).map(item => `<dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd>`).join('')}</dl>`;
}

function displayIssues(issues) {
  const messages = new Map(issues.map(issue => [issue.path, issue.message]));
  const fieldPaths = new Set();
  for (const input of workspace.querySelectorAll('[data-path]')) {
    const path = input.dataset.path;
    const lookup = path.startsWith('limits.') && path.endsWith('.value') && !input.disabled
      ? path.slice(0, -'.value'.length) : path;
    fieldPaths.add(lookup);
    const message = input.value.trim() === '' ? null : messages.get(lookup);
    const output = input.id ? document.getElementById(`${input.id}-error`) : null;
    if (output) output.textContent = message || '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  const remaining = issues.filter(issue => !fieldPaths.has(issue.path));
  return remaining.map(issue => `<p class="field-error">${esc(issue.message)}</p>`).join('');
}

function renderResults() {
  const target = document.querySelector('#results');
  if (!state.worksheet || !target) return;
  const { draft } = state.worksheet;
  const result = calculate(draft, state.project.limits);
  state.pending = result;
  const unplaced = displayIssues(result.issues);
  const active = result.rows.find(row => `${row.scenarioId}:${row.optionId}` === state.openRow);
  const valid = result.rows.some(row => Number.isFinite(row.velocity));
  const complete = result.issues.length === 0 && valid;
  document.querySelector('#save-version').disabled = !complete;
  document.querySelector('#save-print').disabled = !complete;
  document.querySelector('#handoff-link').hidden = !valid;
  document.querySelector('#handoff-hint').textContent = complete
    ? '发给同事复核时，可在打印窗口选择「另存为 PDF」。'
    : '填完计算条件后，可在这里保存结果或打印计算书。';
  updateLimitHints();
  const summary = result.summaries.map(({ optionId, status }) => {
    const index = draft.options.findIndex(option => option.id === optionId);
    const rows = result.rows.filter(row => row.optionId === optionId);
    const failed = rows.filter(row => row.status === 'fail');
    const note = status === 'pass' ? '所有工况均满足限值'
      : failed.length ? failed.map(row => row.scenarioName + ' ' + rowConclusion(row)).join('；')
      : '部分工况缺少条件或限值';
    const selected = draft.selection.optionId === optionId;
    const select = rows.some(row => row.loss != null)
      ? action(selected ? '已选定' : '选用此管径', 'choose-option', 'small',
        `data-id="${esc(optionId)}" aria-label="${esc((selected ? '已选定 ' : '选用 ') + optionLabel(draft.options[index], index))}"`)
      : '';
    return `<div class="summary-card ${esc(status)}">
      <div class="summary-text"><strong>${esc(optionLabel(draft.options[index], index))}</strong><span>${esc(note)}</span></div>${select}
    </div>`;
  }).join('');
  target.innerHTML = `
    ${unplaced}
    ${!valid ? '<div class="empty-result"><p>填好流量、物性和候选管径后，这里会显示比选结果。</p><a href="#conditions-panel">填写流量和管径</a></div>' : ''}
    ${valid && !complete ? '<p class="hint">部分条件还没填完。检查并补齐后，即可保存本次结果。</p>' : ''}
    ${valid ? `<p class="hint result-limits">流速上限 ${result.limits.velocity == null ? '未设置' : esc(formatNumber(result.limits.velocity, 8)) + ' m/s'} · 阻力压降上限 ${result.limits.pressure == null ? '未设置' : esc(pressure(result.limits.pressure, 8)) + ' kPa'} <a href="#limits-panel">修改限值</a></p>` : ''}
    ${valid && summary ? `<div class="report-summary">${summary}</div>` : ''}
    ${valid ? `<div class="table-wrap" tabindex="0" aria-label="工况比选表">
      <table><thead><tr><th scope="col">工况</th><th scope="col">候选管径</th><th scope="col">流速（m/s）</th>
      <th scope="col">阻力压降（kPa）</th>
      <th scope="col">校核结论</th><th scope="col">计算依据</th></tr></thead>
      <tbody>${result.rows.map(row => renderRow(row, result.limits)).join('')}</tbody></table>
    </div>` : ''}
    <div id="formula-detail"${active ? '' : ' hidden'}></div>`;
  if (active) renderFormula(active, result.limits);
}

function renderDiff() {
  const panel = document.querySelector('#version-diff');
  if (!panel) return;
  const before = state.revisions.find(snapshot => snapshot.sequence === state.from);
  const after = state.revisions.find(snapshot => snapshot.sequence === state.to);
  if (!before || !after || before === after) {
    panel.innerHTML = '<p class="hint">请选择两个不同版本查看差异。</p>';
    return;
  }
  const changes = compareRevisions(before, after);
  panel.innerHTML = changes.length ? `<div class="table-wrap" tabindex="0" aria-label="版本差异表">
    <table><thead><tr><th scope="col">变更项</th><th scope="col">第 ${before.sequence} 版</th><th scope="col">第 ${after.sequence} 版</th></tr></thead>
    <tbody>${changes.map(change => `<tr><td>${esc(change.field)}</td><td>${esc(change.before)}</td><td>${esc(change.after)}</td></tr>`).join('')}</tbody></table>
    </div>` : '<p class="hint">两个版本的输入、结果和选型记录一致。</p>';
}

function renderVersions() {
  const panel = document.querySelector('#versions');
  if (!panel) return;
  if (!state.revisions.length) {
    panel.innerHTML = '<p class="muted">在「选型与计算书」保存结果后，可以在这里找回计算书。条件变更后再保存一版，就能对比差异。</p>';
    return;
  }
  const [latest, previous] = state.revisions;
  if (!state.revisions.some(snapshot => snapshot.sequence === state.to)) state.to = latest.sequence;
  if (!state.revisions.some(snapshot => snapshot.sequence === state.from)) state.from = (previous ?? latest).sequence;
  const choices = state.revisions.map(snapshot => [snapshot.sequence, `第 ${snapshot.sequence} 版 · ${formatDate(snapshot.createdAt)}`]);
  panel.innerHTML = `<div class="grid">
    <div class="field"><label for="version-from">与哪一版比较</label><select id="version-from">${optionsHtml(choices, state.from)}</select></div>
    <div class="field"><label for="version-to">查看哪一版</label><select id="version-to">${optionsHtml(choices, state.to)}</select></div>
  </div><div class="toolbar" style="margin-top:10px">${action('打印或另存计算书', 'print-version', 'primary', 'id="print-version"')}</div>
  <p class="hint">计算书适合发给同事复核，包含所选版本的输入、公式和结果。在打印窗口选择「另存为 PDF」即可下载。</p>
  <div id="version-diff"></div>`;
  renderDiff();
}

function render({ preserve = false } = {}) {
  const focus = preserve ? document.activeElement?.dataset.path : null;
  const expanded = preserve
    ? new Set([...workspace.querySelectorAll('details[open][data-key]')].map(item => item.dataset.key))
    : new Set();
  renderSidebar();
  workspace.innerHTML = state.worksheet ? renderWorksheet() : state.project ? renderProject() : renderHome();
  renderResults();
  renderVersions();
  for (const item of workspace.querySelectorAll('details[data-key]')) item.open = expanded.has(item.dataset.key);
  if (focus) document.getElementById(`field-${focus}`)?.focus({ preventScroll: true });
}

function updateValue(path, value) {
  if (path.startsWith('project.')) {
    const [, , key] = path.split('.');
    const input = document.getElementById(`field-${path}`);
    const valid = value.trim() === '' || (/^\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value) * (key === 'pressure' ? 1000 : 1)));
    if (valid) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
    document.getElementById(`field-${path}-error`).textContent = valid ? '' : '输入大于或等于 0 的数，或留空。';
    if (!valid) return;
    state.project.limits[key] = value.trim();
    state.projectEdit += 1;
    state.projectDirty = true;
    scheduleSave();
    return;
  }
  const draft = state.worksheet?.draft;
  if (!draft) return;
  const [group, id, key, scenarioId, overrideKey] = path.split('.');
  if (group === 'scenarios' || group === 'options') {
    const row = draft[group].find(item => item.id === id);
    if (!row) return;
    if (key === 'kOverrides') {
      row.kOverrides[scenarioId] ??= { k: '', source: '', regime: 'any' };
      row.kOverrides[scenarioId][overrideKey] = value;
    } else {
      row[key] = value;
    }
  } else if (group === 'limits') draft.limits[id] = { mode: 'custom', value };
  else if (group === 'selection') draft.selection[id] = value;
  else draft[group] = value;
  markDraftEdited();
}

function markDraftEdited() {
  state.draftDirty = true;
  state.draftEdit += 1;
  scheduleSave();
}

function updateUnit(control) {
  const [group, id, key] = control.dataset.path.split('.');
  const row = state.worksheet.draft[group].find(item => item.id === id);
  const quantity = control.dataset.unit;
  row[quantity] = convertUnit(row[quantity], quantity, row[key], control.value);
  document.getElementById(`field-${group}.${id}.${quantity}`).value = row[quantity];
  updateValue(control.dataset.path, control.value);
}

function handleInput(event) {
  const control = event.target;
  if (!control.dataset.path || control.tagName === 'SELECT') return;
  updateValue(control.dataset.path, control.value);
  const [group, id, key] = control.dataset.path.split('.');
  if (group === 'line') {
    document.querySelector('#sheet-title').textContent = safeName(control.value, '新建管线比选');
    state.worksheets = state.worksheets.map(sheet => sheet.id === state.worksheet.id ? state.worksheet : sheet);
    renderSidebar();
  }
  if (key === 'name' && group === 'scenarios') {
    const index = state.worksheet.draft.scenarios.findIndex(item => item.id === id);
    for (const title of workspace.querySelectorAll('[data-override-scenario]')) {
      if (title.dataset.overrideScenario === id) title.textContent = safeName(control.value, `工况 ${index + 1}`);
    }
  }
  if ((key === 'name' || key === 'diameter') && group === 'options') updateSelectionLabel(id);
  renderResults();
}

function updateSelectionLabel(id) {
  const select = document.getElementById('field-selection.optionId');
  const index = state.worksheet.draft.options.findIndex(item => item.id === id);
  const item = [...select.options].find(choice => choice.value === id);
  if (item && index >= 0) item.textContent = optionLabel(state.worksheet.draft.options[index], index);
}

function handleChange(event) {
  const control = event.target;
  if (control.id === 'version-from' || control.id === 'version-to') {
    state[control.id === 'version-from' ? 'from' : 'to'] = Number(control.value);
    renderDiff();
    return;
  }
  if (!control.dataset.path || control.tagName !== 'SELECT') return;
  if (control.dataset.unit) updateUnit(control);
  else updateValue(control.dataset.path, control.value);
  if (control.dataset.path.startsWith('options.') && control.dataset.path.endsWith('.diameterUnit')) {
    updateSelectionLabel(control.dataset.path.split('.')[1]);
  }
  renderResults();
}

function resetViews() {
  state.openRow = null;
  state.from = null;
  state.to = null;
  state.revisions = [];
}

async function openProject(project, sheetId, { openSingleSheet = false } = {}) {
  state.worksheets = await state.storage.listWorksheets(project.id);
  state.project = project;
  state.worksheet = null;
  resetViews();
  const target = sheetId ?? (openSingleSheet && state.worksheets.length === 1 ? state.worksheets[0].id : null);
  if (target) {
    const worksheet = state.worksheets.find(sheet => sheet.id === target);
    if (worksheet) {
      state.worksheet = worksheet;
      state.revisions = await state.storage.listRevisions(worksheet.id);
    }
  }
  rememberLocation();
  render();
  window.scrollTo(0, 0);
}

function openHome() {
  state.project = null;
  state.worksheet = null;
  state.worksheets = [];
  resetViews();
  rememberLocation();
  render();
  window.scrollTo(0, 0);
}

function requestProjectName(forCalculation = false) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'form-dialog';
    dialog.innerHTML = `<form method="dialog">
      <h2>${forCalculation ? '开始管径比选' : '新建项目'}</h2><div class="field"><label for="new-name">项目名称</label><input id="new-name" required maxlength="160" autofocus></div>
      ${forCalculation ? '<div class="field dialog-pipe"><label for="new-line">管线编号或名称（可选）</label><input id="new-line" maxlength="160"></div>' : ''}
      <div class="toolbar"><button class="button" type="button" data-cancel>取消</button><button class="button primary" type="submit">${forCalculation ? '填写计算条件' : '创建项目'}</button></div>
    </form>`;
    document.body.append(dialog);
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'create' ? {
        name: dialog.querySelector('#new-name').value.trim(),
        line: dialog.querySelector('#new-line')?.value.trim() ?? '',
      } : null;
      dialog.remove();
      resolve(value);
    }, { once: true });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (dialog.querySelector('input').value.trim()) dialog.close('create');
    });
    dialog.showModal();
  });
}

async function saveVersion(reuseLatest = false) {
  const sheet = structuredClone(state.worksheet);
  const result = calculate(sheet.draft, state.project.limits);
  if (result.issues.length || !result.rows.some(row => Number.isFinite(row.velocity))) {
    announce('请先补齐计算参数。', true);
    return;
  }
  const latest = state.revisions[0];
  if (reuseLatest && latest && latest.algorithm === result.algorithm &&
      JSON.stringify(latest.draft) === JSON.stringify(sheet.draft) &&
      JSON.stringify(latest.calculation.limits) === JSON.stringify(result.limits)) {
    return latest;
  }
  const edit = state.draftEdit;
  const { worksheet, snapshot } = await state.storage.saveRevision(sheet, result);
  state.worksheet = state.draftEdit === edit
    ? worksheet
    : { ...state.worksheet, sequence: worksheet.sequence, revision: worksheet.revision, updatedAt: worksheet.updatedAt };
  state.worksheets = state.worksheets.map(item => item.id === worksheet.id ? state.worksheet : item);
  const former = state.revisions[0];
  state.revisions = [snapshot, ...state.revisions];
  state.to = snapshot.sequence;
  state.from = (former ?? snapshot).sequence;
  renderSidebar();
  renderVersions();
  if (!state.draftDirty) setSaveStatus('草稿已保存到此浏览器');
  announce(`已保存第 ${snapshot.sequence} 版，可查看历史或生成计算书。`);
  return snapshot;
}

function downloadProject(contents, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  link.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 500);
}

async function exportProject() {
  try {
    await flushSave();
    const contents = await state.storage.exportProject(state.project.id);
    downloadProject(contents, state.project.name);
  } catch {
    const worksheets = state.worksheets.map(sheet => sheet.id === state.worksheet?.id ? state.worksheet : sheet);
    const revisions = (await Promise.all(worksheets.map(async sheet => {
      if (sheet.id === state.worksheet?.id) return state.revisions;
      return state.storage.listRevisions(sheet.id);
    }))).flat();
    downloadProject(serializeBackup(state.project, worksheets, revisions), state.project.name);
  }
  announce('项目文件已下载，可备份或发给同事。');
}

function updateRows(key, id) {
  const draft = state.worksheet.draft;
  const addedScenario = key === 'add-scenario' ? createScenario(draft.scenarios.at(-1)) : null;
  const addedOption = key === 'add-option' ? createOption(draft.options.at(-1)) : null;
  if (addedScenario) draft.scenarios.push(addedScenario);
  if (addedOption) draft.options.push(addedOption);
  if (key === 'remove-scenario' && draft.scenarios.length > 1) {
    draft.scenarios = draft.scenarios.filter(item => item.id !== id);
    for (const item of draft.options) delete item.kOverrides[id];
  }
  if (key === 'remove-option' && draft.options.length > 1) {
    draft.options = draft.options.filter(item => item.id !== id);
    if (draft.selection.optionId === id) draft.selection = { optionId: '', reason: '' };
  }
  markDraftEdited();
  render({ preserve: true });
  if (addedScenario) document.getElementById(`field-scenarios.${addedScenario.id}.flow`).focus();
  if (addedOption) document.getElementById(`field-options.${addedOption.id}.diameter`).focus();
}

function restoreProjectLimit(key) {
  state.worksheet.draft.limits[key] = { mode: 'inherit', value: '' };
  document.getElementById(`field-limits.${key}.value`).value = state.project.limits[key];
  markDraftEdited();
  renderResults();
  document.getElementById(`field-limits.${key}.value`).focus();
}

function chooseOption(id) {
  document.getElementById('field-selection.optionId').value = id;
  updateValue('selection.optionId', id);
  renderResults();
  document.getElementById('handoff-panel').scrollIntoView({ block: 'start' });
  document.getElementById('field-selection.reason').focus({ preventScroll: true });
}

function showFormula(button) {
  state.openRow = state.openRow === button.dataset.id ? null : button.dataset.id;
  for (const toggle of workspace.querySelectorAll('[data-action="row-details"]')) {
    toggle.setAttribute('aria-expanded', String(toggle.dataset.id === state.openRow));
  }
  const panel = document.querySelector('#formula-detail');
  panel.hidden = !state.openRow;
  if (state.openRow) {
    const row = state.pending.rows.find(item => `${item.scenarioId}:${item.optionId}` === state.openRow);
    renderFormula(row, state.pending.limits);
    panel.scrollIntoView({ block: 'nearest' });
  }
}

const operations = {
  home: run(openHome),
  example: run(async () => {
    const { project, worksheet } = createExample();
    const saved = await state.storage.createProjectWithWorksheet(project, worksheet);
    state.projects = await state.storage.listProjects();
    await openProject(saved.project, saved.worksheet.id);
  }),
  'start-calculation': run(async () => {
    const details = await requestProjectName(true);
    if (!details) return;
    const project = createProject(details.name);
    const worksheet = createWorksheet(project.id);
    worksheet.draft.line = details.line;
    const saved = await state.storage.createProjectWithWorksheet(project, worksheet);
    state.projects = await state.storage.listProjects();
    await openProject(saved.project, saved.worksheet.id);
    const flow = workspace.querySelector('input[data-path$=".flow"]');
    flow?.focus();
  }),
  'new-project': run(async () => {
    const details = await requestProjectName();
    if (!details) return;
    const project = await state.storage.putProject(createProject(details.name));
    state.projects = await state.storage.listProjects();
    await openProject(project);
  }),
  'open-project': run(async id => {
    const project = state.projects.find(item => item.id === id);
    if (project) await openProject(project);
  }),
  'open-worksheet': run(async id => { await openProject(state.project, id); }),
  'new-worksheet': run(async () => {
    const worksheet = await state.storage.createWorksheet(createWorksheet(state.project.id));
    await openProject(state.project, worksheet.id);
  }),
  'save-version': run(() => saveVersion()),
  'save-and-print': run(async () => {
    const snapshot = await saveVersion(true);
    if (snapshot) printReport(state.project, snapshot);
  }),
  export: run(exportProject, { flush: false }),
  'print-version': run(async () => {
    const snapshot = state.revisions.find(item => item.sequence === state.to);
    if (snapshot) printReport(state.project, snapshot);
  }, { flush: false }),
};

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const { action: key, id } = button.dataset;
  if (key === 'select-import') importInput.click();
  else if (key === 'row-details') showFormula(button);
  else if (key === 'inherit-limit') restoreProjectLimit(id);
  else if (key === 'choose-option') chooseOption(id);
  else if (['add-scenario', 'add-option', 'remove-scenario', 'remove-option'].includes(key)) updateRows(key, id);
  else operations[key]?.(id);
});

workspace.addEventListener('input', handleInput);
workspace.addEventListener('change', handleChange);
importInput.addEventListener('change', run(async () => {
  const [file] = importInput.files;
  importInput.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) throw new Error('这个项目文件太大。请选择 20 MB 以内的项目文件。');
  let project;
  try {
    project = await state.storage.importProject(await file.text());
  } catch {
    throw new Error('打不开这个项目文件。请确认它是从工作台下载的文件，再试一次。');
  }
  state.projects = await state.storage.listProjects();
  await openProject(project, null, { openSingleSheet: true });
  announce('项目已打开，并作为一份独立副本保存在此浏览器。');
}));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (state.projectDirty || state.draftDirty)) {
    flushSave().catch(error => setSaveStatus(error.message));
  }
});
window.addEventListener('beforeunload', event => {
  if (state.projectDirty || state.draftDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function start() {
  try {
    state.storage = await openStorage();
    state.projects = await state.storage.listProjects();
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('chemical-calculator.active')); } catch { /* no remembered view */ }
    const project = state.projects.find(item => item.id === saved?.[0]);
    if (project) await openProject(project, saved[1]);
    else render();
  } catch (error) {
    workspace.textContent = '无法打开本地项目。请检查浏览器是否允许该站点存储数据，然后重新加载。';
    announce(error.message || '本地存储不可用。', true);
  }
}

void start();
