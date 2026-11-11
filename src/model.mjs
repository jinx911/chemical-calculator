/** Creates a project whose limits are expressed in m/s and kPa. */
export function createProject(name) {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    limits: { velocity: '', pressure: '' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Creates an editable pipe calculation sheet in the given project. */
export function createWorksheet(projectId) {
  return {
    id: crypto.randomUUID(),
    projectId,
    draft: {
      line: '',
      medium: '',
      from: '',
      to: '',
      scenarios: [createScenario()],
      options: [createOption()],
      limits: {
        velocity: { mode: 'inherit', value: '' },
        pressure: { mode: 'inherit', value: '' },
      },
      selection: { optionId: '', reason: '' },
    },
    revision: 0,
    sequence: 0,
    updatedAt: new Date().toISOString(),
  };
}

/** Creates a scenario with independent flow and fluid property inputs. */
export function createScenario(previous) {
  return {
    id: crypto.randomUUID(),
    name: '',
    flow: '',
    flowUnit: previous?.flowUnit ?? 'm³/h',
    density: previous?.density ?? '',
    viscosity: previous?.viscosity ?? '',
    viscosityUnit: previous?.viscosityUnit ?? 'mPa·s',
    source: previous?.source ?? '',
  };
}

/** Creates a candidate pipe with optional default and per-scenario K values. */
export function createOption(previous) {
  return {
    id: crypto.randomUUID(),
    name: '',
    diameter: '',
    diameterUnit: previous?.diameterUnit ?? 'mm',
    length: previous?.length ?? '',
    roughness: previous?.roughness ?? '',
    roughnessUnit: previous?.roughnessUnit ?? 'mm',
    elevation: previous?.elevation ?? '',
    k: '',
    kSource: '',
    kRegime: 'any',
    kOverrides: {},
  };
}

export function scenarioLabel(scenario, index) {
  return scenario.name.trim() || '工况 ' + (index + 1);
}

export function optionLabel(option, index) {
  if (option.name.trim()) return option.name.trim();
  const diameter = String(option.diameter ?? '').trim();
  return diameter && Number.isFinite(Number(diameter)) && Number(diameter) > 0
    ? '内径 ' + diameter + ' ' + option.diameterUnit
    : '方案 ' + (index + 1);
}

function coolingWaterScenario(name, flow) {
  return {
    ...createScenario(), name, flow,
    density: '997', viscosity: '0.89', source: '循环冷却水改造算例给定物性',
  };
}

function coolingWaterOption(name, diameter, k) {
  return {
    ...createOption(), name, diameter, k,
    length: '120', roughness: '0.045', elevation: '4', kSource: '算例给定的管件总阻力系数',
  };
}

/** Creates a fresh copy of the public cooling water example. */
export function createExample() {
  const project = {
    ...createProject('循环冷却水改造'),
    limits: { velocity: '2', pressure: '35' },
  };
  const worksheet = createWorksheet(project.id);
  worksheet.draft = {
    ...worksheet.draft,
    line: '冷却水供水支线',
    medium: '循环冷却水',
    from: '循环水供水总管',
    to: '换热器冷却水入口',
    scenarios: [
      coolingWaterScenario('正常工况', '30'),
      coolingWaterScenario('最大工况', '45'),
    ],
    options: [
      coolingWaterOption('内径 102.3 mm', '102.3', '4.8'),
      coolingWaterOption('内径 128.2 mm', '128.2', '5.4'),
    ],
  };
  return { project, worksheet };
}
