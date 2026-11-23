// WebGPU 渲染器：实例化电芯/模组/舱体/管路/探测器/喷发锥，温度色标，剖切，ray 点选
import type { Topology } from '../model/topology';
import type { ProjectConfig, SimulationRun } from '../model/types';
import { k2c } from '../model/defaults';
import renderWgsl from './render.wgsl?raw';

export interface ViewSettings {
  cutaway: boolean;
  cutRack: number;
  cabinOpacity: number;
  showPropagation: boolean;
  showVents: boolean;
  showDetectors: boolean;
  showCooling: boolean;
}

const INSTANCE_FLOATS = 20; // mat4(16) + vec4(4)

// 温度→颜色：蓝(25℃)→青→黄→橙→红(300℃+)，RGB 0~1
export function tempColor(tempK: number): [number, number, number] {
  const c = k2c(tempK);
  const stops: [number, [number, number, number]][] = [
    [25, [0.22, 0.45, 0.95]],
    [60, [0.2, 0.8, 0.9]],
    [100, [0.35, 0.9, 0.45]],
    [150, [0.95, 0.9, 0.3]],
    [220, [0.98, 0.55, 0.15]],
    [300, [0.95, 0.15, 0.1]],
    [600, [0.8, 0.05, 0.55]],
  ];
  if (c <= stops[0][0]) return stops[0][1];
  if (c >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (c - t0) / (t1 - t0);
      return [c0[0] + f * (c1[0] - c0[0]), c0[1] + f * (c1[1] - c0[1]), c0[2] + f * (c1[2] - c0[2])];
    }
  }
  return stops[stops.length - 1][1];
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, near * far * nf, 0,
  ]);
}
function lookAt(eye: number[], target: number[], up: number[]): Float32Array {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -x[0] * eye[0] - x[1] * eye[1] - x[2] * eye[2],
    -y[0] * eye[0] - y[1] * eye[1] - y[2] * eye[2],
    -z[0] * eye[0] - z[1] * eye[1] - z[2] * eye[2],
    1,
  ]);
}
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
      a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
  }
  return o;
}
/** 平移+缩放模型矩阵（盒子几何为单位立方体，居中） */
function modelMatrix(pos: number[], scale: number[]): Float32Array {
  return new Float32Array([
    scale[0], 0, 0, 0,
    0, scale[1], 0, 0,
    0, 0, scale[2], 0,
    pos[0], pos[1], pos[2], 1,
  ]);
}

/** 任意朝向细盒：单位立方体先沿 Z 拉长 len，再旋转到 dir 方向，平移到 mid（蔓延连线用） */
function orientedBoxMatrix(mid: number[], dir: number[], len: number, thickness: number): Float32Array {
  let [x, y, z] = dir;
  const l = Math.hypot(x, y, z) || 1;
  x /= l; y /= l; z /= l;
  // Rodrigues：把局部 +Z 轴旋转到 d，旋转轴 k = normalize(cross(Z, d))，角 θ = acos(d·Z)
  const zAxis = [0, 0, 1];
  const k = [y * 1 - z * 0, z * 0 - x * 1, x * 0 - y * 0]; // cross(zAxis, d)
  const kl = Math.hypot(k[0], k[1], k[2]);
  let R: number[][];
  if (kl < 1e-6) {
    // 平行或反平行于 Z
    const s = z >= 0 ? 1 : -1;
    R = [[1, 0, 0], [0, 1, 0], [0, 0, s]];
  } else {
    const kx = k[0] / kl, ky = k[1] / kl, kz = k[2] / kl;
    const c = z; // d·Z
    const s = Math.sqrt(1 - c * c);
    const C = 1 - c;
    R = [
      [c + kx * kx * C, kx * ky * C - kz * s, kx * kz * C + ky * s],
      [ky * kx * C + kz * s, c + ky * ky * C, ky * kz * C - kx * s],
      [kz * kx * C - ky * s, kz * ky * C + kx * s, c + kz * kz * C],
    ];
  }
  // 列主序：缩放(thickness, thickness, len) 后旋转，再平移
  const sx = thickness, sy = thickness, sz = len;
  return new Float32Array([
    R[0][0] * sx, R[1][0] * sx, R[2][0] * sx, 0,
    R[0][1] * sy, R[1][1] * sy, R[2][1] * sy, 0,
    R[0][2] * sz, R[1][2] * sz, R[2][2] * sz, 0,
    mid[0], mid[1], mid[2], 1,
  ]);
}

export class OrbitCamera {
  target = [6, 1.2, 1.2];
  yaw = 0.6; pitch = 0.35; dist = 9;
  eye(): number[] {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.dist * cp * Math.cos(this.yaw),
      this.target[1] + this.dist * Math.sin(this.pitch),
      this.target[2] + this.dist * cp * Math.sin(this.yaw),
    ];
  }
  viewProj(aspect: number): Float32Array {
    const eye = this.eye();
    return mul(perspective((50 * Math.PI) / 180, aspect, 0.05, 200), lookAt(eye, this.target, [0, 0, 1]));
  }
}

export class Renderer {
  canvas: HTMLCanvasElement;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  camera = new OrbitCamera();
  private topo: Topology;
  private cfg: ProjectConfig;
  private cellBuf!: GPUBuffer;
  private plainBuf!: GPUBuffer;
  private cellPipe!: GPURenderPipeline;
  private plainPipe!: GPURenderPipeline;
  private camBuf!: GPUBuffer;
  private cellBG!: GPUBindGroup;
  private plainBG!: GPUBindGroup;
  private camBG!: GPUBindGroup;
  private depthTex!: GPUTexture;
  private cellCount = 0;
  private maxPlains = 40000;
  private raf = 0;
  private frameData: { temps: Float64Array | number[]; states: Uint8Array | number[]; time: number } | null = null;

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, cfg: ProjectConfig, topo: Topology) {
    this.canvas = canvas;
    this.device = device;
    this.cfg = cfg;
    this.topo = topo;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU canvas context 获取失败');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
  }

  static async create(canvas: HTMLCanvasElement, cfg: ProjectConfig, topo: Topology): Promise<Renderer> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('无 WebGPU 适配器');
    const device = await adapter.requestDevice();
    const r = new Renderer(canvas, device, cfg, topo);
    r.init();
    return r;
  }

  private cubeGeometry(): { vb: GPUBuffer; ib: GPUBuffer; indexCount: number } {
    // 单位立方体（边长1，居中），24 顶点（带法线）+ 36 索引
    const p = 0.5;
    const faces: [number[], number[]][] = [
      [[-p, -p, p], [0, 0, 1]], [[p, -p, p], [0, 0, 1]], [[p, p, p], [0, 0, 1]], [[-p, p, p], [0, 0, 1]],
      [[-p, -p, -p], [0, 0, -1]], [[-p, p, -p], [0, 0, -1]], [[p, p, -p], [0, 0, -1]], [[p, -p, -p], [0, 0, -1]],
      [[-p, p, -p], [1, 0, 0]], [[-p, p, p], [1, 0, 0]], [[p, p, p], [1, 0, 0]], [[p, p, -p], [1, 0, 0]],
      [[-p, -p, -p], [-1, 0, 0]], [[p, -p, -p], [-1, 0, 0]], [[p, -p, p], [-1, 0, 0]], [[-p, -p, p], [-1, 0, 0]],
      [[p, -p, -p], [0, -1, 0]], [[-p, -p, -p], [0, -1, 0]], [[-p, -p, p], [0, -1, 0]], [[p, -p, p], [0, -1, 0]],
      [[-p, p, -p], [0, 1, 0]], [[p, p, -p], [0, 1, 0]], [[p, p, p], [0, 1, 0]], [[-p, p, p], [0, 1, 0]],
    ];
    const verts: number[] = [];
    for (const [pos, n] of faces) verts.push(...pos, ...n);
    const idx = [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11,
      12, 13, 14, 12, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
    ];
    const d = this.device;
    const vb = d.createBuffer({ size: verts.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(vb, 0, new Float32Array(verts));
    const ib = d.createBuffer({ size: idx.length * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(ib, 0, new Uint32Array(idx));
    return { vb, ib, indexCount: idx.length };
  }

  private init() {
    const d = this.device;
    this.cellCount = this.topo.cellCount;
    const { vb, ib, indexCount } = this.cubeGeometry();

    this.cellBuf = d.createBuffer({
      size: Math.max(this.cellCount, 1) * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.plainBuf = d.createBuffer({
      size: this.maxPlains * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.camBuf = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = d.createShaderModule({ code: renderWgsl });
    const camLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const storageLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [camLayout, storageLayout] });
    const vertexBufLayout: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }],
    };
    const blend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    this.cellPipe = d.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vsCell', buffers: [vertexBufLayout] },
      fragment: { module, entryPoint: 'fsCell', targets: [{ format: this.format, blend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.plainPipe = d.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vsPlain', buffers: [vertexBufLayout] },
      fragment: { module, entryPoint: 'fsPlain', targets: [{ format: this.format, blend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.cellBG = d.createBindGroup({ layout: storageLayout, entries: [{ binding: 0, resource: { buffer: this.cellBuf } }] });
    this.plainBG = d.createBindGroup({ layout: storageLayout, entries: [{ binding: 0, resource: { buffer: this.plainBuf } }] });
    this.camBG = d.createBindGroup({ layout: camLayout, entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
    (this as unknown as { vb: GPUBuffer; ib: GPUBuffer; indexCount: number }).vb = vb;
    (this as unknown as { ib: GPUBuffer; indexCount: number }).ib = ib;
    (this as unknown as { indexCount: number }).indexCount = indexCount;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth * devicePixelRatio;
    const h = this.canvas.clientHeight * devicePixelRatio;
    if (this.canvas.width !== Math.max(1, w) || this.canvas.height !== Math.max(1, h)) {
      this.canvas.width = Math.max(1, w);
      this.canvas.height = Math.max(1, h);
    }
    this.depthTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  setFrame(temps: Float64Array | number[], states: Uint8Array | number[], time: number) {
    this.frameData = { temps, states, time };
  }

  private pushInstance(out: Float32Array, count: { n: number }, model: Float32Array, color: [number, number, number, number]) {
    if (count.n >= this.maxPlains) return;
    const o = count.n * INSTANCE_FLOATS;
    out.set(model, o);
    out.set(color, o + 16);
    count.n++;
  }

  render(view: ViewSettings, run: SimulationRun | null, selectedCell: number) {
    this.resize();
    const d = this.device;
    const t = this.topo;
    const [cw, ct, ch] = t.cellDims;
    const temps = this.frameData?.temps;
    const states = this.frameData?.states;

    // —— 电芯实例 ——
    const cellData = new Float32Array(this.cellCount * INSTANCE_FLOATS);
    let visible = 0;
    for (let i = 0; i < this.cellCount; i++) {
      if (view.cutaway && t.rackId[i] === view.cutRack) continue;
      const T = temps ? temps[i] : this.cfg.cabin.ambientTemp;
      const s = states ? states[i] : 0;
      const col = tempColor(T);
      const alpha = s === 3 ? 0.45 : 1;
      const sel = i === selectedCell ? [1, 1, 1] : col;
      const m = modelMatrix([t.posX[i], t.posY[i], t.posZ[i]], [ct, cw, ch]);
      cellData.set(m, visible * INSTANCE_FLOATS);
      cellData.set([sel[0], sel[1], sel[2], alpha], visible * INSTANCE_FLOATS + 16);
      visible++;
    }
    d.queue.writeBuffer(this.cellBuf, 0, cellData);

    // —— 半透明场景实例 ——
    const plains = new Float32Array(this.maxPlains * INSTANCE_FLOATS);
    const pc = { n: 0 };
    // 模组外壳
    for (let m = 0; m < t.moduleCount; m++) {
      const [mL, mW, mH] = t.moduleDims;
      const r = t.moduleRack[m];
      if (view.cutaway && r === view.cutRack) continue;
      this.pushInstance(plains, pc, modelMatrix([t.shellPos[3 * m], t.shellPos[3 * m + 1], t.shellPos[3 * m + 2]], [mL, mW, mH]), [0.75, 0.78, 0.82, 0.06]);
    }
    // 舱体
    const [L, W, H] = this.cfg.cabin.dims;
    this.pushInstance(plains, pc, modelMatrix([L / 2, W / 2, H / 2], [L, W, H]), [0.55, 0.7, 0.85, view.cabinOpacity]);
    // 高压箱
    this.pushInstance(plains, pc, modelMatrix(this.cfg.cabin.hvBoxPos, [0.5, 0.6, 0.8]), [0.9, 0.75, 0.3, 0.55]);
    // 空调出风口
    for (const v of this.cfg.cabin.acVents) {
      this.pushInstance(plains, pc, modelMatrix(v, [0.25, 0.15, 0.3]), [0.4, 0.8, 1, 0.5]);
    }
    // 液冷管路（每簇一根沿 Z 的细管）
    if (view.showCooling && this.cfg.cooling.enabled) {
      for (let r = 0; r < t.rackCount; r++) {
        const o = t.rackOrigin[3 * r];
        const failed = this.cfg.cooling.failedBranches.includes(r);
        this.pushInstance(plains, pc, modelMatrix([o + 0.05, this.cfg.cabin.dims[1] - 0.12, H / 2], [0.04, 0.04, H * 0.85]),
          failed ? [0.9, 0.2, 0.1, 0.8] : [0.15, 0.75, 0.95, 0.7]);
      }
    }
    // 探测器（小球用缩小立方体近似）
    if (view.showDetectors) {
      const detColor: Record<string, [number, number, number, number]> = {
        gas: [0.2, 1, 0.5, 0.95], smoke: [0.8, 0.8, 0.85, 0.95], temp: [1, 0.45, 0.2, 0.95],
      };
      for (const det of this.cfg.detectors) {
        this.pushInstance(plains, pc, modelMatrix(det.position, [0.09, 0.09, 0.09]), detColor[det.kind]);
      }
    }
    // 蔓延路径：按失控顺序把电芯连成细盒线段，跨模组用紫色、模组内用橙红
    if (view.showPropagation && run && run.events.length > 1) {
      const lit = new Map(run.events.map((e) => [e.cellIndex, e]));
      for (const e of run.events) {
        if (!e.cause.startsWith('prop:')) continue;
        const src = Number(e.cause.slice(5));
        if (!lit.has(src)) continue;
        const a = [t.posX[src], t.posY[src], t.posZ[src]];
        const b = [t.posX[e.cellIndex], t.posY[e.cellIndex], t.posZ[e.cellIndex]];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.max(Math.hypot(dir[0], dir[1], dir[2]), 0.001);
        const crossModule = t.moduleId[src] !== t.moduleId[e.cellIndex];
        this.pushInstance(plains, pc, orientedBoxMatrix(mid, dir, len, 0.012),
          crossModule ? [0.7, 0.3, 1, 0.9] : [1, 0.6, 0.1, 0.9]);
      }
    }
    // 喷发锥：处于 state 2 的电芯，泄压阀沿 +Z，持续 ventDuration
    if (view.showVents && states) {
      const now = this.frameData?.time ?? 0;
      for (const e of run?.events ?? []) {
        const endT = e.time + this.cfg.chem.ventDuration;
        if (now < e.time || now > endT) continue;
        if (view.cutaway && t.rackId[e.cellIndex] === view.cutRack) continue;
        const f = (now - e.time) / this.cfg.chem.ventDuration;
        const h = 0.35 * (0.4 + 0.6 * f);
        this.pushInstance(plains, pc,
          modelMatrix([t.posX[e.cellIndex], t.posY[e.cellIndex], t.posZ[e.cellIndex] + ch / 2 + h / 2], [0.05 * (1 - f * 0.5), 0.05 * (1 - f * 0.5), h]),
          [1, 0.5 + 0.4 * f, 0.1, 0.55 * (1 - f * 0.6)]);
      }
    }
    d.queue.writeBuffer(this.plainBuf, 0, plains);

    // —— 相机 ——
    const aspect = this.canvas.width / this.canvas.height;
    // Camera 结构：mat4(16) + eye vec3(3) + pad(1) = 20 float = 80 字节
    const cam = new Float32Array(20);
    cam.set(this.camera.viewProj(aspect), 0);
    const eye = this.camera.eye();
    cam.set(eye, 16);
    d.queue.writeBuffer(this.camBuf, 0, cam);

    const encoder = d.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.07, g: 0.09, b: 0.12, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    });
    const self = this as unknown as { vb: GPUBuffer; ib: GPUBuffer; indexCount: number };
    pass.setVertexBuffer(0, self.vb);
    pass.setIndexBuffer(self.ib, 'uint32');
    pass.setBindGroup(0, this.camBG);
    pass.setPipeline(this.cellPipe);
    pass.setBindGroup(1, this.cellBG);
    pass.drawIndexed(self.indexCount, visible);
    pass.setPipeline(this.plainPipe);
    pass.setBindGroup(1, this.plainBG);
    pass.drawIndexed(self.indexCount, pc.n);
    pass.end();
    d.queue.submit([encoder.finish()]);
  }

  /** 屏幕坐标 → 电芯射线拾取（CPU 侧 AABB 相交） */
  pick(nx: number, ny: number): number {
    const t = this.topo;
    const aspect = this.canvas.width / this.canvas.height;
    const eye = this.camera.eye();
    // 构造视线（近平面点反投影）
    const fov = (50 * Math.PI) / 180;
    const tan = Math.tan(fov / 2);
    const cp = Math.cos(this.camera.pitch), sp = Math.sin(this.camera.pitch);
    const cy = Math.cos(this.camera.yaw), sy = Math.sin(this.camera.yaw);
    const forward = [-cp * cy, -sp, -cp * sy];
    const right = [sy, 0, -cy];
    const up = [sp * cy, -cp, sp * sy];
    const dir0 = [
      forward[0] + right[0] * nx * tan * aspect + up[0] * ny * tan,
      forward[1] + right[1] * nx * tan * aspect + up[1] * ny * tan,
      forward[2] + right[2] * nx * tan * aspect + up[2] * ny * tan,
    ];
    const dl = Math.hypot(dir0[0], dir0[1], dir0[2]);
    const dir = dir0.map((v) => v / dl);

    let best = -1; let bestD = Infinity;
    const [cw, ct, ch] = t.cellDims;
    for (let i = 0; i < t.cellCount; i++) {
      const c = [t.posX[i], t.posY[i], t.posZ[i]];
      const half = [ct / 2, cw / 2, ch / 2];
      const d = rayAabb(eye, dir, c, half);
      if (d !== null && d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  start(view: () => ViewSettings, run: () => SimulationRun | null, selected: () => number) {
    const loop = () => {
      this.render(view(), run(), selected());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }

  updateConfig(cfg: ProjectConfig, topo: Topology) {
    this.cfg = cfg;
    this.topo = topo;
    this.cellCount = topo.cellCount;
    this.cellBuf.destroy();
    this.cellBuf = this.device.createBuffer({
      size: Math.max(this.cellCount, 1) * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cellBG = this.device.createBindGroup({
      layout: this.cellPipe.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.cellBuf } }],
    });
  }

  destroy() {
    this.stop();
    this.device.destroy();
  }
}

/** 射线-AABB 相交，返回最近距离或 null（slab 法） */
function rayAabb(origin: number[], dir: number[], center: number[], half: number[]): number | null {
  let tmin = 0, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-9) {
      if (origin[a] < center[a] - half[a] || origin[a] > center[a] + half[a]) return null;
    } else {
      let t1 = (center[a] - half[a] - origin[a]) / dir[a];
      let t2 = (center[a] + half[a] - origin[a]) / dir[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
