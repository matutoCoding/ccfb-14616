// 热网络求解内核：对任意 Topology（含手算校验用的 3 节点小拓扑）通用
// CPU 参照解，公式与 WGSL compute.wgsl 逐式对应
import type { ChemSpec, ProjectConfig, RunawayEvent, RunawayState, TriggerPoint } from '../model/types';
import type { Topology } from '../model/topology';
import { selfHeatPower, runawayStep, stableDt, clampToPeak } from './formulas';

export interface CoreOptions {
  endTime: number;
  maxDt: number;
  snapshotInterval: number;
  ambientTemp: number;
  chem: ChemSpec;
  triggers: TriggerPoint[];
  coolingEnabled: boolean;
  suppression: ProjectConfig['suppression'] | null;
  inletTemp: number;
  onProgress?: (t: number, dt: number, runaway: number) => void;
  chunkSimSeconds?: number;
  signal?: { cancelled: boolean };
  /** 喷放时刻由外部（探测器模型）先算好传入；<0 不喷放 */
  dischargeTime?: number;
  /** 泵故障支路与时刻（与 ProjectConfig.cooling 对应） */
  failedBranches?: number[];
  pumpFailTime?: number;
  /** 喷发期热库钳温温度，<=0 表示关闭（手算校验场景必须关闭） */
  peakTemp?: number;
}

export interface CoreResult {
  times: number[];
  tempFrames: number[][];
  stateFrames: number[][];
  events: RunawayEvent[];
  dischargeTime: number;
  endTime: number;
  steps: number;
  finalTemp: Float64Array;
  finalState: Uint8Array;
}

export class ThermalCore {
  private topo: Topology;
  private n: number;
  private temp: Float64Array;
  private state: Uint8Array;
  private energy: Float64Array;
  private vent: Float64Array;
  private shellTemp: Float64Array;
  private rackHeatAcc: Float64Array;
  private rackRise: Float64Array;
  private t = 0;
  private steps = 0;
  events: RunawayEvent[] = [];

  constructor(topo: Topology, initialTemp: number) {
    this.topo = topo;
    this.n = topo.cellCount;
    this.temp = new Float64Array(this.n).fill(initialTemp);
    this.state = new Uint8Array(this.n);
    this.energy = new Float64Array(this.n);
    this.vent = new Float64Array(this.n);
    this.shellTemp = new Float64Array(topo.moduleCount).fill(initialTemp);
    this.rackHeatAcc = new Float64Array(topo.rackCount);
    this.rackRise = new Float64Array(topo.rackCount);
  }

  get time() { return this.t; }
  get temperatures() { return this.temp; }
  get states() { return this.state; }

  step(opts: CoreOptions): number {
    const { topo } = this;
    const n = this.n;
    const chem = opts.chem;

    // 全局最小稳定步长（先算 dt，触发窗口判定要用）
    let dt = opts.maxDt;
    for (let i = 0; i < n; i++) {
      const gSum = 2 * (topo.gx[i] + topo.gy[i]) + topo.gShell[i] +
        (opts.coolingEnabled ? topo.gCold[i] : 0);
      dt = Math.min(dt, stableDt(topo.cap[i], gSum));
    }
    dt = Math.max(dt, 1e-4);

    const extPower = new Map<number, number>();
    const forcedNow = new Set<number>();
    for (const tr of opts.triggers) {
      // 瞬时型（duration=0）：落在该时刻所在的一个步长窗口内即强制触发
      if (tr.duration === 0 && this.t < tr.time && this.t + dt >= tr.time) {
        forcedNow.add(tr.cellIndex);
      }
      if (tr.duration > 0 && this.t >= tr.time && this.t < tr.time + tr.duration) {
        extPower.set(tr.cellIndex, (extPower.get(tr.cellIndex) ?? 0) + tr.power);
      }
    }

    // 液冷支路温升（显式）
    const coldTemp = new Float64Array(topo.moduleCount);
    if (opts.coolingEnabled) {
      const failed = new Set(
        this.t >= (opts.pumpFailTime ?? Infinity) ? (opts.failedBranches ?? []) : [],
      );
      // 每簇流量（kg/s·J 口径）；故障支路 mdotCp=0
      for (let r = 0; r < topo.rackCount; r++) {
        const mdot = failed.has(r) ? 0 : this._mdotCp[r];
        const rise = mdot > 0 ? this.rackHeatAcc[r] / mdot : 0;
        this.rackRise[r] = Math.min(Math.max(rise, 0), 150);
      }
      for (let m = 0; m < topo.moduleCount; m++) {
        const r = topo.moduleRack[m];
        const frac = ((m % topo.modulesPerRack) + 0.5) / Math.max(topo.modulesPerRack, 1);
        coldTemp[m] = opts.inletTemp + frac * this.rackRise[r];
      }
    }
    this.rackHeatAcc.fill(0);

    const sup = opts.suppression;
    const dTime = opts.dischargeTime ?? -1;
    const supActive = !!sup && sup.enabled && dTime >= 0 &&
      this.t >= dTime && this.t < dTime + sup.duration;

    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const T = this.temp[i];
      const nb = topo.neighbor;
      let q = 0;
      const i0 = nb[4 * i], i1 = nb[4 * i + 1], i2 = nb[4 * i + 2], i3 = nb[4 * i + 3];
      if (i0 >= 0) q += topo.gx[i] * (this.temp[i0] - T);
      if (i1 >= 0) q += topo.gx[i] * (this.temp[i1] - T);
      if (i2 >= 0) q += topo.gy[i] * (this.temp[i2] - T);
      if (i3 >= 0) q += topo.gy[i] * (this.temp[i3] - T);
      if (topo.gShell[i] > 0) {
        q += topo.gShell[i] * (this.shellTemp[topo.shellNode[i] - n] - T);
      }
      if (opts.coolingEnabled && topo.gCold[i] > 0) {
        const rackFailed = (opts.failedBranches ?? []).includes(topo.rackId[i]) &&
          this.t >= (opts.pumpFailTime ?? Infinity);
        if (!rackFailed) {
          const qc = topo.gCold[i] * (coldTemp[topo.moduleId[i]] - T);
          q += qc;
          this.rackHeatAcc[topo.rackId[i]] += -qc;
        }
      }
      let qGen = 0;
      if (this.state[i] < 2) qGen = selfHeatPower(chem, T);
      const rs = runawayStep(
        this.state[i] as RunawayState, T, chem.tOnset, chem.tTrigger,
        forcedNow.has(i), this.energy[i], chem.runawayEnergy, chem.ventDuration, this.vent[i], dt,
      );
      qGen += rs.qRunaway + (extPower.get(i) ?? 0);
      if (rs.triggeredNow) {
        this.events.push({
          cellIndex: i, time: this.t + dt, moduleId: topo.moduleId[i], rackId: topo.rackId[i],
          cause: (extPower.has(i) || forcedNow.has(i)) ? 'trigger' : `prop:${this.findCause(i)}`,
        });
      }
      this.state[i] = rs.state;
      this.vent[i] = rs.ventTimer;
      this.energy[i] += rs.qRunaway * dt;
      if (supActive) q -= sup!.coolRate * topo.cap[i];

      let nT = T + dt * (q + qGen) / topo.cap[i];
      // 喷发期热库钳温（试验观测峰值等效，校验场景关闭）
      if ((opts.peakTemp ?? 0) > 0) {
        nT = clampToPeak(nT, rs.state as RunawayState, opts.peakTemp!, dt);
      }
      next[i] = Math.min(1500, Math.max(opts.ambientTemp, nT));
    }

    const nextShell = new Float64Array(topo.moduleCount);
    for (let m = 0; m < topo.moduleCount; m++) {
      const Ts = this.shellTemp[m];
      let q = topo.shellGAmbient[m] * (opts.ambientTemp - Ts);
      if (m > 0 && topo.moduleRack[m - 1] === topo.moduleRack[m]) {
        q += topo.shellGNext[m - 1] * (this.shellTemp[m - 1] - Ts);
      }
      if (m < topo.moduleCount - 1 && topo.moduleRack[m + 1] === topo.moduleRack[m]) {
        q += topo.shellGNext[m] * (this.shellTemp[m + 1] - Ts);
      }
      nextShell[m] = Math.min(1200, Math.max(opts.ambientTemp, Ts + dt * q / topo.shellCap[m]));
    }

    this.temp.set(next);
    this.shellTemp.set(nextShell);
    this.t += dt;
    this.steps += 1;
    return dt;
  }

  private _mdotCp = new Float64Array(0);
  setFlowPerRack(vals: number[]) {
    this._mdotCp = Float64Array.from(vals);
  }

  private findCause(cell: number): number {
    const nb = this.topo.neighbor;
    for (let k = 0; k < 4; k++) {
      const j = nb[4 * cell + k];
      if (j >= 0 && this.state[j] >= 2) return j;
    }
    return -1;
  }

  async run(opts: CoreOptions): Promise<CoreResult> {
    const times: number[] = [0];
    const tempFrames: number[][] = [Array.from(this.temp)];
    const stateFrames: number[][] = [Array.from(this.state)];
    let nextSnapshot = opts.snapshotInterval;
    const chunkBudget = opts.chunkSimSeconds ?? 20;
    let chunkStart = 0;
    let lastDt = opts.maxDt;

    while (this.t < opts.endTime - 1e-9) {
      if (opts.signal?.cancelled) break;
      lastDt = this.step(opts);
      if (this.t >= nextSnapshot - 1e-9 || this.t >= opts.endTime - 1e-9) {
        times.push(Math.min(this.t, opts.endTime));
        tempFrames.push(Array.from(this.temp));
        stateFrames.push(Array.from(this.state));
        nextSnapshot += opts.snapshotInterval;
      }
      opts.onProgress?.(this.t, lastDt, this.events.length);
      if (this.t - chunkStart >= chunkBudget) {
        chunkStart = this.t;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return {
      times, tempFrames, stateFrames, events: this.events,
      dischargeTime: opts.dischargeTime ?? -1,
      endTime: this.t, steps: this.steps,
      finalTemp: this.temp.slice(), finalState: this.state.slice(),
    };
  }
}
