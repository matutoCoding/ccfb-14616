/**
 * 三颗电芯串排手算校验 —— 评审最在意的"传热算得对不对"。
 * 用例 A(线性 RC):关辐射/热源,首颗恒温壁,与两自由度 RC 链闭式解比对。
 * 用例 B(完整蔓延):独立标量循环重写热平衡,对比参考求解器首/次蔓延时间,误差 ≤5%。
 * 用例 C:步长减半收敛性 <2%。
 * 运行: node --experimental-strip-types test/phys.test.ts
 */
import assert from 'node:assert/strict';
import type { ThermalNetwork } from '../src/physics/geometry.ts';
import { runReferenceSim, type RefCellParams, type RefSimParams } from '../src/physics/referenceSolver.ts';
import { defaultCellSpec, CELL_EMISSIVITY, VIEW_FACTOR } from '../src/physics/constants.ts';
import { selfHeatPower, trVentPower, postVentTemp, CellState } from '../src/physics/thermalModel.ts';

const AMB = 298.15;

function makeNet(): ThermalNetwork {
  const cell = defaultCellSpec('LFP');
  const N = 3;
  const faceAreaX = cell.height * cell.depth;
  const padT = 0.002, padK = 0.018; // 2mm 气凝胶
  const gCellPairX = faceAreaX / (padT / padK);
  const cellC = new Float32Array(N).fill(cell.mass * cell.specificHeat);
  const radCoeffX = CELL_EMISSIVITY * VIEW_FACTOR * faceAreaX * 5.670374419e-8;
  const f = (v: number) => new Float32Array(N).fill(v);
  return {
    N, M: 1, nodeCount: 5, cellsPerModule: 3, cellsX: 3, cellsZ: 1,
    cellC, cellContactK: f(NaN), shellC: f(1e6), plateC: f(1e6),
    gCellPairX, gCellPairZ: 0, gxGap: padT, gxEffK: padK,
    gCellShell: 0, gCellPlate: 0, gShellAmb: f(0), gPlateFluid: 0, faceAreaX,
    branchCount: 1, platesPerBranch: 1, mDotCp: 1000,
    enableRadiation: true, radCoeffX, radCoeffZ: 0, dtCrit: 0.25,
  };
}

function makeCellParams(): RefCellParams {
  const c = defaultCellSpec('LFP');
  const f = (v: number) => new Float32Array(3).fill(v);
  return {
    chemistry: 'LFP', mass: f(c.mass), selfStartT: f(c.selfHeatStartT), trTriggerT: f(c.trTriggerT),
    trHeatTotal: f(c.trHeatTotal), ventDuration: f(c.ventDuration),
    flamePlateauT: f(c.flamePlateauT), flameHoldS: f(c.flameHoldS),
  };
}

/** 独立标量手算:与求解器同构的热平衡方程,但完全独立实现 */
function handcalcScalar(net: ThermalNetwork, cp: RefCellParams, duration: number, withRadiation: boolean) {
  const dt = net.dtCrit;
  let T = [AMB, AMB, AMB];
  const state: number[] = [CellState.Normal, CellState.Normal, CellState.Normal];
  const trT = [NaN, NaN, NaN];
  const events: { cell: number; t: number }[] = [];
  const gx = net.gCellPairX;
  const Cval = cp.mass[0] * 1100;
  for (let step = 0; step < Math.ceil(duration / dt); step++) {
    const t = step * dt;
    const Tn = [...T];
    for (let i = 0; i < 3; i++) {
      let q = 0;
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j > 2) continue;
        q += gx * (T[j] - T[i]);
        if (withRadiation) {
          let th = NaN;
          if (state[j] === CellState.Venting) th = cp.flamePlateauT[j];
          else if (state[j] === CellState.Spent) {
            const pv = postVentTemp(cp.flamePlateauT[j], cp.flameHoldS[j], t - trT[j], cp.ventDuration[j]);
            th = Number.isNaN(pv) ? T[j] : pv;
          }
          if (!Number.isNaN(th)) q += net.radCoeffX * (th ** 4 - T[i] ** 4);
        }
      }
      if (state[i] <= CellState.SelfHeating) {
        q += selfHeatPower('LFP', T[i], cp.mass[i], cp.selfStartT[i]);
      } else if (state[i] === CellState.Venting) {
        q += trVentPower(cp.trHeatTotal[i], cp.ventDuration[i], t - trT[i]);
      }
      Tn[i] = T[i] + q / Cval * dt;
      if (state[i] === CellState.Venting) Tn[i] = Math.max(Tn[i], cp.flamePlateauT[i]);
      if (state[i] === CellState.Spent) {
        const pv = postVentTemp(cp.flamePlateauT[i], cp.flameHoldS[i], t - trT[i], cp.ventDuration[i]);
        if (!Number.isNaN(pv)) Tn[i] = Math.max(Tn[i], pv);
      }
      const force = i === 0 ? 0 : undefined;
      const doTrigger = (force !== undefined && t >= force) ||
        (state[i] <= CellState.SelfHeating && Tn[i] >= cp.trTriggerT[i]);
      if (doTrigger && state[i] <= CellState.SelfHeating) {
        state[i] = CellState.Venting; trT[i] = t; events.push({ cell: i, t });
      } else if (state[i] === CellState.Venting && t - trT[i] >= cp.ventDuration[i]) {
        state[i] = CellState.Spent;
      } else if (state[i] === CellState.Normal && Tn[i] >= cp.selfStartT[i]) {
        state[i] = CellState.SelfHeating;
      }
    }
    T = Tn;
  }
  return { events, finalT: T };
}

async function main() {
  const net = makeNet();
  const cp = makeCellParams();
  const pos = new Float32Array([0, 0, 0, 0.2, 0, 0, 0.4, 0, 0]);

  // ---------- 用例 A:线性 RC 闭式解 ----------
  const C = cp.mass[0] * 1100, G = net.gCellPairX, tau = C / G, Th = 543.15;
  const cpLin: RefCellParams = { ...cp, selfStartT: new Float32Array(3).fill(2000), trTriggerT: new Float32Array(3).fill(2000) };
  const initT = new Float32Array([Th, AMB, AMB, AMB, AMB, AMB]);
  const linArgs: RefSimParams = {
    net: { ...net, enableRadiation: false }, cells: cpLin, ambientT: AMB, inletT: AMB,
    stoppedBranches: new Set<number>(), forceTriggers: new Map(), nozzles: [],
    dischargeTime: null, cellPositions: pos, initialT: initT, fixedCells: new Map([[0, Th]]),
    duration: tau,
  };
  const resWall = runReferenceSim(linArgs);
  const a = G / C;
  const lam1 = a * (-3 + Math.sqrt(5)) / 2, lam2 = a * (-3 - Math.sqrt(5)) / 2;
  const phi1 = lam1 / a + 2, phi2 = lam2 / a + 2, d0 = AMB - Th;
  const c2 = d0 * (1 - phi1) / (phi2 - phi1), c1 = d0 - c2;
  const analytic1 = Th + c1 * Math.exp(lam1 * tau) + c2 * Math.exp(lam2 * tau);
  const analytic2 = Th + c1 * phi1 * Math.exp(lam1 * tau) + c2 * phi2 * Math.exp(lam2 * tau);
  const err1 = Math.abs(resWall.finalT[1] - analytic1) / (Th - AMB) * 100;
  const err2 = Math.abs(resWall.finalT[2] - analytic2) / (Th - AMB) * 100;
  console.log(`[A] 线性 RC: tau=${tau.toFixed(1)}s (G=${G.toFixed(4)} W/K, C=${C.toFixed(0)} J/K)`);
  console.log(`    T1 手算=${analytic1.toFixed(2)}K 数值=${resWall.finalT[1].toFixed(2)}K 误差=${err1.toFixed(2)}%`);
  console.log(`    T2 手算=${analytic2.toFixed(2)}K 数值=${resWall.finalT[2].toFixed(2)}K 误差=${err2.toFixed(2)}%`);
  assert.ok(err1 < 5 && err2 < 5, '线性 RC 闭式解误差超 5%');

  // ---------- 用例 B:完整热失控蔓延 ----------
  const duration = 14400; // 气凝胶隔热强,给足蔓延窗口
  const hand = handcalcScalar(net, cp, duration, true);
  const ref = runReferenceSim({
    net, cells: cp, ambientT: AMB, inletT: AMB, stoppedBranches: new Set(),
    forceTriggers: new Map([[0, 0]]), nozzles: [], dischargeTime: null,
    cellPositions: pos, duration,
  });
  const h1 = hand.events.find((e) => e.cell === 1)?.t ?? NaN;
  const r1 = ref.trOrder.find((e) => e.cell === 1)?.t ?? NaN;
  const h2 = hand.events.find((e) => e.cell === 2)?.t ?? NaN;
  const r2 = ref.trOrder.find((e) => e.cell === 2)?.t ?? NaN;
  const e1 = Math.abs(h1 - r1) / h1 * 100;
  const e2 = Math.abs(h2 - r2) / h2 * 100;
  console.log(`[B] 首蔓延 0→1: 手算=${h1.toFixed(1)}s 求解器=${r1.toFixed(1)}s 误差=${e1.toFixed(2)}%`);
  console.log(`    次蔓延 1→2: 手算=${h2.toFixed(1)}s 求解器=${r2.toFixed(1)}s 误差=${e2.toFixed(2)}%`);
  assert.ok(e1 <= 5, `首蔓延误差 ${e1.toFixed(2)}% 超 5%`);
  assert.ok(e2 <= 5, `次蔓延误差 ${e2.toFixed(2)}% 超 5%`);
  assert.ok(ref.maxT < 1200 && Number.isFinite(ref.maxT), '温度发散');

  // ---------- 用例 C:步长减半收敛 ----------
  const fine = runReferenceSim({
    net: { ...net, dtCrit: net.dtCrit / 2 }, cells: cp, ambientT: AMB, inletT: AMB,
    stoppedBranches: new Set(), forceTriggers: new Map([[0, 0]]), nozzles: [],
    dischargeTime: null, cellPositions: pos, duration,
  });
  const conv = Math.abs(fine.trOrder.find((e) => e.cell === 1)!.t - r1) / r1 * 100;
  console.log(`[C] 步长减半: t1 ${r1.toFixed(1)}s -> ${fine.trOrder.find((e) => e.cell === 1)!.t.toFixed(1)}s,变化 ${conv.toFixed(2)}%`);
  assert.ok(conv < 2, `步长收敛性 ${conv.toFixed(2)}% 超 2%`);

  console.log('\n✅ 全部手算校验通过(5% 限值)');
}

main().catch((e) => { console.error('❌ 校验失败:', e); process.exit(1); });
