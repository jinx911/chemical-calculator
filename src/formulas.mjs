const GRAVITY = 9.80665;
const flowUnits = { 'm³/h': 1 / 3600, 'L/s': 0.001, 'm³/s': 1 };
const massUnits = { 'kg/h': 1 / 3600, 'kg/s': 1, 't/h': 1000 / 3600 };
const diameterUnits = { mm: 0.001, m: 1 };
const pressureUnits = { kPa: 1, bar: 100, MPa: 1000, Pa: 0.001 };
const volumeUnits = { 'm³': 1, L: 0.001 };
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
const headRef = ['宾夕法尼亚州立大学 · 当量液柱高度', 'https://www.me.psu.edu/cimbala/me320/Lesson_Notes/Fluid_Mechanics_Lesson_02B.pdf'];
const absolutePressure = (key, label, example) => field(key, label, pressureUnits, example, { basis: 'kPa' });
const gasTemperature = (key, label, example) => field(key, label, { '°C': 1, K: 1 }, example, {
  signed: true, offsets: { '°C': 273.15 }, basis: 'K',
});

function tankVolume({ d, length, h }) {
  if (h > d) throw new Error('液深不能超过筒体内径。请核对液位零点和单位。');
  const fraction = h / d;
  const angle = 2 * Math.asin(Math.sqrt(Math.min(fraction, 1 - fraction)));
  // The series avoids subtracting nearly equal terms at very low fill.
  const sector = angle < 0.001 ? angle ** 3 * (2 / 3 - (2 / 15) * angle ** 2)
    : angle - Math.sin(angle) * Math.cos(angle);
  const filled = fraction > 0.5 ? 1 - sector / Math.PI : sector / Math.PI;
  const capacity = Math.PI * (d / 2) ** 2 * length;
  return [capacity * filled, capacity, 100 * filled];
}

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
    keywords: ['流量换算流速', '内径', '管内流速'],
    description: '根据实际内径和体积流量，计算满流圆管的截面平均流速。',
    fields: [flow(55, { min: 0 }), diameter], result: [['平均流速', 'm/s']],
    equation: 'v = 4Q / (πD²)', reference: flowRef,
    calculate: ({ q, d }) => [4 * q / (Math.PI * d ** 2)],
  },
  {
    id: 'pipe-diameter', group: '管道流动', name: '按目标流速反算管径',
    keywords: ['内径', '管径估算'],
    description: '结果是按流速反算的实际内径，可带入管径比选进一步校核压降。',
    fields: [flow(55), velocity], result: [['所需实际内径', 'mm']],
    equation: 'D = √(4Q / (πv))。将结果从 m 换算成 mm。', reference: flowRef,
    calculate: ({ q, v }) => [1000 * Math.sqrt(4 * q / (Math.PI * v))],
  },
  {
    id: 'reynolds', group: '管道流动', name: '计算圆管雷诺数',
    keywords: ['Re', 'Reynolds', '流态', '层流', '湍流'],
    description: '使用同一工况下的密度、平均流速、实际内径和动力黏度。',
    fields: [density, velocity, diameter, field('mu', '动力黏度 μ', { 'mPa·s': 0.001, 'Pa·s': 1 }, 0.89, { basis: 'Pa·s' })],
    result: [['雷诺数', '']], equation: 'Re = ρvD / μ', reference: pipeRef,
    calculate: ({ rho, v, d, mu }) => [rho * v * d / mu],
  },
  {
    id: 'pipe-loss', group: '管道流动', name: '已知摩阻系数，算单段管道压降',
    keywords: ['压差', '压损', '压力损失', '沿程损失', '局部损失', 'Darcy-Weisbach', 'pressure drop'],
    description: '适用于满流、等内径圆管中的稳态单相液体。f 填 Darcy 摩阻系数，K 填管件总局部阻力系数。无管件损失时 K 填 0。结果为阻力损失，不含高差。',
    fields: [flow(55, { min: 0 }), density, diameter, field('length', '直管长度 L', 'm', 120, { min: 0 }),
      field('f', 'Darcy 摩阻系数 f', '', 0.02), field('k', '总局部阻力系数 K', '', 4.8, { min: 0 })],
    result: [['阻力压降', 'kPa'], ['沿程压降', 'kPa'], ['局部压降', 'kPa'], ['平均流速', 'm/s']],
    equation: 'v = 4Q / (πD²)，沿程压降 = f(L/D)ρv²/2，局部压降 = Kρv²/2。压降从 Pa 换算成 kPa。',
    reference: ['EPA · 管路摩阻与局部损失', 'https://usepa.github.io/EPANET2.2/3_network_model.html'],
    calculate: ({ q, d, rho, length, f, k }) => {
      const v = 4 * q / (Math.PI * d ** 2);
      const dynamic = rho * v ** 2 / 2000;
      const straight = f * (length / d) * dynamic;
      const local = k * dynamic;
      return [straight + local, straight, local, v];
    },
  },
  {
    id: 'hydrostatic-pressure', group: '管道流动', name: '已知液柱高度，算静压差',
    keywords: ['静水压', '静液压', '高差', '压力差'],
    description: '用于密度近似恒定的静止液体。计算低点相对高点的压力增量。',
    fields: [field('h', '垂直液柱高度 h', 'm', 4, { min: 0 }), density],
    result: [['静压差', 'kPa']], equation: 'Δp = ρgh，g = 9.80665 m/s²。将 Pa 换算成 kPa。',
    reference: headRef, calculate: ({ h, rho }) => [rho * GRAVITY * h / 1000],
  },
  {
    id: 'pressure-head', group: '管道流动', name: '压力差换算等效液柱高度',
    keywords: ['压差', '压降换算', '压力水头'],
    description: '填两点压差的大小和对应液体的密度，用于换算压差对应的液柱高度。',
    fields: [field('dp', '压力差 Δp', pressureUnits, 100, { basis: 'kPa', min: 0 }), density],
    result: [['等效液柱高度', 'm']], equation: 'h = Δp / (ρg)。代入前将 kPa 换算成 Pa。',
    reference: headRef, calculate: ({ dp, rho }) => [dp * 1000 / (rho * GRAVITY)],
  },
  {
    id: 'pump-power', group: '泵', name: '已知扬程，算泵轴功率',
    keywords: ['泵功率', '水泵', '泵效率'],
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
    id: 'motor-input', group: '泵', name: '已知泵轴功率，算电机输入功率',
    keywords: ['电机功率', '耗电功率', '电机效率'],
    description: '用于电机与泵直联的工况。填写实际工作点的泵轴功率及电机效率。',
    fields: [field('shaft', '泵轴功率', 'kW', 5.4), field('eff', '电机效率', percent, 90, { max: 100, basis: '（比例）' })],
    result: [['电机输入功率', 'kW']], equation: '电机输入功率 = 泵轴功率 / 电机效率',
    reference: ['美国能源部 · 电机驱动系统效率', 'https://www.energy.gov/sites/prod/files/2014/04/f15/amo_motors_guidebook_web.pdf'],
    calculate: ({ shaft, eff }) => [shaft / eff],
  },
  {
    id: 'sensible-heat', group: '传热', name: '已知温差，算加热或冷却负荷',
    keywords: ['热负荷', '比热', '显热'],
    description: '适用于无相变、定压比热容可视为常量的情况。温差填出口减入口，结果为负表示流体放热。',
    fields: [mass('m', '质量流量 ṁ', 3600), field('cp', '定压比热容 cₚ', 'kJ/(kg·K)', 4.18),
      field('dt', '出口减入口的温差 ΔT', 'K（或 °C 温差）', 20, { signed: true })],
    result: [['显热负荷', 'kW']], equation: '热负荷 = ṁ cₚ ΔT', reference: heatRef,
    calculate: ({ m, cp, dt }) => [m * cp * dt],
  },
  {
    id: 'lmtd', group: '传热', name: '计算逆流换热器平均温差',
    keywords: ['LMTD', '对数温差'],
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
    keywords: ['换热器', '总传热系数', '传热面积'],
    description: '填入热负荷的大小、总传热系数和对数平均温差。纯逆流的温差修正系数填 1。',
    fields: [field('heat', '热负荷大小', 'kW', 100), field('u', '总传热系数 U', 'W/(m²·K)', 500),
      field('dt', '对数平均温差', 'K', 40), field('f', '温差修正系数 F', '', 1, { max: 1 })],
    result: [['换热面积', 'm²']], equation: 'A = 热负荷 / (U · F · ΔTₘ)。代入前将热负荷从 kW 换算成 W。',
    reference: ['华盛顿大学圣路易斯分校 · 换热器实验', 'https://classes.engineering.wustl.edu/mase-thermal-lab/me372b5.htm'],
    calculate: ({ heat, u, dt, f }) => [heat * 1000 / (u * f * dt)],
  },
  {
    id: 'latent-heat', group: '传热', name: '已知相变焓差，算蒸发或冷凝负荷',
    keywords: ['潜热', '汽化热', '汽化负荷', '冷凝热', '热负荷'],
    description: '按实际发生相变的质量流量计算热负荷大小。相变焓差取该工况的绝对值，进出口升降温所需的显热另算。',
    fields: [mass('m', '发生相变的质量流量', 1800, { min: 0 }), field('dh', '单位质量相变焓差', 'kJ/kg', 2200)],
    result: [['相变热负荷大小', 'kW']], equation: '相变热负荷 = 相变质量流量 × 单位质量相变焓差',
    reference: ['OpenStax · 相变与潜热', 'https://openstax.org/books/university-physics-volume-2/pages/1-5-phase-changes'],
    calculate: ({ m, dh }) => [m * dh],
  },
  {
    id: 'mix-temperature', group: '传热', name: '估算同种液体的混合温度',
    keywords: ['混合后温度', '掺混温度'],
    description: '适用于两股同种液体混合、比热容近似相同、无相变且可忽略对外换热的工况。',
    fields: [mass('m1', '物流 1 质量流量', 600), field('t1', '物流 1 温度', '°C', 80, { min: -273.15 }),
      mass('m2', '物流 2 质量流量', 400), field('t2', '物流 2 温度', '°C', 20, { min: -273.15 })],
    result: [['混合温度', '°C']], equation: 'T混 = (ṁ₁T₁ + ṁ₂T₂) / (ṁ₁ + ṁ₂)',
    reference: heatRef, calculate: ({ m1, m2, t1, t2 }) => [t2 + (t1 - t2) / (1 + m2 / m1)],
  },
  {
    id: 'mass-flow', group: '物料衡算', name: '体积流量换算质量流量',
    keywords: ['流量换算', '质量流率'],
    description: '密度与体积流量需对应同一温度、压力和组成。',
    fields: [flow(55, { min: 0 }), density], result: [['质量流量', 'kg/h'], ['质量流量', 'kg/s']],
    equation: 'ṁ = ρQ', reference: flowRef,
    calculate: ({ q, rho }) => [q * rho * 3600, q * rho],
  },
  {
    id: 'volume-flow', group: '物料衡算', name: '质量流量换算体积流量',
    keywords: ['流量换算', '体积流率'],
    description: '填写所需工况下的流体密度，得到该工况下的体积流量。',
    fields: [mass('m', '质量流量 ṁ', 49850, { min: 0 }), density],
    result: [['体积流量', 'm³/h'], ['体积流量', 'L/s']],
    equation: 'Q = ṁ / ρ。将 m³/s 换算成 m³/h 和 L/s。',
    reference: flowRef, calculate: ({ m, rho }) => [3600 * (m / rho), 1000 * (m / rho)],
  },
  {
    id: 'blend', group: '物料衡算', name: '计算两股物流混合后的质量分数',
    keywords: ['混合比例', '混合浓度', '质量百分比'],
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
  {
    id: 'gas-flow', group: '气体换算', name: '气体流量换算到指定温压',
    keywords: ['气体流量换算', '理想气体', '绝压', '标况', '工况'],
    description: '适用于组成不变且可按理想气体处理的工况。两处压力都填绝压，目标温度和压力按项目规定填写。',
    fields: [flow(500, { min: 0 }), absolutePressure('p1', '原工况绝压', 201.325),
      gasTemperature('t1', '原工况温度', 35), absolutePressure('p2', '目标工况绝压', 101.325),
      gasTemperature('t2', '目标工况温度', 20)],
    result: [['目标工况体积流量', 'm³/h']], equation: 'Q₂ = Q₁ × (p₁/p₂) × (T₂/T₁)，温度用 K。',
    reference: ['NASA · 理想气体状态方程', 'https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/equation-of-state-ideal-gas-2/'],
    calculate: ({ q, p1, p2, t1, t2 }) => [3600 * q * (p1 / p2) * (t2 / t1)],
  },
  {
    id: 'residence-time', group: '容器与停留时间', name: '已知有效容积，估算停留时间',
    keywords: ['持液时间', '水力停留时间', 'HRT'],
    description: '适用于稳态且液位基本恒定的单相流。填写参与流动的有效容积和总入口体积流量。',
    fields: [field('volume', '有效容积 V', volumeUnits, 12, { basis: 'm³' }), flow(24)],
    result: [['名义停留时间', 'min'], ['名义停留时间', 'h']], equation: 'τ = V / Q。将秒换算成分钟和小时。',
    reference: ['EPA · 理论停留时间', 'https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=P1019L0Q.TXT'],
    calculate: ({ volume, q }) => [volume / q / 60, volume / q / 3600],
  },
  {
    id: 'horizontal-tank', group: '容器与停留时间', name: '已知液位，算卧式圆筒液量',
    keywords: ['卧罐', '储罐', '液位容积', '充装率'],
    description: '液深从水平筒体内底量起。只计算等径圆筒段，带封头的设备需另计封头容积。',
    fields: [field('d', '筒体内径 D', 'm', 2), field('length', '等径筒段内长 L', 'm', 4),
      field('h', '从筒底量起的液深 h', 'm', 0.5, { min: 0 })],
    result: [['筒段液体体积', 'm³'], ['筒段全容积', 'm³'], ['筒段充装比例', '%']],
    equation: 'r = D/2，θ = arccos(1 − h/r)，液量 = Lr²(θ − sinθ cosθ)，θ 用弧度。',
    reference: ['Perry 化工手册 · 储运设备', 'https://schneider.cheme.cmu.edu/Files/Perry%27s%20Chemical%20Engineers%27%20Handbook%207th%20Edition/10.%20Transport%20and%20Storage%20of%20Fluids.pdf'],
    calculate: tankVolume,
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
    else {
      const normalized = number * item.units[unit] + (item.offsets?.[unit] ?? 0);
      if (!Number.isFinite(normalized)) errors[item.key] = '换算后的数值超出可计算范围。';
      else if (item.offsets && normalized <= 0) errors[item.key] = '绝对温度须大于 0 K。';
      else inputs.push([item.key, normalized]);
    }
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
