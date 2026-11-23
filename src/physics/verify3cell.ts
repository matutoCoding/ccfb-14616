// 三颗电芯串排手算校验算例
// 场景：绝热边界，cell1 瞬时触发失控并按矩形功率释热，求 cell2 达到 T2 的蔓延时间
// 手算解析解：将 cell1 视为恒温 T_hot（热库近似），cell2/cell3 为两节点 RC 网络，
// 用矩阵指数求精确解；同时给出单节点集总手算式 τ·ln(ΔT0/ΔT*) 作对照。
import type { ChemSpec } from '../model/types';
import type { Topology } from '../model/topology';
import { c2k, LFP_280AH } from '../model/defaults';
import { ThermalCore, type CoreOptions } from './thermalCore';

export interface VerifyTopology extends Topology {}

/** 构造 3 串绝热小拓扑：gx 直接给定，无外壳/液冷/并联方向 */
export function buildThreeCellTopology(chem: ChemSpec, g: number): Topology {
  const n = 3;
  const topo: Topology = {
    cellCount: 3, moduleCount: 1, rackCount: 1, totalNodes: 4,
    modulesPerRack: 1, cellsPerModule: 3,
    posX: new Float64Array([0, 0.1, 0.2]), posY: new Float64Array(3), posZ: new Float64Array(3),
    rackId: new Int32Array([0, 0, 0]), moduleId: new Int32Array([0, 0, 0]),
    cap: new Float64Array(3).fill(chem.mass * chem.specificHeat),
    gx: new Float64Array(3).fill(g), gy: new Float64Array(3),
    gShell: new Float64Array(3), gCold: new Float64Array(3),
    neighbor: new Int32Array(12).fill(-1),
    shellNode: new Int32Array([3, 3, 3]),
    shellCap: new Float64Array([1e12]), // 极大热容，且 gShell=0 → 不参与换热
    shellGAmbient: new Float64Array([0]), shellPos: new Float64Array(3),
    moduleRack: new Int32Array([0]), shellGNext: new Float64Array([0]),
    rackOrigin: new Float64Array(3),
    moduleDims: [1, 1, 1], cellDims: chem.dims, indexInModule: new Int32Array([0, 1, 2]),
  };
  // 串联邻居：0-1-2
  topo.neighbor[4 * 0 + 1] = 1;
  topo.neighbor[4 * 1 + 0] = 0;
  topo.neighbor[4 * 1 + 1] = 2;
  topo.neighbor[4 * 2 + 0] = 1;
  return topo;
}

/**
 * 解析解：cell1 恒温 T_hot，cell2、cell3 热容均为 C，电导均为 g
 * d/dt [T2;T3] = [[-2a, a],[a, -a]]·[T2;T3] + [a·Thot; 0],  a = g/C
 * 对称三对角矩阵特征值：λ1 = a·(-3+√5)/2, λ2 = a·(-3-√5)/2
 */
export function analyticTemp2(t: number, p: { C: number; g: number; T0: number; Thot: number }): number {
  const { C, g, T0, Thot } = p;
  const a = g / C;
  const s5 = Math.sqrt(5);
  const l1 = a * (-3 + s5) / 2;
  const l2 = a * (-3 - s5) / 2;
  // 稳态 T2(∞) = Thot（链末端绝热，整链均温）
  const d0 = T0 - Thot;
  // 特征向量分解（3 阶链的前两节点），数值稳定写法：
  // T2(t)-Thot = d0·[ (5+√5)/10 ·e^(λ1 t) + (5-√5)/10 ·e^(λ2 t) ]
  const w1 = (5 + s5) / 10;
  const w2 = (5 - s5) / 10;
  return Thot + d0 * (w1 * Math.exp(l1 * t) + w2 * Math.exp(l2 * t));
}

/** 二分求 T2(t) 达到目标温度的时刻（解析解） */
export function analyticReachTime(p: { C: number; g: number; T0: number; Thot: number; target: number }): number {
  if (p.target >= p.Thot) return Infinity;
  let lo = 0, hi = 1e5;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (analyticTemp2(mid, p) < p.target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 单节点集总手算式（忽略 cell3 吸热）：τ = C/g, t = τ·ln((Thot-T0)/(Thot-T*)) */
export function lumpedHandCalc(p: { C: number; g: number; T0: number; Thot: number; target: number }): number {
  const tau = p.C / p.g;
  return tau * Math.log((p.Thot - p.T0) / (p.Thot - p.target));
}

export interface VerifyReport {
  params: { C: number; g: number; T0: number; Thot: number; target: number; ventDuration: number };
  analyticTime: number;
  lumpedTime: number;
  cpuReachTime: number;
  cpuSteps: number;
  cpuErrorPct: number;
  tempTrace: { t: number; t1: number; t2: number; t3: number; analyticT2: number }[];
  pass5pct: boolean;
}

export async function runThreeCellVerify(): Promise<VerifyReport> {
  const chem: ChemSpec = {
    ...LFP_280AH,
    // 校验算例用温和的自产热（避免环境温度下自产热干扰解析对照）
    selfHeatTable: [
      { t: c2k(0), power: 0 },
      { t: c2k(300), power: 0 },
    ],
  };
  const C = chem.mass * chem.specificHeat;
  // 界面电导取无隔热垫、仅导热胶界面的典型模组量级（R≈0.5 K/W）
  const g = 2;
  const T0 = c2k(25);
  const Thot = c2k(400);            // cell1 失控后等效热库温度
  const target = chem.tTrigger;     // cell2 到 T2 即判蔓延
  const topo = buildThreeCellTopology(chem, g);

  // cell1 用极大质量倍率让它在观测窗内近似恒温（热库），与解析假设一致
  topo.cap[0] = C * 1e6;

  const core = new ThermalCore(topo, T0);
  (core as unknown as { temp: Float64Array }).temp[0] = Thot;

  const opts: CoreOptions = {
    endTime: 5000, maxDt: 1, snapshotInterval: 5,
    ambientTemp: T0, chem, triggers: [], coolingEnabled: false,
    suppression: null, inletTemp: T0, chunkSimSeconds: 1e9, peakTemp: 0,
  };
  const result = await core.run(opts);

  // 在快照上插值找 cell2 达 T2 的时刻
  let reach = -1;
  for (let f = 1; f < result.times.length; f++) {
    const t2 = result.tempFrames[f][1];
    if (t2 >= target) {
      const t2prev = result.tempFrames[f - 1][1];
      const frac = (target - t2prev) / Math.max(t2 - t2prev, 1e-12);
      reach = result.times[f - 1] + frac * (result.times[f] - result.times[f - 1]);
      break;
    }
  }

  const ap = { C, g, T0, Thot, target };
  const analyticTime = analyticReachTime(ap);
  const lumpedTime = lumpedHandCalc(ap);
  const errPct = 100 * Math.abs(reach - analyticTime) / analyticTime;

  const trace: VerifyReport['tempTrace'] = [];
  for (let f = 0; f < result.times.length; f += Math.max(1, Math.floor(result.times.length / 40))) {
    const t = result.times[f];
    trace.push({
      t,
      t1: result.tempFrames[f][0],
      t2: result.tempFrames[f][1],
      t3: result.tempFrames[f][2],
      analyticT2: analyticTemp2(t, ap),
    });
  }

  return {
    params: { C, g, T0, Thot, target, ventDuration: chem.ventDuration },
    analyticTime, lumpedTime,
    cpuReachTime: reach, cpuSteps: result.steps,
    cpuErrorPct: errPct,
    tempTrace: trace,
    pass5pct: errPct <= 5,
  };
}
