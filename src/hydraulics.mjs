const ALGORITHM = 'darcy-weisbach-v1';
const GRAVITY = 9.80665;
const LAMINAR_LIMIT = 2000;
const TURBULENT_LIMIT = 4000;
const K_REGIMES = ['any', 'laminar', 'turbulent'];

const unitFactors = {
  flow: { 'm³/h': 1 / 3600, 'm³/s': 1, 'L/s': 0.001 },
  viscosity: { 'mPa·s': 0.001, 'Pa·s': 1 },
  diameter: { mm: 0.001, m: 1 },
  roughness: { mm: 0.001, m: 1 },
};

export const UNITS = Object.freeze(Object.fromEntries(
  Object.entries(unitFactors).map(([quantity, factors]) => [quantity, Object.freeze(Object.keys(factors))]),
));

function getFactor(quantity, unit) {
  const factors = Object.hasOwn(unitFactors, quantity) ? unitFactors[quantity] : {};
  return Object.hasOwn(factors, unit) ? factors[unit] : null;
}

function decimal(raw) {
  const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Converts an editable quantity while preserving empty and invalid input. */
export function convertUnit(value, quantity, from, to) {
  const number = decimal(value);
  const source = getFactor(quantity, from);
  const target = getFactor(quantity, to);
  if (number === null || source === null || target === null || source === target) return value;
  const converted = number * (source / target);
  return Number.isFinite(converted) && (converted !== 0 || number === 0) ? String(converted) : value;
}

function numericReader(issues, path) {
  return (field, raw, { min = -Infinity, positive = false, optional = false, factor = 1 } = {}) => {
    if (factor === null) {
      issues.push({ path: path + field, message: '请选择支持的单位。' });
      return null;
    }
    if (optional && (raw == null || raw === '')) return null;
    const number = decimal(raw);
    const value = number === null ? null : number * factor;
    if (value === null || !Number.isFinite(value) || value < min || (positive && value <= 0)) {
      const range = positive ? '大于零的' : min === 0 ? '非负' : '有效';
      issues.push({ path: path + field, message: '请输入' + range + '数值。' });
      return null;
    }
    return value;
  };
}

function normalizeScenario(scenario, issues) {
  const read = numericReader(issues, 'scenarios.' + scenario.id + '.');
  return {
    id: scenario.id,
    name: scenario.name,
    flow: read('flow', scenario.flow, { positive: true, factor: getFactor('flow', scenario.flowUnit) }),
    density: read('density', scenario.density, { positive: true }),
    viscosity: read('viscosity', scenario.viscosity, {
      positive: true, factor: getFactor('viscosity', scenario.viscosityUnit),
    }),
    propertySource: scenario.source,
  };
}

function normalizeK(raw, source, regime, field, read, issue) {
  if (!K_REGIMES.includes(regime)) issue(field, '请选择支持的 K 适用流态。');
  return {
    k: read(field, raw, { min: 0, optional: true }),
    kSource: source,
    kRegime: regime,
  };
}

function normalizeOption(option, issues) {
  const path = 'options.' + option.id + '.';
  const read = numericReader(issues, path);
  const issue = (field, message) => issues.push({ path: path + field, message });
  const diameter = read('diameter', option.diameter, {
    positive: true, factor: getFactor('diameter', option.diameterUnit),
  });
  let roughness = read('roughness', option.roughness, {
    min: 0, factor: getFactor('roughness', option.roughnessUnit),
  });
  if (diameter !== null && roughness !== null && roughness >= diameter) {
    issue('roughness', '绝对粗糙度须小于实际内径。');
    roughness = null;
  }
  const overrides = Object.fromEntries(Object.entries(option.kOverrides).map(([id, override]) => [
    id, normalizeK(override.k, override.source, override.regime, 'kOverrides.' + id + '.k', read, issue),
  ]));
  return {
    id: option.id,
    name: option.name,
    diameter,
    roughness,
    length: read('length', option.length, { min: 0 }),
    elevation: read('elevation', option.elevation),
    defaultK: normalizeK(option.k, option.kSource, option.kRegime, 'k', read, issue),
    overrides,
  };
}

function effectiveLimits(settings, projectLimits, issues) {
  const read = numericReader(issues, 'limits.');
  return Object.fromEntries(Object.entries({ velocity: 1, pressure: 1000 }).map(([key, factor]) => {
    const { mode, value } = settings[key];
    if (mode === 'none') return [key, null];
    if (mode === 'inherit' || mode === 'custom') {
      const input = mode === 'inherit' ? projectLimits[key] : value;
      return [key, read(key, input, { min: 0, optional: true, factor })];
    }
    issues.push({ path: 'limits.' + key, message: '请选择有效的限值来源。' });
    return [key, null];
  }));
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function classify(reynolds) {
  if (reynolds === null) return null;
  if (reynolds < LAMINAR_LIMIT) return 'laminar';
  if (reynolds > TURBULENT_LIMIT) return 'turbulent';
  return 'transition';
}

function friction(regime, reynolds, relativeRoughness) {
  if (relativeRoughness === null) return null;
  if (regime === 'laminar') return finite(64 / reynolds);
  if (regime !== 'turbulent') return null;
  const term = relativeRoughness / 3.7 + 5.74 / reynolds ** 0.9;
  return finite(0.25 / Math.log10(term) ** 2);
}

function withNumbers(values, calculation) {
  return values.includes(null) ? null : finite(calculation(...values));
}

function normalizeReynolds(value) {
  if (value === null || value <= 0) return null;
  // Unit conversion and π can put an exact boundary value a few ULPs outside the interval.
  for (const limit of [LAMINAR_LIMIT, TURBULENT_LIMIT]) {
    if (Math.abs(value - limit) <= 4 * Number.EPSILON * limit) return limit;
  }
  return value;
}

function normalizedInput(scenario, option) {
  const { flow, density, viscosity, propertySource } = scenario;
  const { diameter, length, roughness, elevation } = option;
  const local = Object.hasOwn(option.overrides, scenario.id) ? option.overrides[scenario.id] : option.defaultK;
  const area = withNumbers([diameter], d => Math.PI * (d / 2) ** 2);
  return { flow, density, viscosity, diameter, length, roughness, elevation, area, ...local, propertySource };
}

function calculateRow(input) {
  const { flow, density, viscosity, diameter, length, roughness, elevation, area, k, kRegime } = input;
  const velocity = withNumbers([flow, area], (q, a) => q / a);
  const reynolds = normalizeReynolds(withNumbers(
    [density, velocity, diameter, viscosity], (rho, v, d, mu) => rho * v * d / mu,
  ));
  const regime = classify(reynolds);
  const relativeRoughness = withNumbers([roughness, diameter], (epsilon, d) => epsilon / d);
  const frictionFactor = friction(regime, reynolds, relativeRoughness);
  const dynamicPressure = withNumbers([density, velocity], (rho, v) => rho * v ** 2 / 2);
  const elevationPressure = withNumbers([density, elevation], (rho, z) => rho * GRAVITY * z);
  const frictionLoss = withNumbers([frictionFactor, length, diameter, dynamicPressure], (f, l, d, q) => f * (l / d) * q);
  const applicableK = regime === 'laminar' || regime === 'turbulent';
  const localLoss = applicableK && (kRegime === 'any' || kRegime === regime)
    ? withNumbers([k, dynamicPressure], (coefficient, q) => coefficient * q)
    : null;
  const loss = withNumbers([frictionLoss, localLoss], (straight, local) => straight + local);
  const staticDifference = withNumbers([loss, elevationPressure], (loss, elevation) => loss + elevation);
  return { velocity, reynolds, regime, frictionFactor, dynamicPressure, frictionLoss, localLoss, loss, elevationPressure, staticDifference };
}

function check(value, limit) {
  if (value === null || limit === null) return 'pending';
  return value <= limit ? 'pass' : 'fail';
}

function combined(statuses) {
  if (statuses.includes('fail')) return 'fail';
  return statuses.length > 0 && statuses.every(status => status === 'pass') ? 'pass' : 'pending';
}

function diagnose(input, row, limits) {
  const messages = [];
  if (row.regime === 'transition') messages.push('雷诺数处于 2,000 至 4,000 的过渡区，压降未判定。');
  if (row.regime === null) messages.push('流态未判定，请核对输入及数值范围。');
  if (row.regime === 'laminar' || row.regime === 'turbulent') {
    if (input.k === null) messages.push('尚未提供有效的局部阻力系数 K。无局部损失时请填 0。');
    else if (input.kRegime !== 'any' && input.kRegime !== row.regime) {
      messages.push('局部阻力系数 K 不适用于本工况的流态。');
    }
    else if (row.localLoss === null) messages.push('局部损失超出可计算范围。');
    if (row.frictionLoss === null) messages.push('沿程损失未判定，请核对管道输入及数值范围。');
  }
  if (row.elevationPressure === null) messages.push('高差压力项未判定，请核对高差及密度。');
  if (limits.velocity === null) messages.push('没有可用的流速上限。');
  if (limits.pressure === null) messages.push('没有可用的阻力压降上限。');
  if (row.frictionLoss !== null && row.localLoss !== null && row.loss === null) {
    messages.push('阻力压降超出可计算范围。');
  }
  if (row.loss !== null && row.elevationPressure !== null && row.staticDifference === null) {
    messages.push('两端静压差超出可计算范围。');
  }
  return messages;
}

function resultRow(scenario, option, limits) {
  const input = normalizedInput(scenario, option);
  const row = calculateRow(input);
  const velocityStatus = check(row.velocity, limits.velocity);
  const pressureStatus = check(row.loss, limits.pressure);
  return {
    scenarioId: scenario.id,
    optionId: option.id,
    scenarioName: scenario.name,
    optionName: option.name,
    input,
    ...row,
    velocityStatus,
    pressureStatus,
    status: combined([velocityStatus, pressureStatus]),
    diagnostics: diagnose(input, row, limits),
  };
}

/** Computes the scenario × candidate matrix without changing the draft or limits. */
export function calculate(draft, projectLimits) {
  const issues = [];
  const scenarios = draft.scenarios.map(scenario => normalizeScenario(scenario, issues));
  const options = draft.options.map(option => normalizeOption(option, issues));
  const limits = effectiveLimits(draft.limits, projectLimits, issues);
  const rows = scenarios.flatMap(scenario => options.map(option => resultRow(scenario, option, limits)));
  const summaries = options.map(({ id }) => ({
    optionId: id,
    status: combined(rows.filter(row => row.optionId === id).map(row => row.status)),
  }));
  return { algorithm: ALGORITHM, rows, issues, summaries, limits };
}
