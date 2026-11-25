import type { Scheme } from '../types';

export const CONTAINERS = {
  '20ft': { kind: '20ft' as const, length: 5.898, width: 2.352, height: 2.393, wallThickness: 0.08 },
  '40ft': { kind: '40ft' as const, length: 12.032, width: 2.352, height: 2.393, wallThickness: 0.08 },
};

export function createLfp280Spec() {
  return {
    id: 'spec-lfp-280',
    name: '磷酸铁锂 280Ah 方壳',
    chemistry: 'LFP' as const,
    capacityAh: 280,
    nominalVoltageV: 3.2,
    massKg: 5.45,
    specificHeatJkgK: 1100,
    dimensionsMm: { x: 72, y: 205, z: 174 },
    kThroughWmK: 2.8,
    kInPlaneWmK: 26,
    selfHeatStartC: 60,
    onsetTempC: 150,
    runawayHeatJ: 6_500_000,
    retainedFraction: 0.42,
    eruptionDurationS: 48,
    ventGasM3: 0.28,
    selfHeat: [
      { id: 'lfp-40', fromC: 40, heatW: 0 },
      { id: 'lfp-60', fromC: 60, heatW: 2.5 },
      { id: 'lfp-90', fromC: 90, heatW: 18 },
      { id: 'lfp-120', fromC: 120, heatW: 130 },
      { id: 'lfp-140', fromC: 140, heatW: 720 },
    ],
  };
}

export function createNcm280Spec() {
  return {
    id: 'spec-ncm-280',
    name: '三元 NCM 280Ah 方壳',
    chemistry: 'NCM' as const,
    capacityAh: 280,
    nominalVoltageV: 3.65,
    massKg: 5.35,
    specificHeatJkgK: 1050,
    dimensionsMm: { x: 72, y: 205, z: 174 },
    kThroughWmK: 2.2,
    kInPlaneWmK: 22,
    selfHeatStartC: 55,
    onsetTempC: 126,
    runawayHeatJ: 7_600_000,
    retainedFraction: 0.46,
    eruptionDurationS: 28,
    ventGasM3: 0.36,
    selfHeat: [
      { id: 'ncm-40', fromC: 40, heatW: 0 },
      { id: 'ncm-55', fromC: 55, heatW: 5 },
      { id: 'ncm-80', fromC: 80, heatW: 45 },
      { id: 'ncm-105', fromC: 105, heatW: 320 },
      { id: 'ncm-120', fromC: 120, heatW: 1450 },
    ],
  };
}

export function createDefaultScheme(): Scheme {
  const now = Date.now();
  return {
    id: 'scheme-seed-40ft-two-cluster',
    name: '示例：40尺两簇储能舱（含异常导热参数）',
    description: '两簇、每簇4模组、每模组48颗 LFP 280Ah。cell-7/cell-12/cell-19 故意填入错数量级导热系数，用于验证参数诊断。',
    createdAt: now,
    updatedAt: now,
    cabin: {
      container: { ...CONTAINERS['40ft'] },
      clusterCount: 2,
      modulesPerCluster: 4,
      cellsPerModule: 48,
      moduleColumns: 2,
      moduleLevels: 2,
      cellColumns: 8,
      cellRows: 6,
      clusterSpacingM: 0.8,
      objects: [
        { id: 'obj-hvbox', kind: 'hvBox', name: '高压箱', position: { x: 5.15, y: 1.05, z: 0.55 }, size: { x: 0.75, y: 1.9, z: 0.75 }, color: '#f59e0b', enabled: true },
        { id: 'obj-ac-1', kind: 'acVent', name: '空调出风口 A', position: { x: -4.8, y: 2.18, z: -0.75 }, size: { x: 0.9, y: 0.18, z: 0.28 }, color: '#38bdf8', enabled: true },
        { id: 'obj-ac-2', kind: 'acVent', name: '空调出风口 B', position: { x: 4.2, y: 2.18, z: -0.75 }, size: { x: 0.9, y: 0.18, z: 0.28 }, color: '#38bdf8', enabled: true },
        { id: 'obj-pipe-supply', kind: 'coolantPipe', name: '供液主管', position: { x: 0, y: 0.22, z: 1.02 }, size: { x: 10.5, y: 0.08, z: 0.08 }, color: '#0ea5e9', enabled: true, circuitId: 'cooling-1' },
        { id: 'obj-pipe-return', kind: 'coolantPipe', name: '回液主管', position: { x: 0, y: 0.34, z: 1.12 }, size: { x: 10.5, y: 0.08, z: 0.08 }, color: '#6366f1', enabled: true, circuitId: 'cooling-2' },
        { id: 'obj-exhaust', kind: 'exhaust', name: '泄爆/排风口', position: { x: 5.7, y: 2.05, z: 0 }, size: { x: 0.12, y: 0.7, z: 1.1 }, color: '#94a3b8', enabled: true },
      ],
      detectors: [
        { id: 'det-gas-1', kind: 'gas', name: '可燃气体探测器 1', position: { x: -2.7, y: 2.15, z: 0.75 }, alarmThreshold: 0.8, rateThreshold: 0, zoneId: 'zone-cluster-1' },
        { id: 'det-gas-2', kind: 'gas', name: '可燃气体探测器 2', position: { x: 2.7, y: 2.15, z: 0.75 }, alarmThreshold: 0.8, zoneId: 'zone-cluster-2' },
        { id: 'det-smoke-1', kind: 'smoke', name: '烟感 1', position: { x: -2.7, y: 2.28, z: -0.2 }, alarmThreshold: 0.12, zoneId: 'zone-cluster-1' },
        { id: 'det-smoke-2', kind: 'smoke', name: '烟感 2', position: { x: 2.7, y: 2.28, z: -0.2 }, alarmThreshold: 0.12, zoneId: 'zone-cluster-2' },
        { id: 'det-temp-1', kind: 'temperature', name: '温感/温升电缆 1', position: { x: -2.7, y: 2.2, z: 0 }, alarmThreshold: 57, rateThreshold: 8, zoneId: 'zone-cluster-1' },
        { id: 'det-temp-2', kind: 'temperature', name: '温感/温升电缆 2', position: { x: 2.7, y: 2.2, z: 0 }, alarmThreshold: 57, rateThreshold: 8, zoneId: 'zone-cluster-2' },
      ],
      cooling: [
        {
          id: 'cooling-1',
          name: '1簇液冷支路',
          inletTempC: 28,
          flowLpm: 120,
          fluidCpJkgK: 3800,
          densityKgM3: 1050,
          pipeLengthM: 5.5,
          active: true,
          pumpFailed: false,
          clusterIds: ['cluster-1'],
          path: [{ x: -5.4, y: 0.25, z: 1.0 }, { x: 0, y: 0.25, z: 1.0 }],
        },
        {
          id: 'cooling-2',
          name: '2簇液冷支路',
          inletTempC: 28,
          flowLpm: 120,
          fluidCpJkgK: 3800,
          densityKgM3: 1050,
          pipeLengthM: 5.5,
          active: true,
          pumpFailed: false,
          clusterIds: ['cluster-2'],
          path: [{ x: 0, y: 0.25, z: 1.0 }, { x: 5.4, y: 0.25, z: 1.0 }],
        },
      ],
    },
    cellSpecs: [createLfp280Spec(), createNcm280Spec()],
    defaultSpecId: 'spec-lfp-280',
    module: {
      cellGapMm: 3,
      insulation: { id: 'mat-aerogel', name: '气凝胶隔热垫', thicknessMm: 2, conductivityWmK: 0.024 },
      adhesive: { id: 'mat-adhesive', name: '导热结构胶', thicknessMm: 1.5, conductivityWmK: 1.2 },
      busbar: { id: 'mat-busbar', name: '铝排', thicknessMm: 2.5, widthMm: 42, conductivityWmK: 165 },
      busbarCountPerGap: 1,
      shell: { id: 'mat-steel', name: '模组钢壳', thicknessMm: 2, conductivityWmK: 45 },
      coldPlate: { id: 'mat-coldplate', name: '铝液冷板', thicknessMm: 12, conductivityWmK: 160 },
      coldPlateContactAreaFactor: 0.82,
      radiationEmissivity: 0.8,
    },
    trigger: {
      simultaneous: false,
      targets: [
        { cellId: 'cell-1', kind: 'nail', powerW: 12000, durationS: 1800 },
      ],
    },
    suppression: {
      agentName: '全氟己酮 C6F12O',
      releaseDelayS: 15,
      coolingRateCPerMin: 6,
      durationS: 120,
      active: false,
    },
    cellOverrides: {
      // Deliberate order-of-magnitude data-entry faults. Validation must flag
      // these before a production run instead of turning G into infinity.
      'cell-7': { kThroughWmK: 28000 },
      'cell-12': { kInPlaneWmK: 0.018 },
      'cell-19': { kThroughWmK: 0.0022 },
    },
  };
}

export function createStressScheme(cellCount = 12000): Scheme {
  const base = createDefaultScheme();
  const cellsPerModule = 48;
  const moduleCount = Math.ceil(cellCount / cellsPerModule);
  const clusterCount = 10;
  const modulesPerCluster = Math.ceil(moduleCount / clusterCount);
  return {
    ...base,
    id: `scheme-stress-${cellCount}`,
    name: `性能压测：${cellCount.toLocaleString()} 节点计算阵列`,
    description: '用于 WebGPU 计算与实例化渲染性能验证；几何按规则阵列重排。',
    cabin: {
      ...base.cabin,
      clusterCount,
      modulesPerCluster,
      cellsPerModule,
      moduleColumns: 5,
      moduleLevels: Math.ceil(modulesPerCluster / 5),
      cellColumns: 8,
      cellRows: 6,
      cooling: [
        { ...base.cabin.cooling[0], id: 'cooling-stress', name: '集中液冷环路', clusterIds: Array.from({ length: clusterCount }, (_, i) => `cluster-${i + 1}`), flowLpm: 1200 },
      ],
      detectors: [],
      objects: [],
    },
    cellOverrides: {},
    trigger: { simultaneous: true, targets: [{ cellId: 'cell-1', kind: 'manual' }, { cellId: `cell-${Math.floor(cellCount / 2)}`, kind: 'manual' }] },
    suppression: { ...base.suppression, active: false },
  };
}

export function cloneScheme(s: Scheme): Scheme {
  return structuredClone(s);
}
