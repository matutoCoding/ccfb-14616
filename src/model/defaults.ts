// 默认物理参数与预设：280Ah 磷酸铁锂 / 三元典型值
// 参考量级：GB/T 36276、《电化学储能电站设计规范》及主流电芯厂公开规格书区间
import type { ChemSpec, CoolingConfig, ModuleMaterials, ProjectConfig, SuppressionConfig, CabinLayout, ModuleLayout, DetectorSpec } from './types';

export const KELVIN_0C = 273.15;
export const c2k = (c: number) => c + KELVIN_0C;
export const k2c = (k: number) => k - KELVIN_0C;

/** 280Ah 磷酸铁锂方壳（行业最主流规格） */
export const LFP_280AH: ChemSpec = {
  id: 'lfp-280ah',
  name: '磷酸铁锂 280Ah 方壳',
  kind: 'LFP',
  capacityAh: 280,
  mass: 5.32,
  specificHeat: 1100,
  // 标准方壳外形：宽 174mm × 厚 72mm × 高 207mm
  dims: [0.174, 0.072, 0.207],
  tOnset: c2k(80),        // T1 自产热起始 ~80℃
  tTrigger: c2k(230),     // T2 热失控触发 ~230℃（LFP 较高）
  // 自产热分段：T1 以下近似 0；T1→T2 加速；单位 W（单体）
  selfHeatTable: [
    { t: c2k(60), power: 0 },
    { t: c2k(80), power: 0.4 },
    { t: c2k(120), power: 2.5 },
    { t: c2k(170), power: 12 },
    { t: c2k(200), power: 38 },
    { t: c2k(230), power: 95 },
  ],
  runawayEnergy: 34000,   // ~34 kJ/单体（LFP 公开试验区间 25~45 kJ，电化学放热口径）
  /** 失控喷发期观测峰值温度 K（工程等效热库，用于驱动蔓延） */
  runawayPeakTemp: c2k(550),
  ventDuration: 18,
  ventGasMol: 1.6,
  ventSmoke: 1.0,
};

/** 三元 NCM 50Ah 方壳（热失控更剧烈，T2 更低） */
export const NCM_50AH: ChemSpec = {
  id: 'ncm-50ah',
  name: '三元 NCM 50Ah 方壳',
  kind: 'NCM',
  capacityAh: 50,
  mass: 0.92,
  specificHeat: 900,
  dims: [0.148, 0.027, 0.095],
  tOnset: c2k(60),
  tTrigger: c2k(150),
  selfHeatTable: [
    { t: c2k(50), power: 0 },
    { t: c2k(60), power: 0.6 },
    { t: c2k(90), power: 4 },
    { t: c2k(120), power: 18 },
    { t: c2k(150), power: 60 },
  ],
  runawayEnergy: 18000,
  runawayPeakTemp: c2k(700),
  ventDuration: 12,
  ventGasMol: 1.1,
  ventSmoke: 1.4,
};

/** 默认模组材料配置（气凝胶隔热垫可开关做方案对比） */
export function defaultMaterials(aerogelEnabled = true): ModuleMaterials {
  return {
    aerogelEnabled,
    // 气凝胶毡典型 2~4mm，导热系数 ~0.02 W/(m·K)
    aerogel: { thickness: 0.003, conductivity: 0.02 },
    // 铝排：纯铝 ~205 W/(m·K)
    busbar: { thickness: 0.002, conductivity: 205 },
    // 结构导热胶 ~1.5 W/(m·K)
    thermalGlue: { thickness: 0.0015, conductivity: 1.5 },
    cellGap: 0,
    shellThickness: 0.0015,
    shellConductivity: 16, // 涂覆钢板等效
    coldPlateThickness: 0.004,
    coldPlateConductivity: 220,
    coldPlateAreaPerCell: 0.0125, // 174mm × 72mm 面的一部分
  };
}

export const DEFAULT_COOLING: CoolingConfig = {
  enabled: true,
  inletTemp: c2k(25),
  flowLpm: 120,
  fluidSpecificHeat: 3300, // 乙二醇水溶液
  fluidDensity: 1.04,
  branchesPerRack: 1,
  failedBranches: [],
  failTime: 600,
};

export const DEFAULT_SUPPRESSION: SuppressionConfig = {
  enabled: true,
  agent: 'FK-5-1-12',
  dischargeDelay: 10,
  coolRate: 0.8,       // 全氟己酮喷放后等效降温速率 K/s（工程标定输入项）
  duration: 600,
  zoneVolume: 28,
};

/** 20 尺：6.06m × 2.44m × 2.59m；40 尺：12.19m × 2.44m × 2.59m */
export function defaultCabin(container: '20ft' | '40ft'): CabinLayout {
  const len = container === '20ft' ? 6.058 : 12.192;
  return {
    container,
    rackCount: container === '20ft' ? 2 : 2,
    modulesPerRack: 8,
    dims: [len, 2.438, 2.591],
    hvBoxPos: [len - 0.6, 0.9, 1.2],
    acVents: [[0.3, 2.3, 1.0], [0.3, 2.3, 1.6]],
    ambientTemp: c2k(25),
    ambientH: 5,
  };
}

export const DEFAULT_LAYOUT: ModuleLayout = {
  modulesPerRack: 8,
  // 280Ah 模组常见 1P52S
  cellsSeriesX: 26,
  cellsParallelY: 2,
  moduleDims: [1.05, 0.62, 0.24],
};

/** 默认探测器：每簇上方一组（气体/烟感/温感） */
export function defaultDetectors(rackCount: number): DetectorSpec[] {
  const out: DetectorSpec[] = [];
  for (let r = 0; r < rackCount; r++) {
    const x = 2 + r * 4.5;
    out.push({ id: `gas-${r}`, kind: 'gas', label: `可燃气体#${r + 1}`, position: [x, 2.2, 1.2], zone: r, threshold: 0.25 });
    out.push({ id: `smk-${r}`, kind: 'smoke', label: `烟感#${r + 1}`, position: [x, 2.25, 1.2], zone: r, threshold: 15 });
    out.push({ id: `tmp-${r}`, kind: 'temp', label: `温感#${r + 1}`, position: [x, 2.15, 1.2], zone: r, threshold: c2k(70) });
  }
  return out;
}

let seq = 0;
export function uid(prefix = 'id'): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function defaultProject(container: '20ft' | '40ft' = '40ft'): ProjectConfig {
  const now = Date.now();
  const cabin = defaultCabin(container);
  return {
    id: uid('proj'),
    name: container === '20ft' ? '20尺储能舱方案' : '40尺两簇储能舱方案',
    createdAt: now,
    updatedAt: now,
    cabin,
    layout: { ...DEFAULT_LAYOUT, modulesPerRack: cabin.modulesPerRack },
    materials: defaultMaterials(true),
    chem: { ...LFP_280AH, selfHeatTable: LFP_280AH.selfHeatTable.map((s) => ({ ...s })) },
    altChems: [{ ...NCM_50AH, selfHeatTable: NCM_50AH.selfHeatTable.map((s) => ({ ...s })) }],
    cooling: { ...DEFAULT_COOLING, failedBranches: [] },
    triggers: [],
    detectors: defaultDetectors(cabin.rackCount),
    suppression: { ...DEFAULT_SUPPRESSION },
    overrides: {},
  };
}
