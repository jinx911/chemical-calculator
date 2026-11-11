const labels = { pass: '满足', fail: '超限', pending: '未完成校核' };
const regimes = { laminar: '层流', transition: '过渡区', turbulent: '湍流', any: '各流态' };

export function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return '—';
  if (value !== 0 && (Math.abs(value) < 10 ** -digits || Math.abs(value) >= 1e12)) {
    return value.toExponential(digits);
  }
  return new Intl.NumberFormat('zh-CN', {
    useGrouping: false, maximumFractionDigits: digits,
  }).format(value);
}

export function statusLabel(status) {
  return Object.hasOwn(labels, status) ? labels[status] : '未完成校核';
}

export function regimeLabel(regime) {
  return Object.hasOwn(regimes, regime) ? regimes[regime] : '未判定';
}

function quantity(value, unit, digits = 7) {
  return Number.isFinite(value) ? formatNumber(value, digits) + ' ' + unit : '未判定';
}

function substitute(symbolic, values, expression, result, unit) {
  if (!Number.isFinite(result) || !values.every(Number.isFinite)) return symbolic + ' = 未判定';
  return symbolic + ' = ' + expression(...values.map(value => formatNumber(value, 9))) +
    ' = ' + quantity(result, unit);
}

export function formulaDetails(row) {
  const input = row.input ?? {};
  const reference = [
    { label: '归一化输入', value: [
      'Q = ' + quantity(input.flow, 'm³/s'), 'D = ' + quantity(input.diameter, 'm'),
      'ρ = ' + quantity(input.density, 'kg/m³'), 'μ = ' + quantity(input.viscosity, 'Pa·s'),
      'L = ' + quantity(input.length, 'm'), 'ε = ' + quantity(input.roughness, 'm'),
      'Δz = ' + quantity(input.elevation, 'm'),
    ].join('，') },
    { label: '取值依据', value: '物性：' + (input.propertySource || '未填写') +
      '；K = ' + formatNumber(input.k, 7) + '（' + (input.kSource || '依据未填写') + '，' +
      regimeLabel(input.kRegime) + '）' },
    { label: '截面积和流速', value: 'A = πD²/4 = ' + quantity(input.area, 'm²') +
      '；' + substitute('v = Q/A', [input.flow, input.area], (q, a) => q + '/' + a, row.velocity, 'm/s') },
    { label: '雷诺数', value: 'Re = ρvD/μ = ' + formatNumber(row.reynolds, 5) + '（' + regimeLabel(row.regime) + '）' },
  ];
  const frictionRule = {
    laminar: 'f = 64/Re',
    turbulent: 'f = 0.25 / [log₁₀(ε/(3.7D) + 5.74/Re⁰·⁹)]²',
    transition: '2000 ≤ Re ≤ 4000，摩阻和压降未判定',
  };
  return reference.concat([
    { label: 'Darcy 摩阻因子', value: (frictionRule[row.regime] ?? '摩阻因子未判定') +
      (Number.isFinite(row.frictionFactor) ? ' = ' + formatNumber(row.frictionFactor, 8) : '') },
    { label: '动压、沿程损失', value: 'qᵥ = ρv²/2 = ' + quantity(row.dynamicPressure, 'Pa') +
      '；' + substitute('Δp_f = f(L/D)qᵥ', [row.frictionFactor, input.length, input.diameter, row.dynamicPressure],
        (f, l, d, q) => f + ' × (' + l + '/' + d + ') × ' + q, row.frictionLoss, 'Pa') },
    { label: '局部损失与阻力压降', value: substitute('Δp_K = Kqᵥ', [input.k, row.dynamicPressure],
      (k, q) => k + ' × ' + q, row.localLoss, 'Pa') + '；' +
      substitute('Δp_loss = Δp_f + Δp_K', [row.frictionLoss, row.localLoss],
        (straight, local) => straight + ' + ' + local, row.loss, 'Pa') },
    { label: '高差压力项与静压差', value: 'Δp_z = ρgΔz = ' + quantity(row.elevationPressure, 'Pa') +
      '；p_in − p_out = Δp_loss + Δp_z = ' + quantity(row.staticDifference, 'Pa') +
      '（g = 9.80665 m/s²）' },
  ]);
}
