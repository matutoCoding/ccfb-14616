// 物理常量与合理范围(用于量纲/数量级校验)
export const R = 8.314462618; // 气体常数 J/(mol·K)
export const KELVIN_0C = 273.15;

/** 工程合理区间 —— 超出即判定为可疑(多为单位或数量级填错) */
export const RANGES = {
  specificHeat: { min: 500, max: 3000, unit: 'J/(kg·K)', typical: 1100 },
  mass: { min: 0.5, max: 15, unit: 'kg', typical: 5.4 },
  conductivity: { min: 0.01, max: 500, unit: 'W/(m·K)' },
  thickness: { min: 1e-5, max: 0.05, unit: 'm' },
  trHeatTotal: { min: 5e3, max: 5e5, unit: 'J' }, // 单颗电芯放热量,常见 3e4~1.5e5
  ventDuration: { min: 1, max: 300, unit: 's' },
  temp: { min: 233, max: 600, unit: 'K' },
  ventGasMol: { min: 0.1, max: 200, unit: 'mol' },
};

/** 常见材料导热系数参考表 W/(m·K),用于与填报值比对 */
export const MATERIAL_CONDUCTIVITY = {
  air: 0.026,
  aerogel: 0.018,
  thermalGlue: 1.5,
  aluminum: 202,
  copper: 398,
  steel: 45,
};

/** 斯蒂芬-玻尔兹曼常数 W/(m2·K4) */
export const SIGMA = 5.670374419e-8;
/** 电芯表面发射率(钢壳/铝壳氧化面) */
export const CELL_EMISSIVITY = 0.8;
/** 相邻贴合面视角系数 */
export const VIEW_FACTOR = 0.6;

/** 两种化学体系的缺省电芯参数 */
export function defaultCellSpec(kind: 'LFP' | 'NCM'): import('../types.ts').CellSpec {
  if (kind === 'LFP') {
    return {
      chemistry: 'LFP',
      capacityAh: 280,
      width: 0.174, height: 0.207, depth: 0.072, // 主流 280Ah 方壳尺寸
      mass: 5.32,
      specificHeat: 1100,
      selfHeatStartT: KELVIN_0C + 120, // 393.15 K
      trTriggerT: KELVIN_0C + 270,     // 543.15 K
      trHeatTotal: 34000,             // 文献区间 ~30-60 kJ/颗(280Ah LFP)
      ventDuration: 22,
      ventGasMol: 1.6,
      flamePlateauT: KELVIN_0C + 600, // 喷发火焰平台温度
      flameHoldS: 180,                // 平台维持时长(外部火焰+残燃)
    };
  }
  return {
    chemistry: 'NCM',
    capacityAh: 100,
    width: 0.148, height: 0.108, depth: 0.027,
    mass: 1.85,
    specificHeat: 900,
    selfHeatStartT: KELVIN_0C + 80,
    trTriggerT: KELVIN_0C + 210,
    trHeatTotal: 28000,
    ventDuration: 12,
    ventGasMol: 1.2,
    flamePlateauT: KELVIN_0C + 800,
    flameHoldS: 120,
  };
}
