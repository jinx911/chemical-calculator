import { calculate, convertUnit, UNITS } from './hydraulics.mjs';
import { createExample, createOption, createProject, createScenario, createWorksheet } from './model.mjs';
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
const limitModes = [['inherit', '继承项目限值'], ['custom', '单独设置'], ['none', '未设置']];
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
    `<button type="button" data-action="open-worksheet" data-id="${esc(sheet.id)}" ${sheet.id === state.worksheet?.id ? 'aria-current="page"' : ''}>${esc(safeName(sheet.draft.line, '新计算单'))}<small>${sheet.sequence ? `已保存 V${sheet.sequence}` : '草稿'}</small></button>`);
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
      <h1 id="home-title">管径与压降</h1>
      <p>比选单相液体管线的候选管径，核对各工况的流速与压降，保存版本并生成计算书。</p>
      <div class="toolbar">
        ${action('打开冷却水算例', 'example', 'primary', 'id="open-example"')}
        ${action('新建项目', 'new-project', 'secondary')}
        ${action('导入项目 JSON', 'select-import', 'secondary')}
      </div>
    </section>
    <p class="muted home-notes">项目保存在此浏览器。导出 JSON 可备份和交接；清除站点数据前请先备份。</p>
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
    <div class="toolbar top-actions">${action('新建计算单', 'new-worksheet', 'primary')}${action('导出项目 JSON', 'export', '', 'id="export-project"')}${action('导入项目 JSON', 'select-import')}</div>
    ${section('项目限值', projectLimits(project))}
    ${section('计算单', sheets.length ? `<ul>${sheets.join('')}</ul>` : '<p class="muted">创建计算单后可填写工况和候选管径。</p>')}
    <p class="hint" id="save-status" role="status">保存在此浏览器</p>
  `;
}

function inputUnit(path, key, row) {
  return { quantity: key, path: `${path}.${key}Unit`, value: row[`${key}Unit`] };
}

function scenarioCard(row, index, count) {
  const path = `scenarios.${row.id}`;
  return `<article class="card"><header><h3>工况 ${index + 1}</h3>
    ${action('移除', 'remove-scenario', 'small remove', `data-id="${esc(row.id)}" aria-label="移除工况 ${index + 1}" ${count <= 1 ? 'disabled' : ''}`)}
    </header><div class="grid">
      ${field('工况名称', `${path}.name`, row.name, { wide: true })}
      ${field('体积流量', `${path}.flow`, row.flow, { numeric: true, unit: inputUnit(path, 'flow', row) })}
      ${field('密度（kg/m³）', `${path}.density`, row.density, { numeric: true })}
      ${field('动力黏度', `${path}.viscosity`, row.viscosity, { numeric: true, unit: inputUnit(path, 'viscosity', row) })}
      ${field('物性及流量依据', `${path}.source`, row.source, { wide: true })}
    </div></article>`;
}

function overrides(row, scenarios, path) {
  return `<details data-key="${esc(path)}-overrides"><summary>按工况覆盖局部阻力系数</summary>
    ${scenarios.map((scenario, index) => {
      const item = row.kOverrides[scenario.id] ?? {};
      const base = `${path}.kOverrides.${scenario.id}`;
      return `<div class="grid"><h3 class="wide" data-override-scenario="${esc(scenario.id)}">${esc(safeName(scenario.name, `工况 ${index + 1}`))}</h3>
        ${field('覆盖 K', `${base}.k`, item.k ?? '', { numeric: true })}
        ${field('适用流态', `${base}.regime`, item.regime ?? 'any', { select: regimeChoices })}
        ${field('覆盖值依据', `${base}.source`, item.source ?? '', { wide: true })}</div>`;
    }).join('')}<p class="hint">覆盖值留空时使用该方案默认 K。</p></details>`;
}

function optionCard(row, index, count, scenarios) {
  const path = `options.${row.id}`;
  return `<article class="card"><header><h3>方案 ${index + 1}</h3>
    ${action('移除', 'remove-option', 'small remove', `data-id="${esc(row.id)}" aria-label="移除方案 ${index + 1}" ${count <= 1 ? 'disabled' : ''}`)}
    </header><div class="grid">
      ${field('方案名称', `${path}.name`, row.name, { wide: true })}
      ${field('实际内径', `${path}.diameter`, row.diameter, { numeric: true, unit: inputUnit(path, 'diameter', row) })}
      ${field('管长（m）', `${path}.length`, row.length, { numeric: true })}
      ${field('绝对粗糙度', `${path}.roughness`, row.roughness, { numeric: true, unit: inputUnit(path, 'roughness', row) })}
      ${field('出口减入口高差（m）', `${path}.elevation`, row.elevation, { numeric: true })}
      ${field('默认局部阻力系数 K', `${path}.k`, row.k, { numeric: true })}
      ${field('适用流态', `${path}.kRegime`, row.kRegime, { select: regimeChoices })}
      ${field('K 值依据', `${path}.kSource`, row.kSource, { wide: true })}
    </div>${overrides(row, scenarios, path)}</article>`;
}

function worksheetLimits(draft) {
  return `<div class="grid">
    ${[['velocity', '流速', 'm/s'], ['pressure', '阻力压降', 'kPa']].map(([key, label, unit]) => {
      const setting = draft.limits[key];
      return field(`${label}判据`, `limits.${key}.mode`, setting.mode, { select: limitModes })
        + field(`${label}上限（${unit}）`, `limits.${key}.value`, setting.value, { numeric: true, disabled: setting.mode !== 'custom' });
    }).join('')}
  </div><p class="hint">两项都可判定且满足时，才显示「满足」。高差压力项不计入阻力压降上限。</p>`;
}

function formatDate(date) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('zh-CN', { hour12: false });
}

function renderWorksheet() {
  const { draft } = state.worksheet;
  const selection = [['', '暂未选定'], ...draft.options.map((item, index) => [item.id, safeName(item.name, `方案 ${index + 1}`)])];
  return `
    <div class="page-title">
      <p class="crumb">${esc(state.project.name)} / 管径与压降</p>
      <h1 id="sheet-title">${esc(safeName(draft.line, '新计算单'))}</h1>
      <p class="muted">稳态、单相、不可压牛顿液体 · 满流等内径圆管单段</p>
      <div class="toolbar top-actions">
        ${action('保存版本', 'save-version', 'primary', 'id="save-version"')}
        <a class="button" href="#results-panel">查看比选</a><a class="button" href="#versions-panel">版本与计算书</a>
        ${action('导出项目 JSON', 'export', '', 'id="export-project"')}
        <span class="hint" id="save-status" role="status">${state.draftDirty ? '正在保存草稿…' : '草稿已保存到此浏览器'}</span>
      </div>
    </div>
    ${section('管线资料', `<div class="grid">
      ${field('管线编号或名称', 'line', draft.line)}${field('液体介质', 'medium', draft.medium)}
      ${field('入口位置', 'from', draft.from)}${field('出口位置', 'to', draft.to)}
    </div>`)}
    ${section('工况', `<div class="cards">${draft.scenarios.map((row, index) => scenarioCard(row, index, draft.scenarios.length)).join('')}</div>`, action('＋ 添加工况', 'add-scenario', 'small'))}
    ${section('候选管径', `<div class="cards">${draft.options.map((row, index) => optionCard(row, index, draft.options.length, draft.scenarios)).join('')}</div>`, action('＋ 添加方案', 'add-option', 'small'))}
    ${section('校核限值', worksheetLimits(draft))}
    <section class="section results-panel" id="results-panel" aria-labelledby="results-title">
      <header class="result-head"><h2 id="results-title">工况比选</h2><p class="muted">Darcy–Weisbach · 展开任意组合查看计算依据</p></header>
      <div id="results"></div>
    </section>
    ${section('选型记录', `<div class="grid">
      ${field('选定方案', 'selection.optionId', draft.selection.optionId || '', { select: selection })}
      ${field('选型理由', 'selection.reason', draft.selection.reason, { textarea: true })}
    </div>`)}
    ${section('版本与计算书', '<div id="versions"></div>', '', 'id="versions-panel"')}
  `;
}

function compareValue(value, limit, digits, formatter) {
  const displayed = formatter(value, digits);
  if (value == null || limit == null || value === limit || displayed !== formatter(limit, digits)) return displayed;
  return Number(value.toPrecision(14)).toString();
}

function renderRow(row, limits) {
  const key = `${row.scenarioId}:${row.optionId}`;
  const loss = row.loss == null ? null : row.loss / 1000;
  const limit = limits.pressure == null ? null : limits.pressure / 1000;
  return `<tr>
    <td>${esc(row.scenarioName)}</td><td>${esc(row.optionName)}</td>
    <td class="num">${esc(compareValue(row.velocity, limits.velocity, 3, formatNumber))}</td>
    <td class="num">${esc(compareValue(loss, limit, 2, formatNumber))}</td>
    <td class="num">${esc(pressure(row.frictionLoss))}</td><td class="num">${esc(pressure(row.localLoss))}</td>
    <td class="num">${esc(pressure(row.elevationPressure))}</td>
    <td class="num">${esc(pressure(row.staticDifference))}</td>
    <td>${badge(row.status)}</td><td>${action('查看公式', 'row-details', 'small', `data-id="${esc(key)}" aria-controls="formula-detail" aria-expanded="${key === state.openRow}"`)}</td>
  </tr>`;
}

function renderFormula(row, limits) {
  const panel = document.querySelector('#formula-detail');
  if (!panel || !row) return;
  panel.className = 'result-detail';
  panel.innerHTML = `
    <h3>${esc(row.scenarioName)} · ${esc(row.optionName)}</h3>
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
    const message = messages.get(lookup);
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
  const summary = result.summaries.map(({ optionId, status }) => {
    const candidate = draft.options.find(option => option.id === optionId);
    return `<span>${esc(safeName(candidate?.name, '候选管径'))} · ${badge(status)}</span>`;
  }).join('');
  target.innerHTML = `
    ${unplaced}
    ${!complete ? '<p class="hint">请检查标出的输入。完整且有效的计算单可保存版本。</p>' : ''}
    ${summary ? `<div class="report-summary">${summary}</div>` : ''}
    ${result.rows.length ? `<div class="table-wrap" tabindex="0" aria-label="工况比选表">
      <table><thead><tr><th scope="col">工况</th><th scope="col">候选管径</th><th scope="col">流速（m/s）</th>
      <th scope="col">阻力压降（kPa）</th><th scope="col">沿程损失（kPa）</th><th scope="col">局部损失（kPa）</th>
      <th scope="col">高差压力（kPa）</th><th scope="col">进出口静压差（kPa）</th>
      <th scope="col">校核</th><th scope="col">计算依据</th></tr></thead>
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
    <table><thead><tr><th scope="col">变更项</th><th scope="col">V${before.sequence}</th><th scope="col">V${after.sequence}</th></tr></thead>
    <tbody>${changes.map(change => `<tr><td>${esc(change.field)}</td><td>${esc(change.before)}</td><td>${esc(change.after)}</td></tr>`).join('')}</tbody></table>
    </div>` : '<p class="hint">两个版本的输入、结果和选型记录一致。</p>';
}

function renderVersions() {
  const panel = document.querySelector('#versions');
  if (!panel) return;
  if (!state.revisions.length) {
    panel.innerHTML = '<p class="muted">保存首个版本后，即可导出计算书。保存第二个版本后可比较变更。</p>';
    return;
  }
  const [latest, previous] = state.revisions;
  if (!state.revisions.some(snapshot => snapshot.sequence === state.to)) state.to = latest.sequence;
  if (!state.revisions.some(snapshot => snapshot.sequence === state.from)) state.from = (previous ?? latest).sequence;
  const choices = state.revisions.map(snapshot => [snapshot.sequence, `V${snapshot.sequence} · ${formatDate(snapshot.createdAt)}`]);
  panel.innerHTML = `<div class="grid">
    <div class="field"><label for="version-from">基准版本</label><select id="version-from">${optionsHtml(choices, state.from)}</select></div>
    <div class="field"><label for="version-to">对比与导出版本</label><select id="version-to">${optionsHtml(choices, state.to)}</select></div>
  </div><div class="toolbar" style="margin-top:10px">${action('导出计算书 PDF', 'print-version', 'primary', 'id="print-version"')}</div>
  <p class="hint">打印窗口中选择「另存为 PDF」。计算书使用上方选择的已保存版本。</p>
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
  } else if (group === 'limits') draft.limits[id][key] = value;
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
    document.querySelector('#sheet-title').textContent = safeName(control.value, '新计算单');
    state.worksheets = state.worksheets.map(sheet => sheet.id === state.worksheet.id ? state.worksheet : sheet);
    renderSidebar();
  }
  if (key === 'name' && group === 'scenarios') {
    const index = state.worksheet.draft.scenarios.findIndex(item => item.id === id);
    for (const title of workspace.querySelectorAll('[data-override-scenario]')) {
      if (title.dataset.overrideScenario === id) title.textContent = safeName(control.value, `工况 ${index + 1}`);
    }
  }
  if (key === 'name' && group === 'options') {
    const select = document.getElementById('field-selection.optionId');
    const index = state.worksheet.draft.options.findIndex(item => item.id === id);
    const item = [...select.options].find(choice => choice.value === id);
    if (item) item.textContent = safeName(control.value, `方案 ${index + 1}`);
  }
  renderResults();
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
  if (control.dataset.path.endsWith('.mode')) {
    render({ preserve: true });
  } else {
    renderResults();
  }
}

function resetViews() {
  state.openRow = null;
  state.from = null;
  state.to = null;
  state.revisions = [];
}

async function openProject(project, sheetId) {
  state.worksheets = await state.storage.listWorksheets(project.id);
  state.project = project;
  state.worksheet = null;
  resetViews();
  if (sheetId) {
    const worksheet = state.worksheets.find(sheet => sheet.id === sheetId);
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

function requestProjectName() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'form-dialog';
    dialog.innerHTML = `<form method="dialog">
      <h2>新建项目</h2><div class="field"><label for="new-name">项目名称</label><input id="new-name" required maxlength="160" autofocus></div>
      <div class="toolbar"><button class="button" type="button" data-cancel>取消</button><button class="button primary" type="submit">创建项目</button></div>
    </form>`;
    document.body.append(dialog);
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'create' ? dialog.querySelector('input').value.trim() : '';
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

async function saveVersion() {
  const sheet = structuredClone(state.worksheet);
  const result = calculate(sheet.draft, state.project.limits);
  if (result.issues.length || !result.rows.some(row => Number.isFinite(row.velocity))) {
    announce('请先补齐计算参数。', true);
    return;
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
  announce(`已保存 V${snapshot.sequence}`);
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
  announce('已导出项目 JSON');
}

function updateRows(key, id) {
  const draft = state.worksheet.draft;
  if (key === 'add-scenario') draft.scenarios.push(createScenario());
  if (key === 'add-option') draft.options.push(createOption());
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
  'new-project': run(async () => {
    const name = await requestProjectName();
    if (!name) return;
    const project = await state.storage.putProject(createProject(name));
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
  'save-version': run(saveVersion),
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
  else if (['add-scenario', 'add-option', 'remove-scenario', 'remove-option'].includes(key)) updateRows(key, id);
  else operations[key]?.(id);
});

workspace.addEventListener('input', handleInput);
workspace.addEventListener('change', handleChange);
importInput.addEventListener('change', run(async () => {
  const [file] = importInput.files;
  importInput.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) throw new Error('项目文件不能超过 20 MB。');
  const project = await state.storage.importProject(await file.text());
  state.projects = await state.storage.listProjects();
  await openProject(project);
  announce('已导入为独立项目');
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
