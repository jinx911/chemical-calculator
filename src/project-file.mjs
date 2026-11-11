import { UNITS } from './hydraulics.mjs';

const FORMAT = 'chemical-calculator.project';
const SCHEMA_VERSION = 1;

function invalid(path) {
  throw new Error(`项目文件的 ${path} 无效。`);
}

function object(value, path) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : invalid(path);
}

function text(value, path) {
  return typeof value === 'string' ? value : invalid(path);
}

function id(value, path) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
    && !Object.hasOwn(Object.prototype, value) && value !== 'prototype'
    ? value : invalid(path);
}

function nonemptyText(value, path) {
  return text(value, path).trim() ? value : invalid(path);
}

function date(value, path) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : invalid(path);
}

function integer(value, path, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum ? value : invalid(path);
}

function rawNumber(value, path) {
  if (typeof value !== 'string') return invalid(path);
  if (value === '') return value;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value))
    ? value : invalid(path);
}

function finiteOrNull(value, path, signed = false) {
  return value === null || (Number.isFinite(value) && (signed || value >= 0)) ? value : invalid(path);
}

function choice(choices) {
  return (value, path) => choices.includes(value) ? value : invalid(path);
}

function fields(value, path, schema) {
  const source = object(value, path);
  return Object.fromEntries(Object.entries(schema).map(([key, validate]) =>
    [key, validate(source[key], `${path}.${key}`)]));
}

function list(value, path, validate) {
  if (!Array.isArray(value)) return invalid(path);
  return value.map((entry, index) => validate(entry, `${path}[${index}]`));
}

function unique(values, path) {
  if (new Set(values).size !== values.length) invalid(path);
}

function relation(ids, value, path) {
  if (!ids.has(value)) invalid(path);
  return value;
}

const regime = choice(['any', 'laminar', 'turbulent']);
const mode = choice(['inherit', 'custom', 'none']);
const scenarioFields = {
  id, name: text, flow: rawNumber, flowUnit: choice(UNITS.flow),
  density: rawNumber, viscosity: rawNumber, viscosityUnit: choice(UNITS.viscosity), source: text,
};
const optionFields = {
  id, name: text, diameter: rawNumber, diameterUnit: choice(UNITS.diameter),
  length: rawNumber, roughness: rawNumber, roughnessUnit: choice(UNITS.roughness),
  elevation: rawNumber, k: rawNumber, kSource: text, kRegime: regime,
};
const overrideFields = { k: rawNumber, source: text, regime };
function numericFields(schema, validate) {
  return Object.fromEntries(Object.entries(schema).map(([key, field]) =>
    [key, field === rawNumber ? validate : field]));
}

function draft(value, path, validateNumber = rawNumber) {
  const source = object(value, path);
  const scenarioSchema = numericFields(scenarioFields, validateNumber);
  const scenarios = list(source.scenarios, `${path}.scenarios`, (entry, at) => fields(entry, at, scenarioSchema));
  const scenarioIds = new Set(scenarios.map((entry) => entry.id));
  unique(scenarios.map((entry) => entry.id), `${path}.scenarios.id`);
  const options = list(source.options, `${path}.options`, (entry, at) => readOption(entry, at, scenarioIds, validateNumber));
  const optionIds = new Set(options.map((entry) => entry.id));
  unique(options.map((entry) => entry.id), `${path}.options.id`);

  const limit = (entry, at) => {
    const setting = fields(entry, at, { mode, value: text });
    if (setting.mode === 'custom') validateNumber(setting.value, at + '.value');
    return setting;
  };
  const common = fields(source, path, {
    line: text, medium: text, from: text, to: text,
    limits: (entry, at) => fields(entry, at, { velocity: limit, pressure: limit }),
    selection: (entry, at) => fields(entry, at, {
      optionId: (value, key) => value === '' ? value : relation(optionIds, id(value, key), key), reason: text,
    }),
  });
  return { ...common, scenarios, options };
}

function readOption(value, path, scenarioIds, validateNumber) {
  const option = fields(value, path, numericFields(optionFields, validateNumber));
  const at = `${path}.kOverrides`;
  const overrideSchema = numericFields(overrideFields, validateNumber);
  const entries = Object.entries(object(value.kOverrides, at)).map(([key, entry]) => [
    relation(scenarioIds, key, at), fields(entry, `${at}.${key}`, overrideSchema),
  ]);
  return { ...option, kOverrides: Object.fromEntries(entries) };
}

const projectFields = {
  id, name: nonemptyText, createdAt: date, updatedAt: date,
  limits: (value, path) => fields(value, path, { velocity: rawNumber, pressure: rawNumber }),
};
const worksheetFields = {
  id, projectId: id, draft: (value, path) => draft(value, path, text),
  revision: integer, sequence: integer, updatedAt: date,
};
const snapshotFields = {
  worksheetId: id, sequence: (value, path) => integer(value, path, 1), createdAt: date,
  algorithm: nonemptyText, draft,
};
const normalizedInputFields = {
  flow: finiteOrNull, density: finiteOrNull, viscosity: finiteOrNull, diameter: finiteOrNull,
  length: finiteOrNull, roughness: finiteOrNull, elevation: (value, path) => finiteOrNull(value, path, true),
  area: finiteOrNull, k: finiteOrNull, kSource: text, kRegime: regime, propertySource: text,
};
const status = choice(['pass', 'fail', 'pending']);
const rowFields = {
  scenarioId: id, optionId: id, scenarioName: text, optionName: text,
  input: (value, path) => fields(value, path, normalizedInputFields),
  velocity: finiteOrNull, reynolds: finiteOrNull, frictionFactor: finiteOrNull,
  regime: choice(['laminar', 'transition', 'turbulent', null]),
  dynamicPressure: finiteOrNull, frictionLoss: finiteOrNull, localLoss: finiteOrNull, loss: finiteOrNull,
  elevationPressure: (value, path) => finiteOrNull(value, path, true),
  staticDifference: (value, path) => finiteOrNull(value, path, true),
  status, velocityStatus: status, pressureStatus: status,
  diagnostics: (value, path) => list(value, path, text),
};

function calculation(value, path, snapshot) {
  const source = object(value, path);
  const scenarioIds = new Set(snapshot.draft.scenarios.map((entry) => entry.id));
  const optionIds = new Set(snapshot.draft.options.map((entry) => entry.id));
  const rows = list(source.rows, `${path}.rows`, (entry, at) => {
    const row = fields(entry, at, rowFields);
    relation(scenarioIds, row.scenarioId, `${at}.scenarioId`);
    relation(optionIds, row.optionId, `${at}.optionId`);
    return row;
  });
  const summaries = list(source.summaries, `${path}.summaries`, (entry, at) => {
    const summary = fields(entry, at, { optionId: id, status });
    relation(optionIds, summary.optionId, `${at}.optionId`);
    return summary;
  });
  unique(rows.map((row) => `${row.scenarioId}:${row.optionId}`), `${path}.rows`);
  unique(summaries.map((entry) => entry.optionId), `${path}.summaries`);
  if (source.algorithm !== snapshot.algorithm) invalid(`${path}.algorithm`);
  const limits = fields(source.limits, `${path}.limits`, { velocity: finiteOrNull, pressure: finiteOrNull });
  const issues = list(source.issues, `${path}.issues`, (entry, at) => fields(entry, at, { path: text, message: text }));
  return { algorithm: snapshot.algorithm, rows, issues, summaries, limits };
}

function revision(value, path) {
  const snapshot = fields(value, path, snapshotFields);
  if (value.schemaVersion !== SCHEMA_VERSION) invalid(`${path}.schemaVersion`);
  return {
    ...snapshot,
    schemaVersion: SCHEMA_VERSION,
    projectName: text(value.projectName, `${path}.projectName`),
    calculation: calculation(value.calculation, `${path}.calculation`, snapshot),
  };
}

function verifyLinks(project, worksheets, revisions) {
  const ids = new Map(worksheets.map((worksheet) => [worksheet.id, worksheet]));
  unique(worksheets.map(({ id }) => id), 'worksheets.id');
  const counts = new Map();
  for (const worksheet of worksheets) {
    if (worksheet.projectId !== project.id) invalid('worksheets.projectId');
  }
  for (const snapshot of revisions) {
    const worksheet = ids.get(snapshot.worksheetId);
    if (!worksheet || snapshot.sequence > worksheet.sequence) invalid('revisions.worksheetId / sequence');
    counts.set(worksheet.id, (counts.get(worksheet.id) ?? 0) + 1);
  }
  unique(revisions.map(({ worksheetId, sequence }) => `${worksheetId}:${sequence}`), 'revisions.sequence');
  for (const worksheet of worksheets) {
    if ((counts.get(worksheet.id) ?? 0) !== worksheet.sequence) invalid('worksheets.sequence');
  }
}

function makeCopy(project, worksheets, revisions, makeId) {
  const projectId = makeId();
  const worksheetIds = new Map(worksheets.map((worksheet) => [worksheet.id, makeId()]));
  return {
    project: { ...project, id: projectId },
    worksheets: worksheets.map((worksheet) => ({
      ...worksheet, id: worksheetIds.get(worksheet.id), projectId,
    })),
    revisions: revisions.map((snapshot) => ({ ...snapshot, worksheetId: worksheetIds.get(snapshot.worksheetId) })),
  };
}

/** Produces a versioned JSON backup for browser download. */
export function serializeBackup(project, worksheets = [], revisions = []) {
  return JSON.stringify({
    format: FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(),
    project, worksheets, revisions,
  }, null, 2);
}

/** Validates a project file before creating an independent copy. No storage writes occur here. */
export function parseBackup(input, makeId = () => crypto.randomUUID()) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    throw new Error('无法读取项目文件。请选择有效的 JSON 备份。');
  }
  const source = object(payload, '顶层内容');
  if (source.format !== FORMAT) throw new Error('这个 JSON 文件不是工艺计算工作台的项目备份。');
  if (source.schemaVersion !== SCHEMA_VERSION) throw new Error('此项目文件版本不受支持。请使用兼容版本的工作台。');
  date(source.exportedAt, 'exportedAt');
  const project = fields(source.project, 'project', projectFields);
  const worksheets = list(source.worksheets, 'worksheets', (entry, at) => fields(entry, at, worksheetFields));
  const revisions = list(source.revisions, 'revisions', revision);
  verifyLinks(project, worksheets, revisions);
  return makeCopy(project, worksheets, revisions, makeId);
}
