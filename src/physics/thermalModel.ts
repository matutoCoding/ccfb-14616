// 热模型方程 —— TS 参考实现,WGSL 着色器必须与本文件保持同构
import type { Chemistry } from '../types';
import { KELVIN_0C } from './constants';

/** 自产热分段线性表:温度(℃) -> 单位质量发热功率 W/kg */
export const SELF_HEAT_TABLE: Record<Chemistry, { tC: number[]; q: number[] }> = {
  LFP: {
    tC: [120, 150, 180, 210, 240, 270],
    q:  [0.5, 2.0, 8.0,  25,  60,  200],
  },
  NCM: {
    tC: [80, 110, 140, 170, 190, 210],
    q:  [0.5, 3.0, 12, 40, 100, 300],
  },
};

function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return 0; // 起始温度以下不产热
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) {
      const f = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + f * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
}

/** 自产热功率 W(单颗电芯)。低于自产热起始温度不产热;起始后按分段线性表 */
export function selfHeatPower(chem: Chemistry, Tk: number, mass: number, selfStartTk?: number): number {
  if (selfStartTk !== undefined && Tk < selfStartTk) return 0;
  const tC = Tk - KELVIN_0C;
  return mass * interp(tC, SELF_HEAT_TABLE[chem].tC, SELF_HEAT_TABLE[chem].q);
}

/** 喷发归一化功率曲线(三角形,峰值在 s=0.25,积分=1) */
export function ventProfile(s: number): number {
  if (s <= 0 || s >= 1) return 0;
  return s <= 0.25 ? 8 * s : (2 / 0.75) * (1 - s);
}

/** 失控喷发瞬时放热功率 W */
export function trVentPower(qTotal: number, ventDuration: number, elapsed: number): number {
  if (ventDuration <= 0) return 0;
  const s = elapsed / ventDuration;
  return (qTotal / ventDuration) * ventProfile(s);
}

/**
 * 相邻电芯贴合面辐射换热功率 W(只在邻居处于喷发/残燃高温时有显著贡献)。
 * 灰体近似:q = eps_eff * F * A * sigma * (Th^4 - Tc^4)
 */
export function radiationPower(area: number, Th: number, Tc: number, emissivity: number, viewFactor: number): number {
  if (Th <= Tc) return 0;
  return emissivity * viewFactor * area * 5.670374419e-8 * (Th ** 4 - Tc ** 4);
}

/** 喷发结束后电芯保持的等效温度(平台期);平台结束返回 NaN 表示不再约束 */
export function postVentTemp(plateauT: number, holdS: number, elapsedSinceTR: number, ventDuration: number): number {
  if (elapsedSinceTR >= ventDuration && elapsedSinceTR <= ventDuration + holdS) return plateauT;
  return NaN;
}

/** 温度量化(回放快照用):u16,基准 200K,分辨率 1/64 K */
export function quantizeT(T: number): number {
  return Math.max(0, Math.min(65535, Math.round((T - 200) * 64)));
}
export function dequantizeT(v: number): number {
  return 200 + v / 64;
}

/** 电芯状态枚举(与 WGSL 一致) */
export const CellState = { Normal: 0, SelfHeating: 1, Venting: 2, Spent: 3 } as const;
