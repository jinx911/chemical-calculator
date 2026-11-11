const GRAVITY = 9.80665;
const flowUnits = { 'm³/h': 1 / 3600, 'L/s': 0.001, 'm³/s': 1 };
const massUnits = { 'kg/h': 1 / 3600, 'kg/s': 1, 't/h': 1000 / 3600 };
const diameterUnits = { mm: 0.001, m: 1 };
const percent = { '%': 0.01 };

const field = (key, label, units, example, options = {}) => ({
  key, label, units: typeof units === 'string' ? { [units]: 1 } : units, example, ...options,
});
const flow = (example, options) => field('q', '体积流量 Q', flowUnits, example, { basis: 'm³/s', ...options });
const density = field('rho', '流体密度 ρ', 'kg/m³', 997);
const diameter = field('d', '实际内径 D', diameterUnits, 102.3, { basis: 'm' });
const velocity = field('v', '平均流速 v', 'm/s', 1.5);
const mass = (key, label, example, options) => field(key, label, massUnits, example, { basis: 'kg/s', ...options });

const pipeRef = ['EPA · EPANET 水力计算', 'https://usepa.github.io/EPANET2.2/12_analysis_algorithms.html'];
const flowRef = ['NASA · 质量流量与连续性', 'https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/mass-flow-rate/'];
const heatRef = ['MIT · 换热器能量衡算', 'https://ocw.mit.edu/courses/16-050-thermal-energy-fall-2002/87d9f4544b7fd64a77201382500d057c_10_part3.pdf'];

function lmtd({ hotIn, hotOut, coldIn, coldOut }) {
  if (hotOut > hotIn || coldOut < coldIn) {
    throw new Error('请核对流向。热侧出口温度应不高于入口，冷侧出口温度应不低于入口。');
  }
  const a = hotIn - coldOut;
  const b = hotOut - coldIn;
  if (a <= 0 || b <= 0) {
    throw new Error('逆流换热器两端的热侧温度均需高于同一端的冷侧温度。请核对四个温度。');
  }
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const delta = high - low;
  const ratio = delta / low;
  const value = delta === 0 ? high : delta / (Number.isFinite(ratio) ? Math.log1p(ratio) : Math.log(high) - Math.log(low));
  return [value, a, b];
}

export const formulas = [
  {
    id: 'pipe-velocity', group: '管道流动', name: '已知流量和管径，算流速',
    description: '根据实际内径和体积流量，计算满流圆管的截面平均流速。',
    fields: [flow(55, { min: 0 }), diameter], result: [['平均流速', 'm/s']],
    equation: 'v = 4Q / (πD²)', reference: flowRef,
    calculate: ({ q, d }) => [4 * q / (Math.PI * d ** 2)],
  },
  {
    id: 'pipe-diameter', group: '管道流动', name: '按目标流速反算管径',
    description: '结果是按流速反算的实际内径，可带入管径比选进一步校核压降。',
    fields: [flow(55), velocity], result: [['所需实际内径', 'mm']],
    equation: 'D = √(4Q / (πv))。将结果从 m 换算成 mm。', reference: flowRef,
    calculate: ({ q, v }) => [1000 * Math.sqrt(4 * q / (Math.PI * v))],
  },
  {
    id: 'reynolds', group: '管道流动', name: '计算圆管雷诺数',
    description: '使用同一工况下的密度、平均流速、实际内径和动力黏度。',
    fields: [density, velocity, diameter, field('mu', '动力黏度 μ', { 'mPa·s': 0.001, 'Pa·s': 1 }, 0.89, { basis: 'Pa·s' })],
    result: [['雷诺数', '']], equation: 'Re = ρvD / μ', reference: pipeRef,
    calculate: ({ rho, v, d, mu }) => [rho * v * d / mu],
  },
  {
    id: 'pump-power', group: '泵', name: '已知扬程，算泵轴功率',
    description: '填入同一工作点的流量、扬程和泵效率。轴功率是传给泵轴的功率。',
    fields: [flow(55), density, field('h', '泵扬程 H', 'm', 25),
      field('eff', '泵效率 η', percent, 70, { max: 100, basis: '（比例）' })],
    result: [['泵轴功率', 'kW'], ['液压功率', 'kW']],
    equation: 'P液 = ρgQH，P轴 = P液 / η，g = 9.80665 m/s²。将功率从 W 换算成 kW。',
    reference: ['美国能源部 · 泵系统指南', 'https://www.energy.gov/sites/default/files/2014/05/f16/pump.pdf'],
    calculate: ({ q, rho, h, eff }) => {
      const hydraulic = rho * GRAVITY * q * h / 1000;
      return [hydraulic / eff, hydraulic];
    },
  },
  {
    id: 'sensible-heat', group: '传热', name: '已知温差，算加热或冷却负荷',
    description: '适用于无相变、定压比热容可视为常量的情况。温差填出口减入口，结果为负表示流体放热。',
    fields: [mass('m', '质量流量 ṁ', 3600), field('cp', '定压比热容 cₚ', 'kJ/(kg·K)', 4.18),
      field('dt', '出口减入口的温差 ΔT', 'K（或 °C 温差）', 20, { signed: true })],
    result: [['显热负荷', 'kW']], equation: '热负荷 = ṁ cₚ ΔT', reference: heatRef,
    calculate: ({ m, cp, dt }) => [m * cp * dt],
  },
  {
    id: 'lmtd', group: '传热', name: '计算逆流换热器平均温差',
    description: '按逆流布置配对两端温度。两端温差相同时，直接取该温差。',
    fields: [
      field('hotIn', '热侧入口温度', '°C', 90, { min: -273.15 }),
      field('hotOut', '热侧出口温度', '°C', 60, { min: -273.15 }),
      field('coldIn', '冷侧入口温度', '°C', 20, { min: -273.15 }),
      field('coldOut', '冷侧出口温度', '°C', 55, { min: -273.15 }),
    ],
    result: [['对数平均温差', 'K'], ['热侧入口端温差', 'K'], ['热侧出口端温差', 'K']],
    equation: 'ΔT₁ = 热侧入口 − 冷侧出口，ΔT₂ = 热侧出口 − 冷侧入口；ΔTₘ = (ΔT₁ − ΔT₂) / ln(ΔT₁ / ΔT₂)',
    reference: heatRef, calculate: lmtd,
  },
  {
    id: 'heat-area', group: '传热', name: '估算换热面积',
    description: '填入热负荷的大小、总传热系数和对数平均温差。纯逆流的温差修正系数填 1。',
    fields: [field('heat', '热负荷大小', 'kW', 100), field('u', '总传热系数 U', 'W/(m²·K)', 500),
      field('dt', '对数平均温差', 'K', 40), field('f', '温差修正系数 F', '', 1, { max: 1 })],
    result: [['换热面积', 'm²']], equation: 'A = 热负荷 / (U · F · ΔTₘ)。代入前将热负荷从 kW 换算成 W。',
    reference: ['华盛顿大学圣路易斯分校 · 换热器实验', 'https://classes.engineering.wustl.edu/mase-thermal-lab/me372b5.htm'],
    calculate: ({ heat, u, dt, f }) => [heat * 1000 / (u * f * dt)],
  },
  {
    id: 'mass-flow', group: '物料衡算', name: '体积流量换算质量流量',
    description: '密度与体积流量需对应同一温度、压力和组成。',
    fields: [flow(55, { min: 0 }), density], result: [['质量流量', 'kg/h'], ['质量流量', 'kg/s']],
    equation: 'ṁ = ρQ', reference: flowRef,
    calculate: ({ q, rho }) => [q * rho * 3600, q * rho],
  },
  {
    id: 'blend', group: '物料衡算', name: '计算两股物流混合后的质量分数',
    description: '两股物流按同一个组分填质量百分比。适用于稳态、无反应、无物料损失的混合。',
    fields: [mass('m1', '物流 1 质量流量', 600, { min: 0 }),
      field('w1', '物流 1 中该组分质量分数', percent, 12, { min: 0, max: 100 }),
      mass('m2', '物流 2 质量流量', 400, { min: 0 }),
      field('w2', '物流 2 中该组分质量分数', percent, 2, { min: 0, max: 100 })],
    result: [['混合后质量分数', '%'], ['混合后总质量流量', 'kg/h']],
    equation: 'w = (ṁ₁w₁ + ṁ₂w₂) / (ṁ₁ + ṁ₂)',
    calculate: ({ m1, m2, w1, w2 }) => {
      const total = m1 + m2;
      if (total === 0) throw new Error('至少一股物流的质量流量要大于 0。');
      return [100 * ((m1 / total) * w1 + (m2 / total) * w2), total * 3600];
    },
  },
];

export function calculateFormula(formula, values) {
  const errors = {};
  const inputs = [];
  for (const item of formula.fields) {
    const { raw = '', unit } = values[item.key] ?? {};
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(number)) errors[item.key] = '请输入有效数值。';
    else if (item.min != null && number < item.min) errors[item.key] = '请输入不小于 ' + item.min + ' 的数值。';
    else if (item.min == null && !item.signed && number <= 0) errors[item.key] = '请输入大于 0 的数值。';
    else if (item.max != null && number > item.max) errors[item.key] = '请输入不大于 ' + item.max + ' 的数值。';
    else if (!Object.hasOwn(item.units, unit)) errors[item.key] = '请选择有效单位。';
    else inputs.push([item.key, number * item.units[unit]]);
  }
  if (Object.keys(errors).length) return { errors };
  try {
    const outputs = formula.calculate(Object.fromEntries(inputs));
    if (!outputs.every(Number.isFinite)) throw new Error('结果超出可计算范围。请核对数值和单位。');
    return { outputs, normalized: Object.fromEntries(inputs) };
  } catch (error) {
    return { message: error.message };
  }
}
