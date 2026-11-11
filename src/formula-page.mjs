import { formulas, calculateFormula } from './formulas.mjs';
import { formatNumber } from './presentation.mjs';

const byId = id => document.getElementById(id);
const picker = byId('formula-picker');
const form = byId('formula-form');
const result = byId('formula-result');
const fieldPanel = byId('formula-fields');
const substitution = byId('formula-substitution');
const saved = new Map();
let current;
let controls;

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

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
  if (current) saved.set(current.id, readInputs());
  current = next;
  picker.value = current.id;
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
}

const groups = new Map();
for (const formula of formulas) {
  if (!groups.has(formula.group)) {
    const group = element('optgroup');
    group.label = formula.group;
    groups.set(formula.group, group);
    picker.append(group);
  }
  groups.get(formula.group).append(new Option(formula.name, formula.id));
}

selectFormula(location.hash.slice(1));
picker.addEventListener('change', () => {
  history.replaceState(null, '', '#' + picker.value);
  selectFormula(picker.value);
});
window.addEventListener('hashchange', () => selectFormula(location.hash.slice(1)));
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
