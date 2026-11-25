// WebGPU 实例化渲染:电芯按温度上色,失控电芯画喷发方向;支持舱体半透明与按簇剖切
import type { BuildResult } from '../types';
import type { EquipmentBox, ModuleGeom } from '../physics/geometry';
import type { IRenderer, CellSize, PropLink } from './IRenderer';

const VERT = /* wgsl */ `
struct Camera { viewProj: mat4x4<f32>, eye: vec3<f32>, pad: f32 };
struct Instance { pos: vec3<f32>, scale: vec3<f32>, temp: f32, state: f32, pad1: f32, pad2: f32 };

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;

struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) color: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) world: vec3<f32> };

fn tempColor(t: f32) -> vec3<f32> {
  let blue = vec3<f32>(0.20, 0.45, 0.95);
  let green = vec3<f32>(0.25, 0.80, 0.40);
  let yellow = vec3<f32>(0.98, 0.80, 0.20);
  let red = vec3<f32>(0.95, 0.20, 0.12);
  let white = vec3<f32>(1.0, 0.95, 0.85);
  if (t < 330.0) { return blue; }
  if (t < 390.0) { return mix(blue, green, (t - 330.0) / 60.0); }
  if (t < 450.0) { return mix(green, yellow, (t - 390.0) / 60.0); }
  if (t < 540.0) { return mix(yellow, red, (t - 450.0) / 90.0); }
  if (t < 700.0) { return mix(red, white, clamp((t - 540.0) / 160.0, 0.0, 1.0)); }
  return white;
}

@vertex
fn vs(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) ii: u32) -> VSOut {
  let inst = instances[ii];
  let world = inst.pos + pos * inst.scale;
  var out: VSOut;
  out.clip = cam.viewProj * vec4<f32>(world, 1.0);
  out.normal = normal;
  out.world = world;
  let base = tempColor(inst.temp);
  out.color = select(base, vec3<f32>(1.0, 0.45, 0.1), inst.state >= 2.0);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let light = normalize(vec3<f32>(0.4, 0.8, 0.5));
  let diff = clamp(dot(normalize(in.normal), light) * 0.55 + 0.55, 0.0, 1.0);
  return vec4<f32>(in.color * diff, 1.0);
}
`;

const LINE_VERT = /* wgsl */ `
struct Camera { viewProj: mat4x4<f32>, eye: vec3<f32>, pad: f32 };
@group(0) @binding(0) var<uniform> cam: Camera;
struct VLine { a: vec3<f32>, b: vec3<f32>, color: vec3<f32>, alpha: f32 };
@group(0) @binding(1) var<storage, read> lines: array<VLine>;
struct Out { @builtin(position) clip: vec4<f32>, @location(0) color: vec4<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let l = lines[ii];
  let p = select(l.a, l.b, vi == 1u);
  var out: Out;
  out.clip = cam.viewProj * vec4<f32>(p, 1.0);
  out.color = vec4<f32>(l.color, l.alpha);
  return out;
}
@fragment
fn fs(in: Out) -> @location(0) vec4<f32> { return in.color; }
`;

function boxData(): { verts: Float32Array; indices: Uint32Array } {
  // 单位立方体,中心在原点
  const v = [
    -.5, -.5, -.5, .5, -.5, -.5, .5, .5, -.5, -.5, .5, -.5,
    -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5,
  ];
  const n: number[] = [];
  const normals = [
    [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0],
  ];
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4];
  for (const i of idx) n.push(...normals[Math.floor(i / 6)]);
  const verts = new Float32Array(idx.length * 6);
  idx.forEach((i, k) => {
    verts.set([v[i * 3], v[i * 3 + 1], v[i * 3 + 2], n[k * 3], n[k * 3 + 1], n[k * 3 + 2]], k * 6);
  });
  return { verts, indices: Uint32Array.from({ length: idx.length }, (_, k) => k) };
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f; out[10] = far / (near - far); out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}
function lookAt(eye: [number, number, number], target: [number, number, number]): Float32Array {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const z = norm(sub(eye, target));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m.set([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -x.reduce((s, _, i) => s + x[i] * eye[i], 0),
    -y.reduce((s, _, i) => s + y[i] * eye[i], 0),
    -z.reduce((s, _, i) => s + z[i] * eye[i], 0), 1], 0);
  return m;
}
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

export interface RenderState {
  temps: Float32Array;
  states: Uint8Array | Uint32Array;
  ventDir: Float32Array; // N*3
  cutCluster: number;    // -1 不剖,>=0 隐藏该簇之后
  hullAlpha: number;
}

export class GpuRenderer implements IRenderer {
  device: GPUDevice;
  context: GPUCanvasContext;
  private cellPipe!: GPURenderPipeline;
  private linePipe!: GPURenderPipeline;
  private cellBuf!: GPUBuffer;
  private lineBuf!: GPUBuffer;
  private camBuf!: GPUBuffer;
  private boxVerts!: GPUBuffer;
  private boxIdx!: GPUBuffer;
  private hullPipe!: GPURenderPipeline;
  private hullBuf!: GPUBuffer;
  private N = 0;
  private instanceData: Float32Array;
  camera = { yaw: 0.6, pitch: 0.35, dist: 14, target: [6, 1.2, 1.2] as [number, number, number] };

  private constructor(device: GPUDevice, context: GPUCanvasContext, N: number) {
    this.device = device; this.context = context; this.N = N;
    this.instanceData = new Float32Array(N * 8);
  }

  static async create(canvas: HTMLCanvasElement, layout: BuildResult): Promise<GpuRenderer> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('无 GPU');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const r = new GpuRenderer(device, context, layout.cellCount);
    r.initPipelines(format, layout);
    return r;
  }

  private initPipelines(format: GPUTextureFormat, layout: BuildResult) {
    const { verts, indices } = boxData();
    this.boxVerts = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.boxVerts, 0, verts);
    this.boxIdx = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.boxIdx, 0, indices);

    this.camBuf = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cellBuf = this.device.createBuffer({ size: this.N * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const mod = this.device.createShaderModule({ code: VERT });
    const bgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layoutPipe = this.device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.cellPipe = this.device.createRenderPipeline({
      layout: layoutPipe,
      vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }] },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // 线框/喷发管线
    const lineMod = this.device.createShaderModule({ code: LINE_VERT });
    this.lineBuf = this.device.createBuffer({ size: 8192 * 10 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.linePipe = this.device.createRenderPipeline({
      layout: layoutPipe,
      vertex: { module: lineMod, entryPoint: 'vs' },
      fragment: { module: lineMod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });

    // 舱体/模组外壳(半透明)
    const hullMod = this.device.createShaderModule({ code: HULL_WGSL });
    this.hullPipe = this.device.createRenderPipeline({
      layout: layoutPipe,
      vertex: { module: hullMod, entryPoint: 'vs', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }] },
      fragment: { module: hullMod, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: {} } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.hullBuf = this.device.createBuffer({ size: 1 << 20, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.buildHull(layout);
  }

  private buildHull(layout: BuildResult & { modules?: ModuleGeom[]; equipment?: EquipmentBox[] }) {
    const lines: number[] = [];
    const addBox = (mn: number[], mx: number[], alpha: number) => {
      const c = mn.map((v, i) => (v + mx[i]) / 2);
      const s = mn.map((v, i) => mx[i] - v);
      // 6 面 12 三角形
      const faces = [
        [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5]], [[-.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5]],
        [[-.5, -.5, .5], [.5, .5, .5], [.5, -.5, .5]], [[-.5, -.5, .5], [-.5, .5, .5], [.5, .5, .5]],
        [[-.5, -.5, -.5], [-.5, .5, -.5], [-.5, .5, .5]], [[-.5, -.5, -.5], [-.5, .5, .5], [-.5, -.5, .5]],
        [[.5, -.5, -.5], [.5, -.5, .5], [.5, .5, .5]], [[.5, -.5, -.5], [.5, .5, .5], [.5, .5, -.5]],
        [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5]], [[-.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, .5]],
        [[-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5]], [[-.5, .5, -.5], [.5, .5, .5], [.5, .5, -.5]],
      ];
      const nrm = (p: number[]) => { const l = Math.hypot(...p) || 1; return p.map((v) => v / l); };
      for (const tri of faces) for (const p of tri) {
        const w = p.map((v, i) => c[i] + v * s[i]);
        const n = nrm(p);
        lines.push(...w, ...n, alpha);
      }
    };
    const r = layout.roomSize;
    addBox([0, 0, 0], [r.x, r.y, r.z], 0.08);
    for (const m of layout.modules ?? []) addBox([m.minX, m.minY, m.minZ], [m.maxX, m.maxY, m.maxZ], 0.12);
    for (const e of layout.equipment ?? []) addBox([e.minX, e.minY, e.minZ], [e.maxX, e.maxY, e.maxZ], 0.18);
    const data = new Float32Array(lines);
    if (data.byteLength > this.hullBuf.size) {
      this.hullBuf.destroy();
      this.hullBuf = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.hullBuf, 0, data);
    (this as unknown as { hullVertexCount: number }).hullVertexCount = data.length / 7;
  }

  /** 每帧更新实例数据(温度/状态/位置),cellSize 由布局给定 */
  updateInstances(layout: BuildResult, cellSize: CellSize, st: RenderState) {
    const d = this.instanceData;
    for (let i = 0; i < this.N; i++) {
      const o = i * 8;
      const cluster = layout.moduleCluster[layout.cellModule[i]];
      if (st.cutCluster >= 0 && cluster > st.cutCluster) { d[o + 3] = 0; continue; }
      d[o] = layout.cellPositions[i * 3]; d[o + 1] = layout.cellPositions[i * 3 + 1]; d[o + 2] = layout.cellPositions[i * 3 + 2];
      d[o + 3] = cellSize.w * 0.92; d[o + 4] = cellSize.h * 0.92; d[o + 5] = cellSize.d * 0.92;
      d[o + 6] = st.temps[i] ?? 298.15; d[o + 7] = st.states[i] ?? 0;
    }
    this.device.queue.writeBuffer(this.cellBuf, 0, d);

    // 喷发方向线:失控电芯顶部向上,长度按剩余喷发时间
    const vlines: number[] = [];
    for (let i = 0; i < this.N; i++) {
      if (st.states[i] !== 2) continue;
      const px = layout.cellPositions[i * 3], py = layout.cellPositions[i * 3 + 1] + cellSize.h / 2, pz = layout.cellPositions[i * 3 + 2];
      const len = 0.35;
      vlines.push(px, py, pz, px, py + len, pz, 1.0, 0.45, 0.1, 0.9);
    }
    // 蔓延连线(若有)由外部通过 setPropagationLines 注入
    if (vlines.length) {
      const bytes = new Float32Array(vlines);
      if (bytes.byteLength <= this.lineBuf.size) this.device.queue.writeBuffer(this.lineBuf, 0, bytes);
    }
    (this as unknown as { lineCount: number }).lineCount = vlines.length / 10;
  }

  private propagationLines: number[] = [];
  setPropagationLines(links: PropLink[], layout: BuildResult) {
    this.propagationLines = [];
    for (const l of links) {
      const a = [layout.cellPositions[l.from * 3], layout.cellPositions[l.from * 3 + 1], layout.cellPositions[l.from * 3 + 2]];
      const b = [layout.cellPositions[l.to * 3], layout.cellPositions[l.to * 3 + 1], layout.cellPositions[l.to * 3 + 2]];
      this.propagationLines.push(...a, ...b, 1, 0.2, 0.9, 0.8);
    }
  }

  render(canvas: HTMLCanvasElement) {
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const { yaw, pitch, dist, target } = this.camera;
    const eye: [number, number, number] = [
      target[0] + dist * Math.cos(pitch) * Math.cos(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.sin(yaw),
    ];
    const vp = mul(perspective(50 * Math.PI / 180, aspect, 0.05, 200), lookAt(eye, target));
    const cam = new Float32Array(20);
    cam.set(vp, 0); cam.set(eye, 16);
    this.device.queue.writeBuffer(this.camBuf, 0, cam);

    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const depth = this.device.createTexture({ size: [canvas.clientWidth, canvas.clientHeight], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0.07, g: 0.09, b: 0.12, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    const bg = this.device.createBindGroup({ layout: this.cellPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: { buffer: this.cellBuf } }] });
    pass.setPipeline(this.cellPipe);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.boxVerts);
    pass.setIndexBuffer(this.boxIdx, 'uint32');
    pass.drawIndexed(36, this.N);

    pass.setPipeline(this.hullPipe);
    const hbg = this.device.createBindGroup({ layout: this.hullPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: { buffer: this.cellBuf } }] });
    pass.setBindGroup(0, hbg);
    pass.setVertexBuffer(0, this.hullBuf);
    const hullCount = (this as unknown as { hullVertexCount: number }).hullVertexCount ?? 0;
    pass.draw(hullCount);

    const lineCount = (this as unknown as { lineCount: number }).lineCount ?? 0;
    if (lineCount > 0) {
      pass.setPipeline(this.linePipe);
      const lbg = this.device.createBindGroup({ layout: this.linePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: { buffer: this.lineBuf } }] });
      pass.setBindGroup(0, lbg);
      pass.draw(2, lineCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    depth.destroy();
  }

  dispose() { this.device.destroy(); }
}

const HULL_WGSL = /* wgsl */ `
struct Camera { viewProj: mat4x4<f32>, eye: vec3<f32>, pad: f32 };
@group(0) @binding(0) var<uniform> cam: Camera;
struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) normal: vec3<f32>, @location(1) alpha: f32 };
@vertex
fn vs(@location(0) pos: vec3<f32>, @location(1) normalAndAlpha: vec3<f32>) -> VSOut {
  var out: VSOut;
  out.clip = cam.viewProj * vec4<f32>(pos, 1.0);
  out.normal = normalAndAlpha;
  out.alpha = normalAndAlpha.z;
  return out;
}
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(0.75, 0.85, 0.95, in.alpha);
}
`;
