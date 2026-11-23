// WebGPU 求解器：打包后的 9 个缓冲（遵守每阶段 storage ≤8 限制）
// 缓冲结构与 compute.wgsl 中的 struct 一一对应
import type { ProjectConfig, RunawayEvent } from '../model/types';
import type { Topology } from '../model/topology';
import { stableDt } from '../physics/formulas';
import wgsl from './compute.wgsl?raw';

export const PARAMS_SIZE = 80; // 20 个 u32/f32

export async function hasWebGpu(): Promise<boolean> {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// CellStatic 每元素 16 float = 64 字节
const STATIC_FLOATS = 16;
// CellState 每元素 8 float = 32 字节
const STATE_FLOATS = 8;
// ModuleDyn 4 float，ModuleStatic 4 float
const MOD_FLOATS = 4;

interface PackedBuffers {
  params: GPUBuffer;
  cells: GPUBuffer;      // CellState[nCell]
  statics: GPUBuffer;    // CellStatic[nCell]
  modules: GPUBuffer;    // ModuleDyn[nModule]
  modStatic: GPUBuffer;  // ModuleStatic[nModule]
  tableT: GPUBuffer;
  tableQ: GPUBuffer;
  rackHeat: GPUBuffer;   // atomic u32[nRack]
  mdotCp: GPUBuffer;
}

export interface GpuRunOptions {
  endTime: number;
  maxDt: number;
  snapshotInterval: number;
  initialTemp: number;
  dischargeTime: number;
  onProgress?: (t: number, dt: number, runaway: number) => void;
  signal?: { cancelled: boolean };
}

export interface GpuRunResult {
  times: number[];
  tempFrames: number[][];
  stateFrames: number[][];
  events: RunawayEvent[];
  dischargeTime: number;
  endTime: number;
  steps: number;
}

export class GpuSolver {
  device: GPUDevice;
  private cfg: ProjectConfig;
  private topo: Topology;
  private buf!: PackedBuffers;
  private pipes!: { heat: GPUComputePipeline; cool: GPUComputePipeline; integrate: GPUComputePipeline };
  private bindGroup!: GPUBindGroup;
  private nrStaging!: GPUBuffer;
  private extPStaging!: GPUBuffer;
  private extFStaging!: GPUBuffer;
  private nCell: number;
  private nModule: number;
  private total: number;

  private constructor(device: GPUDevice, cfg: ProjectConfig, topo: Topology) {
    this.device = device;
    this.cfg = cfg;
    this.topo = topo;
    this.nCell = topo.cellCount;
    this.nModule = topo.moduleCount;
    this.total = topo.totalNodes;
  }

  static async create(cfg: ProjectConfig, topo: Topology): Promise<GpuSolver> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到 WebGPU 适配器');
    const device = await adapter.requestDevice();
    const solver = new GpuSolver(device, cfg, topo);
    solver.init();
    return solver;
  }

  private init() {
    const d = this.device;
    const t = this.topo;
    const SR = GPUBufferUsage.STORAGE;
    const RW = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

    // —— CellStatic 打包 ——
    const statics = new Float32Array(this.nCell * STATIC_FLOATS);
    for (let i = 0; i < this.nCell; i++) {
      const o = i * STATIC_FLOATS;
      statics[o] = t.cap[i];
      statics[o + 1] = t.gx[i];
      statics[o + 2] = t.gy[i];
      statics[o + 3] = t.gShell[i];
      statics[o + 4] = t.gCold[i];
      statics[o + 5] = t.shellNode[i];
      statics[o + 6] = t.moduleId[i];
      statics[o + 7] = t.rackId[i];
      statics[o + 8] = t.neighbor[4 * i];
      statics[o + 9] = t.neighbor[4 * i + 1];
      statics[o + 10] = t.neighbor[4 * i + 2];
      statics[o + 11] = t.neighbor[4 * i + 3];
    }
    // —— ModuleStatic ——
    const modStatic = new Float32Array(this.nModule * MOD_FLOATS);
    for (let m = 0; m < this.nModule; m++) {
      const o = m * MOD_FLOATS;
      modStatic[o] = t.shellCap[m];
      modStatic[o + 1] = t.shellGAmbient[m];
      modStatic[o + 2] = t.shellGNext[m];
      modStatic[o + 3] = t.moduleRack[m];
    }

    const mk = (data: Float32Array | Uint32Array, usage: number) => {
      const b = d.createBuffer({ size: data.byteLength, usage });
      d.queue.writeBuffer(b, 0, data as BufferSource);
      return b;
    };

    this.buf = {
      params: d.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      cells: mk(new Float32Array(this.nCell * STATE_FLOATS), SR | RW),
      statics: mk(statics, SR | GPUBufferUsage.COPY_DST),
      modules: mk(new Float32Array(this.nModule * MOD_FLOATS), SR | RW),
      modStatic: mk(modStatic, SR | GPUBufferUsage.COPY_DST),
      tableT: mk(Float32Array.from(this.cfg.chem.selfHeatTable.map((s) => s.t)), SR | GPUBufferUsage.COPY_DST),
      tableQ: mk(Float32Array.from(this.cfg.chem.selfHeatTable.map((s) => s.power)), SR | GPUBufferUsage.COPY_DST),
      rackHeat: mk(new Uint32Array(t.rackCount), SR | RW | GPUBufferUsage.COPY_DST),
      mdotCp: mk(new Float32Array(t.rackCount), SR | GPUBufferUsage.COPY_DST),
    };
    // 触发输入暂存（COPY_DST | COPY_SRC）
    const STG = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.nrStaging = d.createBuffer({ size: this.nCell * 4, usage: STG });
    this.extPStaging = d.createBuffer({ size: this.nCell * 4, usage: STG });
    this.extFStaging = d.createBuffer({ size: this.nCell * 4, usage: STG });

    const module = d.createShaderModule({ code: wgsl });
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: (binding === 1 || binding === 3 || binding === 7) ? 'storage' : 'read-only-storage' } as GPUBufferBindingLayout,
      })),
    ];
    const bgl = d.createBindGroupLayout({ entries });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.pipes = {
      heat: d.createComputePipeline({ layout, compute: { module, entryPoint: 'heatReduce' } }),
      cool: d.createComputePipeline({ layout, compute: { module, entryPoint: 'cooling' } }),
      integrate: d.createComputePipeline({ layout, compute: { module, entryPoint: 'integrate' } }),
    };
    const order = [this.buf.params, this.buf.cells, this.buf.statics, this.buf.modules,
      this.buf.modStatic, this.buf.tableT, this.buf.tableQ, this.buf.rackHeat, this.buf.mdotCp];
    this.bindGroup = d.createBindGroup({
      layout: bgl,
      entries: order.map((buffer, i) => ({ binding: i, resource: { buffer } })),
    });
  }

  private computeStableDt(): number {
    const t = this.topo;
    let dt = Infinity;
    for (let i = 0; i < this.nCell; i++) {
      const gSum = 2 * (t.gx[i] + t.gy[i]) + t.gShell[i] + (this.cfg.cooling.enabled ? t.gCold[i] : 0);
      dt = Math.min(dt, stableDt(t.cap[i], gSum));
    }
    return Math.max(dt, 1e-4);
  }

  private writeParams(dt: number, time: number, supActive: boolean) {
    const c = this.cfg;
    const dv = new DataView(new ArrayBuffer(PARAMS_SIZE));
    let o = 0;
    const u32 = (v: number) => { dv.setUint32(o, v >>> 0, true); o += 4; };
    const f32 = (v: number) => { dv.setFloat32(o, v, true); o += 4; };
    u32(this.nCell); u32(this.nModule); u32(this.topo.rackCount); u32(this.topo.modulesPerRack);
    f32(dt); f32(time);
    u32(c.cooling.enabled ? 1 : 0); u32(supActive ? 1 : 0);
    f32(c.suppression.coolRate); f32(c.cabin.ambientTemp); f32(c.cooling.inletTemp);
    f32(c.chem.tOnset); f32(c.chem.tTrigger); f32(c.chem.runawayEnergy); f32(c.chem.ventDuration);
    f32(c.chem.runawayPeakTemp);
    u32(c.chem.selfHeatTable.length); u32(0); f32(0); f32(0);
    this.device.queue.writeBuffer(this.buf.params, 0, dv.buffer);
  }

  /** 每步触发输入：暂存缓冲 + encoder 内批量子区间拷贝（避免每芯一次 writeBuffer） */
  private writeStepInputs(now: number, dt: number, enc: GPUCommandEncoder) {
    const n = this.nCell;
    const nr = new Uint32Array(n);
    const extP = new Float32Array(n);
    const extF = new Uint32Array(n);
    for (const tr of this.cfg.triggers) {
      if (now >= tr.time && now < tr.time + tr.duration) extP[tr.cellIndex] += tr.power;
      if (tr.duration === 0 && now < tr.time && now + dt >= tr.time) extF[tr.cellIndex] = 1;
    }
    const d = this.device;
    d.queue.writeBuffer(this.nrStaging, 0, nr);
    d.queue.writeBuffer(this.extPStaging, 0, extP);
    d.queue.writeBuffer(this.extFStaging, 0, extF);
    const stride = STATE_FLOATS * 4;
    for (let i = 0; i < n; i++) {
      enc.copyBufferToBuffer(this.nrStaging, i * 4, this.buf.cells, i * stride + 16, 4);
      enc.copyBufferToBuffer(this.extPStaging, i * 4, this.buf.cells, i * stride + 20, 4);
      enc.copyBufferToBuffer(this.extFStaging, i * 4, this.buf.cells, i * stride + 24, 4);
    }
    enc.clearBuffer(this.buf.rackHeat);
  }

  async run(opts: GpuRunOptions): Promise<GpuRunResult> {
    const d = this.device;
    const t = this.topo;
    const c = this.cfg;

    // 初始化 CellState：temp(0)=initialTemp，其余 0；ModuleDyn.shellTemp(0)=initialTemp
    const initCells = new Float32Array(this.nCell * STATE_FLOATS);
    for (let i = 0; i < this.nCell; i++) initCells[i * STATE_FLOATS] = opts.initialTemp;
    d.queue.writeBuffer(this.buf.cells, 0, initCells);
    const initMod = new Float32Array(this.nModule * MOD_FLOATS);
    for (let m = 0; m < this.nModule; m++) initMod[m * MOD_FLOATS] = opts.initialTemp;
    d.queue.writeBuffer(this.buf.modules, 0, initMod);

    const rackFlow = c.cooling.enabled
      ? (c.cooling.flowLpm * c.cooling.fluidDensity / 60) / Math.max(t.rackCount, 1) * c.cooling.fluidSpecificHeat
      : 0;
    const mdot = new Float32Array(t.rackCount).fill(rackFlow);
    d.queue.writeBuffer(this.buf.mdotCp, 0, mdot);

    const times: number[] = [0];
    const tempFrames: number[][] = [new Array(this.nCell).fill(opts.initialTemp)];
    const stateFrames: number[][] = [new Array(this.nCell).fill(0)];
    const events: RunawayEvent[] = [];
    let nextSnapshot = opts.snapshotInterval;
    let now = 0;
    let steps = 0;
    const stable = this.computeStableDt();

    const mkRead = (bytes: number) => d.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const cellsBytes = this.nCell * STATE_FLOATS * 4;
    const nrRead = mkRead(this.nCell * 4);
    const cellsRead = mkRead(cellsBytes);

    const groupsCell = Math.ceil(this.nCell / 64);
    const groupsMod = Math.ceil(this.nModule / 64);
    const groupsTot = Math.ceil(this.total / 64);
    const CHUNK = 0.5;
    const known = new Set<number>();

    while (now < opts.endTime - 1e-9) {
      if (opts.signal?.cancelled) break;
      const chunkEnd = Math.min(now + CHUNK, opts.endTime);
      let wantSnapshot = false;
      const enc = d.createCommandEncoder();

      while (now < chunkEnd - 1e-12) {
        const dt = Math.min(opts.maxDt, stable, chunkEnd - now, opts.endTime - now);
        if (c.cooling.enabled && c.cooling.failedBranches.length) {
          const failed = now >= c.cooling.failTime;
          for (let r = 0; r < t.rackCount; r++) {
            mdot[r] = failed && c.cooling.failedBranches.includes(r) ? 0 : rackFlow;
          }
          d.queue.writeBuffer(this.buf.mdotCp, 0, mdot);
        }
        const supActive = opts.dischargeTime >= 0 && now >= opts.dischargeTime &&
          now < opts.dischargeTime + c.suppression.duration;
        this.writeParams(dt, now, supActive);
        // 触发输入与 rackHeat 清零必须在 compute pass 之外
        this.writeStepInputs(now, dt, enc);

        const pass = enc.beginComputePass();
        pass.setBindGroup(0, this.bindGroup);
        pass.setPipeline(this.pipes.heat);
        pass.dispatchWorkgroups(groupsCell);
        pass.setPipeline(this.pipes.cool);
        pass.dispatchWorkgroups(groupsMod);
        pass.setPipeline(this.pipes.integrate);
        pass.dispatchWorkgroups(groupsTot);
        pass.end();

        now += dt;
        steps += 1;
        if (now >= nextSnapshot - 1e-9) { wantSnapshot = true; nextSnapshot += opts.snapshotInterval; }
      }
      // 回读 newRunaway（CellState 偏移 16）与整包 cells（快照时）
      for (let i = 0; i < this.nCell; i++) {
        enc.copyBufferToBuffer(this.buf.cells, i * STATE_FLOATS * 4 + 16, nrRead, i * 4, 4);
      }
      if (wantSnapshot) enc.copyBufferToBuffer(this.buf.cells, 0, cellsRead, 0, cellsBytes);
      d.queue.submit([enc.finish()]);

      await nrRead.mapAsync(GPUMapMode.READ);
      const nr = new Uint32Array(nrRead.getMappedRange().slice(0));
      nrRead.unmap();
      const triggerCells = new Set(this.cfg.triggers.map((tr) => tr.cellIndex));
      for (let i = 0; i < this.nCell; i++) {
        if (nr[i] === 1 && !known.has(i)) {
          known.add(i);
          let cause = 'trigger';
          if (!triggerCells.has(i)) {
            let src = -1;
            for (let k = 0; k < 4; k++) {
              const j = t.neighbor[4 * i + k];
              if (j >= 0 && known.has(j)) { src = j; break; }
            }
            cause = `prop:${src}`;
          }
          events.push({ cellIndex: i, time: now, moduleId: t.moduleId[i], rackId: t.rackId[i], cause });
        }
      }
      events.sort((a, b) => a.time - b.time || a.cellIndex - b.cellIndex);

      if (wantSnapshot) {
        await cellsRead.mapAsync(GPUMapMode.READ);
        const rawF = new Float32Array(cellsRead.getMappedRange().slice(0));
        cellsRead.unmap();
        const rawU = new Uint32Array(rawF.buffer);
        const tf: number[] = [];
        const sf: number[] = [];
        for (let i = 0; i < this.nCell; i++) {
          tf.push(rawF[i * STATE_FLOATS]);
          // state 是 u32，必须经 Uint32 视图读，不能把 f32 位模式当数字
          sf.push(rawU[i * STATE_FLOATS + 1]);
        }
        times.push(Math.min(now, opts.endTime));
        tempFrames.push(tf);
        stateFrames.push(sf);
      }

      opts.onProgress?.(now, Math.min(opts.maxDt, stable), events.length);
      await new Promise((r) => setTimeout(r, 0));
    }

    nrRead.destroy(); cellsRead.destroy();
    return { times, tempFrames, stateFrames, events, dischargeTime: opts.dischargeTime, endTime: now, steps };
  }

  destroy() {
    Object.values(this.buf).forEach((b) => b.destroy());
    this.nrStaging?.destroy();
    this.extPStaging?.destroy();
    this.extFStaging?.destroy();
    this.device.destroy();
  }
}
