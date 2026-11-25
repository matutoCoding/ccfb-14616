// CPU 参考求解器:与 WGSL 同一套方程,用于手算算例校验和无 WebGPU 时回退
import type { Chemistry, NozzleSpec } from '../types';
import type { ThermalNetwork } from './geometry';
import { selfHeatPower, trVentPower, radiationPower, postVentTemp, CellState } from './thermalModel';
import { CELL_EMISSIVITY, VIEW_FACTOR } from './constants';

export interface RefCellParams {
  chemistry: Chemistry;
  mass: Float32Array;
  selfStartT: Float32Array;
  trTriggerT: Float32Array;
  trHeatTotal: Float32Array;
  ventDuration: Float32Array;
  flamePlateauT: Float32Array;
  flameHoldS: Float32Array;
}

export interface RefSimParams {
  net: ThermalNetwork;
  cells: RefCellParams;
  ambientT: number;
  inletT: number;
  stoppedBranches: Set<number>;
  /** 强制触发电芯:cellIndex -> 时刻 s */
  forceTriggers: Map<number, number>;
  nozzles: NozzleSpec[];
  /** 灭火剂实际喷放时刻 s(null=不喷) */
  dischargeTime: number | null;
  cellPositions: Float32Array;
  duration: number;
  /** 每 fixedDt 记录一次全量温度(测试用) */
  recordEvery?: number;
  /** 节点初温(默认全部 ambientT) */
  initialT?: Float32Array;
  /** 固定温度电芯索引->温度 K(Dirichlet 边界,测试/外部恒温源用) */
  fixedCells?: Map<number, number>;
  onTR?: (cell: number, t: number) => void;
}

export interface RefResult {
  trOrder: { cell: number; t: number }[];
  finalT: Float32Array;
  maxT: number;
  steps: number;
  dt: number;
  trajectory: { t: number; T: Float32Array; state: Uint8Array }[];
}

export function runReferenceSim(p: RefSimParams): RefResult {
  const { net } = p;
  const { N, M, cellsPerModule, cellsX, cellsZ } = net;
  const dt = net.dtCrit;
  const state = new Uint8Array(N);
  const trTime = new Float32Array(N).fill(NaN);
  let T = new Float32Array(N + 3 * M).fill(p.ambientT);
  if (p.initialT) T.set(p.initialT.subarray(0, T.length));
  let Tn = new Float32Array(T.length);
  if (p.fixedCells) for (const [i, v] of p.fixedCells) T[i] = v;
  const fluidIdx = (m: number) => N + 2 * M + m;
  const shellIdx = (m: number) => N + M + m;
  const plateIdx = (m: number) => N + m;
  const kEffGlobal = net.gxEffK;
  const trajectory: { t: number; T: Float32Array; state: Uint8Array }[] = [];
  const trOrder: { cell: number; t: number }[] = [];

  const pairGX = (i: number, j: number): number => {
    const ki = Number.isFinite(net.cellContactK[i]) ? net.cellContactK[i] : kEffGlobal;
    const kj = Number.isFinite(net.cellContactK[j]) ? net.cellContactK[j] : kEffGlobal;
    const r = net.gxGap * (1 / (2 * ki) + 1 / (2 * kj));
    return net.faceAreaX / r;
  };

  const steps = Math.ceil(p.duration / dt);
  for (let step = 0; step < steps; step++) {
    const t = step * dt;
    Tn.set(T);
    // 先串行更新各支路工质温度(按冷板顺序),结果写入 Tn 流体节点
    const seenFluid = new Set<number>();
    for (let b = 0; b < net.branchCount; b++) {
      const stopped = p.stoppedBranches.has(b);
      let tUp = p.inletT;
      for (let s = 0; s < net.platesPerBranch; s++) {
        const m = b * net.platesPerBranch + s;
        const fi = fluidIdx(m);
        let tFluid: number;
        if (stopped) {
          const gNat = 5 * 0.5; // 停滞工质自然对流 W/K(量级近似)
          tFluid = (gNat * T[plateIdx(m)] + 0.5 * p.inletT) / (gNat + 0.5);
        } else {
          const gp = net.gPlateFluid;
          tFluid = (net.mDotCp * tUp + gp * T[plateIdx(m)]) / (net.mDotCp + gp);
          tUp = tFluid;
        }
        Tn[fi] = tFluid;
        seenFluid.add(fi);
      }
    }
    // 电芯节点
    for (let i = 0; i < N; i++) {
      const fixed = p.fixedCells?.get(i);
      if (fixed !== undefined) { Tn[i] = fixed; continue; }
      const m = Math.floor(i / cellsPerModule);
      const local = i - m * cellsPerModule;
      let q = 0;
      const rad = (j: number, coeff: number) => {
        if (!net.enableRadiation) return 0;
        let th: number;
        if (state[j] === CellState.Venting) th = p.cells.flamePlateauT[j];
        else if (state[j] === CellState.Spent) {
          const pv = postVentTemp(p.cells.flamePlateauT[j], p.cells.flameHoldS[j], t - trTime[j], p.cells.ventDuration[j]);
          th = Number.isNaN(pv) ? T[j] : pv;
        } else return 0;
        return coeff * (th ** 4 - T[i] ** 4);
      };
      // x 向相邻
      if (local % cellsX > 0) { const j = i - 1; q += pairGX(i, j) * (T[j] - T[i]) + rad(j, net.radCoeffX); }
      if (local % cellsX < cellsX - 1) { const j = i + 1; q += pairGX(i, j) * (T[j] - T[i]) + rad(j, net.radCoeffX); }
      // z 向相邻
      if (local >= cellsX) { const j = i - cellsX; q += net.gCellPairZ * (T[j] - T[i]) + rad(j, net.radCoeffZ); }
      if (local < cellsPerModule - cellsX) { const j = i + cellsX; q += net.gCellPairZ * (T[j] - T[i]) + rad(j, net.radCoeffZ); }
      // 外壳 / 冷板
      q += net.gCellShell * (T[shellIdx(m)] - T[i]);
      q += net.gCellPlate * (T[plateIdx(m)] - T[i]);
      // 内部热源
      if (state[i] === CellState.Normal || state[i] === CellState.SelfHeating) {
        q += selfHeatPower(p.cells.chemistry, T[i], p.cells.mass[i], p.cells.selfStartT[i]);
      } else if (state[i] === CellState.Venting) {
        q += trVentPower(p.cells.trHeatTotal[i], p.cells.ventDuration[i], t - trTime[i]);
      }
      // 灭火剂降温(按设定 K/s)
      if (p.dischargeTime !== null && t >= p.dischargeTime) {
        const px = p.cellPositions[i * 3], py = p.cellPositions[i * 3 + 1], pz = p.cellPositions[i * 3 + 2];
        for (const nz of p.nozzles) {
          const d2 = (nz.x - px) ** 2 + (nz.y - py) ** 2 + (nz.z - pz) ** 2;
          if (d2 <= nz.radius ** 2) { q -= net.cellC[i] * nz.coolingRate; break; }
        }
      }
      Tn[i] = T[i] + (q / net.cellC[i]) * dt;
      // 喷发后平台温度约束(下限钳制)
      if (state[i] === CellState.Venting) Tn[i] = Math.max(Tn[i], p.cells.flamePlateauT[i]);
      if (state[i] === CellState.Spent) {
        const pv = postVentTemp(p.cells.flamePlateauT[i], p.cells.flameHoldS[i], t - trTime[i], p.cells.ventDuration[i]);
        if (!Number.isNaN(pv)) Tn[i] = Math.max(Tn[i], pv);
      }
      // 状态机(与 WGSL cellPass 同构):强制/温升触发仅在 Normal/SelfHeating 态生效,
      // 避免恒真的强制条件挡住 Venting->Spent 转换
      const force = p.forceTriggers.get(i);
      const doTrigger = (force !== undefined && t >= force) ||
        (state[i] <= CellState.SelfHeating && Tn[i] >= p.cells.trTriggerT[i]);
      if (doTrigger && state[i] <= CellState.SelfHeating) {
        state[i] = CellState.Venting;
        trTime[i] = t;
        trOrder.push({ cell: i, t });
        p.onTR?.(i, t);
      } else if (state[i] === CellState.Venting && t - trTime[i] >= p.cells.ventDuration[i]) {
        state[i] = CellState.Spent;
      } else if (state[i] === CellState.Normal && Tn[i] >= p.cells.selfStartT[i]) {
        state[i] = CellState.SelfHeating;
      }
    }
    // 外壳节点
    for (let m = 0; m < M; m++) {
      let q = net.gShellAmb[m] * (p.ambientT - T[shellIdx(m)]);
      const base = m * cellsPerModule;
      for (let k = 0; k < cellsPerModule; k++) q += net.gCellShell * (T[base + k] - T[shellIdx(m)]);
      Tn[shellIdx(m)] = T[shellIdx(m)] + (q / net.shellC[m]) * dt;
    }
    // 冷板节点
    for (let m = 0; m < M; m++) {
      let q = net.gPlateFluid * (Tn[fluidIdx(m)] - T[plateIdx(m)]);
      const base = m * cellsPerModule;
      for (let k = 0; k < cellsPerModule; k++) q += net.gCellPlate * (T[base + k] - T[plateIdx(m)]);
      Tn[plateIdx(m)] = T[plateIdx(m)] + (q / net.plateC[m]) * dt;
    }
    [T, Tn] = [Tn, T];
    if (p.fixedCells) for (const [i, v] of p.fixedCells) T[i] = v;
    if (p.recordEvery && step % Math.max(1, Math.round(p.recordEvery / dt)) === 0) {
      trajectory.push({ t, T: T.slice(0, N), state: state.slice() });
    }
    if (T.some((v) => !Number.isFinite(v) || v > 1500)) {
      return { trOrder, finalT: T, maxT: NaN, steps: step + 1, dt, trajectory };
    }
  }
  let maxT = 0;
  for (let i = 0; i < N; i++) maxT = Math.max(maxT, T[i]);
  return { trOrder, finalT: T.slice(0, N), maxT, steps, dt, trajectory };
}
