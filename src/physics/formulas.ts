// 物理公式单一事实源：CPU 参照解与 WGSL 计算着色器必须按同一组公式实现
// 所有温度 K，时间 s，能量 J
import type { ChemSpec, RunawayState } from '../model/types';

/** 分段线性插值自产热功率 W（表外按端点恒定） */
export function selfHeatPower(chem: ChemSpec, t: number): number {
  const tab = chem.selfHeatTable;
  if (t <= tab[0].t) return tab[0].power;
  for (let i = 1; i < tab.length; i++) {
    if (t <= tab[i].t) {
      const a = tab[i - 1], b = tab[i];
      const f = (t - a.t) / (b.t - a.t);
      return a.power + f * (b.power - a.power);
    }
  }
  return tab[tab.length - 1].power;
}

/**
 * 热失控状态机推进
 * state: 0 正常 / 1 自产热 / 2 失控喷发中 / 3 喷发结束
 * 返回新状态与本步释放功率 Qdot (W)
 */
export function runawayStep(
  state: RunawayState,
  temp: number,
  tOnset: number,
  tTrigger: number,
  externalForce: boolean,     // 外部触发（过充/针刺/加热板到点）
  energyReleased: number,     // 已释放能量 J
  runawayEnergy: number,
  ventDuration: number,       // 喷发总时长 s
  ventTimer: number,          // 喷发剩余时间 s
  dt: number,
): { state: RunawayState; qRunaway: number; ventTimer: number; triggeredNow: boolean } {
  let s = state;
  let triggeredNow = false;
  let q = 0;
  let timer = ventTimer;

  if (s === 0) {
    if (temp >= tOnset) s = 1;
  }
  if (s === 0 && externalForce) {
    // 针刺/过充等强制触发可直接引燃，无需等待自产热
    s = 2;
    triggeredNow = true;
    timer = ventDuration;
  }
  if (s === 1) {
    if (temp >= tTrigger || externalForce) {
      s = 2;
      triggeredNow = true;
      timer = ventDuration;
    }
  }
  if (s === 2) {
    // 喷发期：总能量按喷发时长均布释放（工程上常用的等效矩形释热曲线）
    q = runawayEnergy / Math.max(ventDuration, 1e-6);
    timer -= dt;
    if (timer <= 0 || energyReleased + q * dt >= runawayEnergy) {
      s = 3;
      timer = 0;
    }
  }
  // state 3：燃料耗尽，仅参与导热，不再产热
  return { state: s, qRunaway: q, ventTimer: timer, triggeredNow };
}

/**
 * 喷发期热库钳温：state==2 时把电芯温度向观测峰值温度做一阶弛豫
 * 工程等效——燃烧/喷焰的外部加热使芯体维持在试验观测峰值，而非仅靠电化学自热
 * 弛豫时间常数取 2s（喷发建立时间量级），能量口径仅用于状态机记录，不参与守恒校验
 */
export function clampToPeak(temp: number, state: RunawayState, peakTemp: number, dt: number): number {
  if (state !== 2) return temp;
  const tau = 2;
  const alpha = 1 - Math.exp(-dt / tau);
  return temp + alpha * (peakTemp - temp);
}

/** 显式欧拉稳定性步长：dt <= 0.25 · C / ΣG（系数 0.25 留安全裕度，Fourier 数准则） */
export function stableDt(cap: number, gSum: number, capCoolRate = 0): number {
  const denom = gSum + Math.max(capCoolRate, 0);
  if (denom <= 0) return 4;
  return 0.25 * cap / denom;
}

/** 喷放降温作用：返回对单芯的等效额外热容流 W（coolRate K/s × C） */
export function suppressionPower(coolRate: number, cap: number, active: boolean): number {
  return active ? coolRate * cap : 0;
}
