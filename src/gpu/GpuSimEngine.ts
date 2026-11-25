import type { ProjectConfig, SimResult, SimSummary, SnapshotMeta, BuildResult } from '../types';
import { buildLayout, buildNetwork } from '../physics/geometry';
import { runReferenceSim, type RefCellParams } from '../physics/referenceSolver';
import { SELF_HEAT_TABLE, dequantizeT } from '../physics/thermalModel';
import { validateConfig, hasError } from '../physics/validation';

function buildCellParams(cfg: ProjectConfig, N: number): RefCellParams {
  const f = () => new Float32Array(N);
  const mass = f(), selfStartT = f(), trTriggerT = f(), trHeatTotal = f();
  const ventDuration = f(), flamePlateauT = f(), flameHoldS = f();
  for (let i = 0; i < N; i++) {
    const s = { ...cfg.cell, ...(cfg.cellOverrides[i] ?? {}) };
    mass[i] = s.mass; selfStartT[i] = s.selfHeatStartT; trTriggerT[i] = s.trTriggerT;
    trHeatTotal[i] = s.trHeatTotal; ventDuration[i] = s.ventDuration;
    flamePlateauT[i] = s.flamePlateauT; flameHoldS[i] = s.flameHoldS;
  }
  return { chemistry: cfg.cell.chemistry, mass, selfStartT, trTriggerT, trHeatTotal, ventDuration, flamePlateauT, flameHoldS };
}

/** 探测器分区模型:喷发气体在本分区累积,按阈值+距离衰减估算报警时刻 */
export function computeDetectorAlarms(cfg: ProjectConfig, layout: BuildResult, trOrder: { cell: number; t: number }[]) {
  const alarms: SimSummary['detectorAlarms'] = [];
  const roomZ = layout.roomSize.z;
  const zoneOf = (z: number) => Math.min(2, Math.max(0, Math.floor(z / (roomZ / 3))));
  const zoneGas = [0, 0, 0], zoneSmoke = [0, 0, 0];
  const fired = new Set<string>();
  const zoneVolume = layout.roomSize.x * layout.roomSize.y * (roomZ / 3);
  const maxTByZone = [0, 0, 0];
  for (const ev of trOrder) {
    const spec = { ...cfg.cell, ...(cfg.cellOverrides[ev.cell] ?? {}) };
    const px = layout.cellPositions[ev.cell * 3];
    const py = layout.cellPositions[ev.cell * 3 + 1];
    const z = layout.cellPositions[ev.cell * 3 + 2];
    const zId = zoneOf(z);
    zoneGas[zId] += spec.ventGasMol;
    zoneSmoke[zId] += spec.ventGasMol * 0.15;
    maxTByZone[zId] = Math.max(maxTByZone[zId], spec.flamePlateauT);
    const concentration = zoneGas[zId] / zoneVolume;
    const smoke = zoneSmoke[zId] / zoneVolume;
    for (const d of cfg.detectors) {
      if (fired.has(d.id) || zoneOf(d.z) !== zId) continue;
      const dist = Math.hypot(px - d.x, py - d.y);
      const distFactor = Math.exp(-dist / 6);
      const hit =
        (d.kind === 'gas' && concentration * distFactor >= d.threshold) ||
        (d.kind === 'smoke' && smoke * distFactor >= d.threshold) ||
        (d.kind === 'temp' && maxTByZone[zId] >= d.threshold);
      if (hit) {
        alarms.push({ detectorId: d.id, kind: d.kind, t: ev.t + spec.ventDuration * 0.3 });
        fired.add(d.id);
      }
    }
  }
  return alarms.sort((a, b) => a.t - b.t);
}

function makeSummary(cfg: ProjectConfig, layout: BuildResult, trOrder: { cell: number; t: number }[],
  extra: Partial<SimSummary>, finalT: Float32Array, alarms: SimSummary['detectorAlarms']): SimResult {
  const firstProp = trOrder.length >= 2 ? trOrder[1].t - trOrder[0].t : null;
  const dischargeTime = alarms.length && cfg.nozzles.length ? alarms[0].t + cfg.nozzles[0].dischargeDelay : null;
  let maxT = 0;
  for (let i = 0; i < layout.cellCount; i++) maxT = Math.max(maxT, finalT[i] ?? 0);
  return {
    projectId: cfg.id, runAt: Date.now(),
    summary: {
      physicalTime: cfg.simDuration, wallTimeMs: 0, steps: 0, finalDt: 0,
      trCount: trOrder.length, firstPropagationTime: firstProp,
      trOrder: trOrder.map((e) => ({ ...e, module: layout.cellModule[e.cell] })),
      detectorAlarms: alarms, dischargeTime, maxT, diverged: false, ...extra,
    },
    snapshots: [], snapshotInterval: 4,
    propagationLinks: trOrder.slice(1).map((e, k) => ({ from: trOrder[k].cell, to: e.cell, t: e.t })),
  };
}

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export async function runSimulation(cfg: ProjectConfig, onProgress?: (pct: number) => void): Promise<SimResult> {
  const issues = validateConfig(cfg);
  if (hasError(issues)) throw new Error('参数校验未通过: ' + issues.filter((i) => i.level === 'error').map((i) => i.message).join('; '));
  if (!isWebGpuAvailable()) {
    console.warn('[sim] WebGPU 不可用,回退 CPU 参考求解器');
    return runCpuSim(cfg, onProgress);
  }
  try {
    return await runGpuSim(cfg, onProgress);
  } catch (e) {
    console.error('[sim] GPU 求解失败,回退 CPU:', e);
    return runCpuSim(cfg, onProgress);
  }
}

export async function runCpuSim(cfg: ProjectConfig, onProgress?: (pct: number) => void): Promise<SimResult> {
  const layout = buildLayout(cfg);
  const net = buildNetwork(cfg, layout);
  const cp = buildCellParams(cfg, layout.cellCount);
  const interval = 4;
  const t0 = performance.now();
  const ref = runReferenceSim({
    net, cells: cp, ambientT: cfg.hvac.ambientT, inletT: cfg.cooling.inletTemp,
    stoppedBranches: new Set(cfg.cooling.stoppedBranches),
    forceTriggers: new Map(cfg.triggers.map((t) => [t.cellGlobalIndex, t.time])),
    nozzles: cfg.nozzles, dischargeTime: null,
    cellPositions: layout.cellPositions, duration: cfg.simDuration, recordEvery: interval,
  });
  const alarms = computeDetectorAlarms(cfg, layout, ref.trOrder);
  const result = makeSummary(cfg, layout, ref.trOrder, {
    wallTimeMs: performance.now() - t0, steps: ref.steps, finalDt: ref.dt, diverged: Number.isNaN(ref.maxT),
  }, ref.finalT, alarms);
  result.snapshots = ref.trajectory.map((trj) => ({
    t: trj.t,
    temp: new Uint16Array(Array.from(trj.T, (v) => Math.max(0, Math.min(65535, Math.round((v - 200) * 64))))),
    state: trj.state,
  }));
  result.snapshotInterval = interval;
  onProgress?.(1);
  return result;
}

// ---------------- WebGPU ----------------

async function runGpuSim(cfg: ProjectConfig, onProgress?: (pct: number) => void): Promise<SimResult> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('无可用 GPU 适配器');
  const device = await adapter.requestDevice();

  const layout = buildLayout(cfg);
  const net = buildNetwork(cfg, layout);
  const cp = buildCellParams(cfg, layout.cellCount);
  const { N, M, nodeCount } = net;
  const table = SELF_HEAT_TABLE[cfg.cell.chemistry];
  const snapshotInterval = 4;
  const snapshotMax = Math.ceil(cfg.simDuration / snapshotInterval) + 1;
  const eventMax = Math.min(4096, N);

  const shader = await loadShader();
  const wgslModule = device.createShaderModule({ code: shader });
  const compInfo = await wgslModule.getCompilationInfo();
  const errMsg = compInfo.messages.filter((m) => m.type === 'error').map((m) => m.message).join('\n');
  if (errMsg) throw new Error('WGSL 编译错误: ' + errMsg);

  // 与 WGSL 实际读写性一致:4(mods)/5(cellPos)/6(misc) 只读,其余可写
  const readOnly = new Set([4, 5, 6]);
  const bindGroupLayout = device.createBindGroupLayout({
    entries: Array.from({ length: 9 }, (_, i) => ({
      binding: i, visibility: GPUShaderStage.COMPUTE,
      buffer: i === 0 ? { type: 'uniform' } : { type: readOnly.has(i) ? 'read-only-storage' : 'storage' },
    })),
  });
  const plLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeFluid = device.createComputePipeline({ layout: plLayout, compute: { module: wgslModule, entryPoint: 'fluidPass' } });
  const pipeCell = device.createComputePipeline({ layout: plLayout, compute: { module: wgslModule, entryPoint: 'cellPass' } });
  const pipeShell = device.createComputePipeline({ layout: plLayout, compute: { module: wgslModule, entryPoint: 'shellPlatePass' } });
  const pipeSnap = device.createComputePipeline({ layout: plLayout, compute: { module: wgslModule, entryPoint: 'snapshotPass' } });

  const mk = (data: BufferSource | number): GPUBuffer => {
    const size = typeof data === 'number' ? data : data.byteLength;
    const buf = device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (typeof data !== 'number') device.queue.writeBuffer(buf, 0, data);
    return buf;
  };

  const uniformData = new Float32Array(60);
  const u32view = new Uint32Array(uniformData.buffer);
  const uniformBuffer = device.createBuffer({ size: uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const ioEventBase = 2 * eventMax;
  u32view.set([N, M, net.cellsX, net.cellsPerModule], 0);
  // WGSL: [4]platesPerBranch [5]branchCount [6]eventMax [7]triggerCount
  u32view.set([net.platesPerBranch, net.branchCount, eventMax, cfg.triggers.length], 4);
  uniformData.set([net.dtCrit, 0, cfg.hvac.ambientT, cfg.cooling.inletTemp], 8);
  uniformData.set([net.gxGap, net.gxEffK, net.faceAreaX, net.gCellPairZ], 12);
  uniformData.set([net.gCellShell, net.gCellPlate, net.gPlateFluid, net.mDotCp], 16);
  uniformData.set([net.radCoeffX, net.radCoeffZ, net.enableRadiation ? 1 : 0, -1], 20);
  // WGSL: [24]snapshotMax [25]snapshotSlot [26]nozzleCount [27]ioEventBase
  u32view.set([snapshotMax, 0, cfg.nozzles.length, ioEventBase], 24);
  uniformData.set(table.tC, 28);
  uniformData.set(table.q, 34);
  // 停泵位掩码 + misc 布局(第 15 个 vec4,index 56..59)
  let stoppedMask = 0;
  for (const b of cfg.cooling.stoppedBranches) stoppedMask |= 1 << b;
  const nozzleStride = 5;
  const miscBase = 0;                                   // 喷嘴区起点
  const trigBase = Math.max(1, cfg.nozzles.length) * nozzleStride; // 触发区起点
  u32view.set([stoppedMask, miscBase, trigBase, nozzleStride], 56);

  // CellData: 12 f32/颗
  const cellPacked = new Float32Array(N * 12);
  for (let i = 0; i < N; i++) {
    const o = i * 12;
    cellPacked[o] = net.cellC[i];
    cellPacked[o + 1] = Number.isFinite(net.cellContactK[i]) ? net.cellContactK[i] : NaN;
    cellPacked[o + 2] = cp.mass[i];
    cellPacked[o + 3] = cp.selfStartT[i];
    cellPacked[o + 4] = cp.trTriggerT[i];
    cellPacked[o + 5] = cp.trHeatTotal[i];
    cellPacked[o + 6] = cp.ventDuration[i];
    cellPacked[o + 7] = cp.flamePlateauT[i];
    cellPacked[o + 8] = cp.flameHoldS[i];
    cellPacked[o + 9] = 0;
    cellPacked[o + 10] = NaN;
    cellPacked[o + 11] = 0;
  }
  const modPacked = new Float32Array(M * 4);
  for (let m = 0; m < M; m++) {
    modPacked[m * 4] = net.shellC[m];
    modPacked[m * 4 + 1] = net.plateC[m];
    modPacked[m * 4 + 2] = net.gShellAmb[m];
  }
  // misc 缓冲:喷嘴区(每喷嘴 5 f32)+ 触发区(每触发 2 f32)
  const nozzleCount = Math.max(1, cfg.nozzles.length);
  const miscLen = nozzleCount * 5 + Math.max(1, cfg.triggers.length) * 2;
  const misc = new Float32Array(miscLen);
  cfg.nozzles.forEach((nz, k) => misc.set([nz.x, nz.y, nz.z, nz.radius, nz.coolingRate], k * 5));
  cfg.triggers.forEach((t, k) => { misc[trigBase + k * 2] = t.cellGlobalIndex; misc[trigBase + k * 2 + 1] = t.time; });
  const ioData = new Int32Array(ioEventBase + 2);

  const bufT = mk(new Float32Array(nodeCount).fill(cfg.hvac.ambientT));
  const bufTn = mk(new Float32Array(nodeCount).fill(cfg.hvac.ambientT));
  const bufCells = mk(cellPacked);
  const bufMods = mk(modPacked);
  const bufPos = mk(layout.cellPositions);
  const bufMisc = mk(misc);
  const bufIo = mk(ioData);
  const bufSnap = mk(snapshotMax * N * 4);
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: bufT } },
      { binding: 2, resource: { buffer: bufTn } },
      { binding: 3, resource: { buffer: bufCells } },
      { binding: 4, resource: { buffer: bufMods } },
      { binding: 5, resource: { buffer: bufPos } },
      { binding: 6, resource: { buffer: bufMisc } },
      { binding: 7, resource: { buffer: bufIo } },
      { binding: 8, resource: { buffer: bufSnap } },
    ],
  });

  const dt = net.dtCrit;
  const totalSteps = Math.ceil(cfg.simDuration / dt);
  const chunk = 100;
  const t0 = performance.now();
  let snapSlot = 0, nextSnap = 0;

  // 每个时间步单独提交:writeBuffer 的 uniform 更新必须在对应 dispatch 之前入队,
  // 不能在一个 encoder 内反复覆写同一 uniform(提交时只会看到最后一次值)。
  for (let base = 0; base < totalSteps; base += chunk) {
    const end = Math.min(totalSteps, base + chunk);
    for (let s = base; s < end; s++) {
      const t = s * dt;
      uniformData[9] = t;
      u32view[25] = snapSlot < snapshotMax && t >= nextSnap ? snapSlot : u32view[25];
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);
      const encoder = device.createCommandEncoder();
      if (t >= nextSnap && snapSlot < snapshotMax) {
        const cp0 = encoder.beginComputePass();
        cp0.setPipeline(pipeSnap); cp0.setBindGroup(0, bindGroup);
        cp0.dispatchWorkgroups(Math.ceil(N / 256)); cp0.end();
        snapSlot++; nextSnap += snapshotInterval;
      }
      const pass = encoder.beginComputePass();
      pass.setBindGroup(0, bindGroup);
      pass.setPipeline(pipeFluid); pass.dispatchWorkgroups(net.branchCount);
      pass.setPipeline(pipeCell); pass.dispatchWorkgroups(Math.ceil(N / 256));
      pass.setPipeline(pipeShell); pass.dispatchWorkgroups(Math.ceil(M / 64));
      pass.end();
      encoder.copyBufferToBuffer(bufTn, 0, bufT, 0, nodeCount * 4);
      device.queue.submit([encoder.finish()]);
    }
    onProgress?.(end / totalSteps);
    await device.queue.onSubmittedWorkDone();
  }

  const readback = (size: number) => device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const rbT = readback(nodeCount * 4), rbIo = readback(bufIo.size), rbSnap = readback(bufSnap.size);
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(bufT, 0, rbT, 0, nodeCount * 4);
  enc.copyBufferToBuffer(bufIo, 0, rbIo, 0, bufIo.size);
  enc.copyBufferToBuffer(bufSnap, 0, rbSnap, 0, bufSnap.size);
  device.queue.submit([enc.finish()]);
  await Promise.all([rbT, rbIo, rbSnap].map((b) => b.mapAsync(GPUMapMode.READ)));

  const finalT = new Float32Array(rbT.getMappedRange().slice(0));
  const ioOut = new Int32Array(rbIo.getMappedRange().slice(0));
  const snapWords = new Uint32Array(rbSnap.getMappedRange().slice(0));
  const eventCount = ioOut[ioEventBase];
  const diverged = ioOut[ioEventBase + 1] > 0;

  const trOrder: { cell: number; t: number }[] = [];
  for (let k = 0; k < Math.min(eventCount, eventMax); k++) {
    const cell = ioOut[k * 2] >>> 0;
    const tv = new Float32Array(new Uint32Array([ioOut[k * 2 + 1] >>> 0]).buffer)[0];
    trOrder.push({ cell, t: tv });
  }
  trOrder.sort((a, b) => a.t - b.t);

  const snapshots: SnapshotMeta[] = [];
  for (let s = 0; s < snapSlot; s++) {
    const temp = new Uint16Array(N), stArr = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const w = snapWords[s * N + i];
      temp[i] = w & 0xFFFF; stArr[i] = (w >> 16) & 0xFF;
    }
    snapshots.push({ t: s * snapshotInterval, temp, state: stArr });
  }

  const alarms = computeDetectorAlarms(cfg, layout, trOrder);
  const result = makeSummary(cfg, layout, trOrder, {
    wallTimeMs: performance.now() - t0, steps: totalSteps, finalDt: dt, diverged,
  }, finalT, alarms);
  result.snapshots = snapshots;
  result.snapshotInterval = snapshotInterval;

  [rbT, rbIo, rbSnap].forEach((b) => b.unmap());
  [bufT, bufTn, bufCells, bufMods, bufPos, bufMisc, bufIo, bufSnap, uniformBuffer].forEach((b) => b.destroy());
  return result;
}

let cachedShader: string | null = null;
async function loadShader(): Promise<string> {
  if (cachedShader) return cachedShader;
  const resp = await fetch(new URL('./thermal.wgsl', import.meta.url));
  cachedShader = await resp.text();
  return cachedShader;
}

export { dequantizeT };
