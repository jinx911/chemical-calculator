import { formulas, calculateFormula } from './formulas.mjs';
import { formatNumber } from './presentation.mjs';

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

const calculatorMarkup = `
    <section class="section formula-catalog" aria-label="查找公式">
      <div class="formula-filters">
        <div class="field">
          <label for="formula-search">搜索公式</label>
          <input id="formula-search" type="search" placeholder="如：压降、LMTD" autocomplete="off">
        </div>
        <div class="field">
          <label for="formula-category">公式分类</label>
          <select id="formula-category">
            <option value="">全部分类</option>
          </select>
        </div>
      </div>
      <div class="formula-filter-status">
        <p id="formula-match-count" class="hint" role="status"></p>
        <button class="formula-clear" id="formula-clear" type="button" hidden>清除筛选</button>
      </div>
      <ul id="formula-matches" class="formula-matches" role="list" aria-label="可选公式"></ul>
    </section>
    <div class="formula-columns">
      <section class="section" aria-labelledby="formula-title">
        <h2 id="formula-title" tabindex="-1"></h2>
        <p id="formula-description" class="muted"></p>
        <form id="formula-form" novalidate>
          <div class="grid formula-fields" id="formula-fields"></div>
          <div class="toolbar">
            <button class="button primary" type="submit">计算</button>
            <button class="button" id="formula-example" type="button">载入算例</button>
          </div>
        </form>
      </section>
      <section class="section formula-output" aria-labelledby="formula-result-title">
        <h2 id="formula-result-title">计算结果</h2>
        <div id="formula-result" aria-live="polite"></div>
        <details open>
          <summary>计算依据</summary>
          <p id="formula-equation" class="formula-equation"></p>
          <p id="formula-substitution" class="hint" hidden></p>
          <a id="formula-reference" class="hint" target="_blank" rel="noopener"></a>
        </details>
      </section>
    </div>
`;

const normalizeSearch = value => value.normalize('NFKC').toLowerCase().trim();

export function mountFormulaCalculator(root, { syncHash = false, revealResult = () => {} } = {}) {
  root.innerHTML = calculatorMarkup;
  const byId = id => root.querySelector('#' + id);
  const search = byId('formula-search');
  const category = byId('formula-category');
  const matchList = byId('formula-matches');
  const matchCount = byId('formula-match-count');
  const clearFilters = byId('formula-clear');
  const title = byId('formula-title');
  const form = byId('formula-form');
  const result = byId('formula-result');
  const fieldPanel = byId('formula-fields');
  const substitution = byId('formula-substitution');
  const saved = new Map();
  const choices = new Map();
  let current;
  let controls;

  function readInputs() {
    return Object.fromEntries(Object.entries(controls).map(([key, { input, units }]) =>
      [key, { raw: input.value, unit: typeof units === 'string' ? units : units.value }]));
  }

  function makeField(item, prior) {
    const container = element('div', null, 'field');
    const group = element('div', null, 'formula-input');
    const label = element('label', item.label);
    const input = element('input');
    const error = element('span', null, 'field-error');
    input.id = 'formula-field-' + item.key;
    label.htmlFor = input.id;
    input.inputMode = 'decimal';
    input.value = prior?.raw ?? '';
    error.id = input.id + '-error';
    input.setAttribute('aria-describedby', error.id);
    group.append(input);
    const choices = Object.keys(item.units);
    let units = choices[0];
    if (choices.length > 1) {
      units = element('select');
      units.setAttribute('aria-label', item.label + '的单位');
      for (const choice of choices) units.add(new Option(choice, choice));
      units.value = prior?.unit ?? choices[0];
      group.append(units);
    } else if (units) {
      group.append(element('span', units, 'formula-unit'));
    }
    container.append(label, group, error);
    fieldPanel.append(container);
    return { input, units, error };
  }

  function clearResult(message = '填入已知参数后，点击「计算」。') {
    result.replaceChildren(element('p', message, 'muted'));
    substitution.hidden = true;
    for (const { input, error } of Object.values(controls)) {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
    }
  }

  function selectFormula(id) {
    const next = formulas.find(formula => formula.id === id) ?? formulas[0];
    if (next === current) return;
    if (current) {
      saved.set(current.id, readInputs());
      choices.get(current.id).button.setAttribute('aria-pressed', 'false');
    }
    current = next;
    choices.get(current.id).button.setAttribute('aria-pressed', 'true');
    title.textContent = current.name;
    byId('formula-description').textContent = current.description;
    byId('formula-equation').textContent = current.equation;
    const reference = byId('formula-reference');
    reference.hidden = !current.reference;
    if (current.reference) {
      reference.textContent = current.reference[0];
      reference.href = current.reference[1];
    }
    fieldPanel.replaceChildren();
    controls = Object.fromEntries(current.fields.map(item =>
      [item.key, makeField(item, saved.get(current.id)?.[item.key])]));
    clearResult();
  }

  function showCalculation() {
    clearResult();
    const values = readInputs();
    const calculation = calculateFormula(current, values);
    if (calculation.errors) {
      for (const [key, message] of Object.entries(calculation.errors)) {
        controls[key].input.setAttribute('aria-invalid', 'true');
        controls[key].error.textContent = message;
      }
      controls[Object.keys(calculation.errors)[0]].input.focus();
      result.replaceChildren(element('p', '请补齐或修改标出的参数。', 'field-error'));
      return;
    }
    if (calculation.message) {
      result.replaceChildren(element('p', calculation.message, 'field-error'));
      revealResult(result);
      return;
    }
    result.replaceChildren(...current.result.map(([label, unit], index) => {
      const row = element('div', null, 'formula-metric');
      const display = element('p', null, 'formula-number');
      display.append(document.createTextNode(formatNumber(calculation.outputs[index], 5)));
      if (unit) display.append(element('small', unit));
      row.append(element('p', label, 'muted'), display);
      return row;
    }));
    substitution.textContent = '本次代入：' + current.fields.map(item => {
      const { raw, unit } = values[item.key];
      if (item.basis && item.basis !== unit) {
        return item.label + ' ' + formatNumber(calculation.normalized[item.key], 7) + ' ' + item.basis;
      }
      return item.label + ' ' + raw.trim() + (unit ? ' ' + unit : '');
    }).join('，');
    substitution.hidden = false;
    revealResult(result);
  }

  function filterFormulas() {
    const query = normalizeSearch(search.value);
    const terms = query ? query.split(/\s+/) : [];
    let matches = 0;
    for (const { row, group, searchable } of choices.values()) {
      const match = (!category.value || category.value === group)
        && terms.every(term => searchable.includes(term));
      row.hidden = !match;
      if (match) matches++;
    }
    matchList.hidden = matches === 0;
    matchList.scrollTop = 0;
    matchCount.textContent = matches ? `找到 ${matches} 个公式` : '没有匹配的公式，试试其他关键词或分类。';
    clearFilters.hidden = !query && !category.value;
  }

  for (const group of new Set(formulas.map(formula => formula.group))) {
    category.add(new Option(group, group));
  }
  for (const formula of formulas) {
    const row = element('li');
    const button = element('button', null, 'formula-choice');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.append(element('span', formula.name), element('small', formula.group));
    button.addEventListener('click', () => {
      if (syncHash) history.replaceState(null, '', '#' + formula.id);
      selectFormula(formula.id);
      title.focus();
    });
    row.append(button);
    matchList.append(row);
    const searchable = normalizeSearch([
      formula.name, formula.group, ...formula.result.map(([label]) => label), ...(formula.keywords ?? []),
    ].join(' '));
    choices.set(formula.id, { row, button, group: formula.group, searchable });
  }

  selectFormula(syncHash ? location.hash.slice(1) : '');
  filterFormulas();
  search.addEventListener('input', filterFormulas);
  category.addEventListener('change', filterFormulas);
  clearFilters.addEventListener('click', () => {
    search.value = '';
    category.value = '';
    search.focus({ preventScroll: true });
    filterFormulas();
  });
  if (syncHash) window.addEventListener('hashchange', () => selectFormula(location.hash.slice(1)));
  form.addEventListener('submit', event => {
    event.preventDefault();
    showCalculation();
  });
  form.addEventListener('input', () => clearResult('参数已修改，点击「计算」查看新结果。'));
  byId('formula-example').addEventListener('click', () => {
    for (const item of current.fields) {
      const { input, units } = controls[item.key];
      input.value = item.example;
      if (typeof units !== 'string') units.selectedIndex = 0;
    }
    showCalculation();
  });
  return { focus: () => search.focus({ preventScroll: true }) };
}

const standalone = document.querySelector('[data-standalone-formulas]');
if (standalone) mountFormulaCalculator(standalone, { syncHash: true });
