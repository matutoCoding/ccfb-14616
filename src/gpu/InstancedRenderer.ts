import type { PropagationEvent, Vec3 } from '../types';

export interface RenderCell {
  position: Vec3;
  dimensionsMm: Vec3;
}

export interface RenderBox {
  min: Vec3;
  max: Vec3;
  color: [number, number, number, number];
}

export interface RenderFrameLike {
  temperaturesDeciC: Uint16Array;
  states: Uint8Array;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dot(a: Vec3, b: Vec3) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far * nf;
  out[11] = -1;
  out[14] = near * far * nf;
  out[15] = 0;
  return out;
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  const z = normalize({ x: eye.x - target.x, y: eye.y - target.y, z: eye.z - target.z });
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x.x; out[1] = y.x; out[2] = z.x; out[3] = 0;
  out[4] = x.y; out[5] = y.y; out[6] = z.y; out[7] = 0;
  out[8] = x.z; out[9] = y.z; out[10] = z.z; out[11] = 0;
  out[12] = -dot(x, eye); out[13] = -dot(y, eye); out[14] = -dot(z, eye); out[15] = 1;
  return out;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

const CUBE_VERTICES = new Float32Array([
  // pos xyz      normal xyz
  -0.5,-0.5,-0.5, 0,0,-1,  0.5,-0.5,-0.5, 0,0,-1,  0.5, 0.5,-0.5, 0,0,-1, -0.5, 0.5,-0.5, 0,0,-1,
  -0.5,-0.5, 0.5, 0,0, 1,  0.5,-0.5, 0.5, 0,0, 1,  0.5, 0.5, 0.5, 0,0, 1, -0.5, 0.5, 0.5, 0,0, 1,
  -0.5,-0.5,-0.5,-1,0,0, -0.5, 0.5,-0.5,-1,0,0, -0.5, 0.5, 0.5,-1,0,0, -0.5,-0.5, 0.5,-1,0,0,
   0.5,-0.5,-0.5, 1,0,0,  0.5, 0.5,-0.5, 1,0,0,  0.5, 0.5, 0.5, 1,0,0,  0.5,-0.5, 0.5, 1,0,0,
  -0.5,-0.5,-0.5, 0,-1,0, -0.5,-0.5, 0.5, 0,-1,0,  0.5,-0.5, 0.5, 0,-1,0,  0.5,-0.5,-0.5, 0,-1,0,
  -0.5, 0.5,-0.5, 0, 1,0, -0.5, 0.5, 0.5, 0, 1,0,  0.5, 0.5, 0.5, 0, 1,0,  0.5, 0.5,-0.5, 0, 1,0,
]);
const CUBE_INDICES = new Uint16Array([
  0,1,2, 0,2,3, 4,5,6, 4,6,7, 8,9,10, 8,10,11,
  12,13,14, 12,14,15, 16,17,18, 16,18,19, 20,21,22, 20,22,23,
]);

const SOLID_SHADER = /* wgsl */`
struct U { mvp: mat4x4<f32>; clip: vec4f; }
@group(0) @binding(0) var<uniform> u: U;
struct In {
  @location(0) pos: vec3f, @location(1) normal: vec3f,
  @location(2) iCenter: vec3f, @location(3) iScale: vec3f, @location(4) iColor: vec4f,
}
struct Out { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) world: vec3f, @location(2) normal: vec3f }
@vertex fn vs(in: In) -> Out {
  var o: Out;
  let world = in.iCenter + in.pos * in.iScale;
  o.pos = u.mvp * vec4f(world, 1);
  o.world = world; o.normal = in.normal; o.color = in.iColor;
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  if (u.clip.y > 0.5 && in.world.x > u.clip.x) { discard; }
  let light = 0.58 + 0.42 * max(dot(normalize(in.normal), normalize(vec3f(-0.4, 0.9, 0.35))), 0.0);
  return vec4f(in.color.rgb * light, in.color.a * u.clip.z);
}`;

const LINE_SHADER = /* wgsl */`
struct U { mvp: mat4x4<f32>; clip: vec4f; }
@group(0) @binding(0) var<uniform> u: U;
struct In { @location(0) pos: vec3f; @location(1) color: vec4f; }
struct Out { @builtin(position) pos: vec4f; @location(0) color: vec4f; @location(1) world: vec3f; }
@vertex fn vs(in: In) -> Out {
  var o: Out; o.pos = u.mvp * vec4f(in.pos,1); o.color=in.color; o.world=in.pos; return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  if (u.clip.y > 0.5 && in.world.x > u.clip.x) { discard; }
  return in.color;
}`;

export function temperatureColor(tempC: number, state = 0): [number, number, number, number] {
  if (state === 3) return [0.24, 0.05, 0.04, 1];
  const stops: Array<[number, [number, number, number]]> = [
    [25, [0.10, 0.25, 0.85]],
    [45, [0.08, 0.72, 0.43]],
    [75, [0.95, 0.86, 0.20]],
    [125, [0.98, 0.48, 0.08]],
    [170, [0.93, 0.16, 0.12]],
    [650, [0.55, 0.03, 0.05]],
  ];
  if (tempC <= stops[0][0]) return [...stops[0][1], 1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]; const [t1, c1] = stops[i + 1];
    if (tempC <= t1) {
      const a = (tempC - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * a, c0[1] + (c1[1] - c0[1]) * a, c0[2] + (c1[2] - c0[2]) * a, 1];
    }
  }
  return [0.35, 0.0, 0.02, 1];
}

export class InstancedRenderer {
  private raf = 0;
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private cellPipeline: GPURenderPipeline;
  private boxPipeline: GPURenderPipeline;
  private linePipeline: GPURenderPipeline;
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private cellInstanceBuffer: GPUBuffer;
  private boxInstanceBuffer: GPUBuffer;
  private boxCount: number;
  private edgeBuffer: GPUBuffer;
  private edgeVertexCount: number;
  private overlayBuffer: GPUBuffer;
  private overlayCapacityVertices: number;
  private overlayVertexCount = 0;
  private uniformBuffer: GPUBuffer;
  private cellBindGroup: GPUBindGroup;
  private boxBindGroup: GPUBindGroup;
  private lineBindGroup: GPUBindGroup;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private resizeObserver: ResizeObserver;
  private destroyed = false;

  private yaw = -0.72;
  private pitch = 0.42;
  private distance = 16;
  private target: Vec3 = { x: 0, y: 1.05, z: 0 };
  private dragging: { x: number; y: number } | null = null;
  private viewProj: Float32Array = new Float32Array(16);
  private width = 800;
  private height = 600;

  public clipX = 0;
  public clipEnabled = false;
  public cabinOpacity = 0.9;
  public showVents = true;
  private frame: RenderFrameLike | null = null;
  private frameIndex = 0;
  private events: PropagationEvent[] = [];
  private viewTimeS = 0;

  private constructor(
    private canvas: HTMLCanvasElement,
    private cells: RenderCell[],
    boxes: RenderBox[],
    device: GPUDevice,
  ) {
    this.device = device;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('无法取得 WebGPU canvas context');
    this.context = ctx;
    this.format = navigator.gpu!.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'premultiplied' });

    const shader = device.createShaderModule({ code: SOLID_SHADER });
    const lineShader = device.createShaderModule({ code: LINE_SHADER });
    this.uniformBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
      ],
    };
    const instanceLayout: GPUVertexBufferLayout = {
      arrayStride: 48,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 2, offset: 0, format: 'float32x3' },
        { shaderLocation: 3, offset: 16, format: 'float32x3' },
        { shaderLocation: 4, offset: 32, format: 'float32x4' },
      ],
    };
    const pipelineDesc: GPURenderPipelineDescriptor = {
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [vertexLayout, instanceLayout] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    };
    this.cellPipeline = device.createRenderPipeline(pipelineDesc);
    this.boxPipeline = device.createRenderPipeline({
      ...pipelineDesc,
      fragment: {
        module: shader, entryPoint: 'fs',
        targets: [{ format: this.format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        } }],
      },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.linePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: lineShader, entryPoint: 'vs',
        buffers: [{
          arrayStride: 28,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }],
        }],
      },
      fragment: { module: lineShader, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'line-list' },
    });

    this.vertexBuffer = device.createBuffer({ size: CUBE_VERTICES.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, CUBE_VERTICES);
    this.indexBuffer = device.createBuffer({ size: CUBE_INDICES.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, CUBE_INDICES);

    this.cellInstanceBuffer = device.createBuffer({ size: Math.max(48, cells.length * 48), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const initial = new Float32Array(cells.length * 12);
    cells.forEach((cell, i) => {
      initial[i * 12] = cell.position.x; initial[i * 12 + 1] = cell.position.y; initial[i * 12 + 2] = cell.position.z;
      initial[i * 12 + 4] = cell.dimensionsMm.x / 1000;
      initial[i * 12 + 5] = cell.dimensionsMm.y / 1000;
      initial[i * 12 + 6] = cell.dimensionsMm.z / 1000;
      const col = temperatureColor(25);
      initial[i * 12 + 8] = col[0]; initial[i * 12 + 9] = col[1]; initial[i * 12 + 10] = col[2]; initial[i * 12 + 11] = 1;
    });
    // Convert compact 12-float layout to 48-byte stride with padding.
    const instanceBytes = new ArrayBuffer(cells.length * 48);
    const iv = new Float32Array(instanceBytes);
    for (let i = 0; i < cells.length; i++) {
      iv.set(initial.subarray(i * 12, i * 12 + 3), i * 12);
      iv.set(initial.subarray(i * 12 + 4, i * 12 + 8), i * 12 + 4);
      iv.set(initial.subarray(i * 12 + 8, i * 12 + 12), i * 12 + 8);
    }
    device.queue.writeBuffer(this.cellInstanceBuffer, 0, instanceBytes);

    this.boxCount = boxes.length;
    this.boxInstanceBuffer = device.createBuffer({ size: Math.max(48, boxes.length * 48), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const boxBytes = new ArrayBuffer(Math.max(48, boxes.length * 48));
    const bv = new Float32Array(boxBytes);
    boxes.forEach((b, i) => {
      const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
      bv[i * 12] = cx; bv[i * 12 + 1] = cy; bv[i * 12 + 2] = cz;
      bv[i * 12 + 4] = b.max.x - b.min.x; bv[i * 12 + 5] = b.max.y - b.min.y; bv[i * 12 + 6] = b.max.z - b.min.z;
      bv[i * 12 + 8] = b.color[0]; bv[i * 12 + 9] = b.color[1]; bv[i * 12 + 10] = b.color[2]; bv[i * 12 + 11] = b.color[3];
    });
    device.queue.writeBuffer(this.boxInstanceBuffer, 0, boxBytes);

    const edgeVertices = buildBoxEdges(boxes);
    this.edgeVertexCount = edgeVertices.length / 7;
    this.edgeBuffer = device.createBuffer({ size: Math.max(28, edgeVertices.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.edgeBuffer, 0, edgeVertices.buffer as ArrayBuffer, edgeVertices.byteOffset, edgeVertices.byteLength);

    this.overlayCapacityVertices = Math.max(64, cells.length * 4 + 64);
    this.overlayBuffer = device.createBuffer({ size: this.overlayCapacityVertices * 28, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

    this.cellBindGroup = device.createBindGroup({ layout: this.cellPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] });
    this.boxBindGroup = device.createBindGroup({ layout: this.boxPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] });
    this.lineBindGroup = device.createBindGroup({ layout: this.linePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] });

    const xs = cells.map((c) => c.position.x);
    const zs = cells.map((c) => c.position.z);
    if (xs.length) {
      const span = Math.max(...xs) - Math.min(...xs, 0);
      this.distance = Math.max(13, span * 0.72 + 5);
      this.target.x = (Math.max(...xs) + Math.min(...xs)) / 2;
      this.target.z = (Math.max(...zs) + Math.min(...zs)) / 2;
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.resize();
    this.loop();
  }

  static async create(canvas: HTMLCanvasElement, cells: RenderCell[], boxes: RenderBox[]): Promise<InstancedRenderer | null> {
    if (!navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      return new InstancedRenderer(canvas, cells, boxes, device);
    } catch (error) {
      console.warn('WebGPU 渲染器初始化失败', error);
      return null;
    }
  }

  setFrame(frame: RenderFrameLike, frameIndex: number, events: PropagationEvent[], timeS: number) {
    this.frame = frame;
    this.frameIndex = frameIndex;
    this.events = events;
    this.viewTimeS = timeS;
    this.updateCellColors();
    this.updateOverlay();
  }

  setViewTime(timeS: number) {
    this.viewTimeS = timeS;
    this.updateOverlay();
  }

  private updateCellColors() {
    if (!this.frame) return;
    const count = this.cells.length;
    const bytes = new ArrayBuffer(count * 48);
    const f32 = new Float32Array(bytes);
    // Preserve center/scale by reading existing CPU cell geometry.
    this.cells.forEach((cell, i) => {
      f32[i * 12] = cell.position.x; f32[i * 12 + 1] = cell.position.y; f32[i * 12 + 2] = cell.position.z;
      f32[i * 12 + 4] = cell.dimensionsMm.x / 1000;
      f32[i * 12 + 5] = cell.dimensionsMm.y / 1000;
      f32[i * 12 + 6] = cell.dimensionsMm.z / 1000;
      const idx = this.frameIndex * count + i;
      const tempC = this.frame!.temperaturesDeciC[idx] / 10;
      const state = this.frame!.states[idx];
      const col = temperatureColor(tempC, state);
      f32[i * 12 + 8] = col[0]; f32[i * 12 + 9] = col[1]; f32[i * 12 + 10] = col[2]; f32[i * 12 + 11] = col[3];
    });
    this.device.queue.writeBuffer(this.cellInstanceBuffer, 0, bytes);
  }

  private addLine(data: number[], a: Vec3, b: Vec3, color: [number, number, number, number]) {
    data.push(a.x, a.y, a.z, ...color, b.x, b.y, b.z, ...color);
  }

  private updateOverlay() {
    const lines: number[] = [];
    const visibleEvents = this.events.filter((e) => e.timeS <= this.viewTimeS + 0.001);
    const byId = new Map(this.cells.map((_, i) => [`cell-${i + 1}`, i]));
    const viaColor: Record<string, [number, number, number, number]> = {
      trigger: [1, 1, 1, 0.95],
      'intra-module': [0.2, 0.75, 1, 0.95],
      'cross-module': [1, 0.62, 0.1, 0.95],
      'cross-cluster': [1, 0.16, 0.12, 1],
    };
    for (const e of visibleEvents) {
      if (e.fromCellId) {
        const fromIdx = byId.get(e.fromCellId);
        if (fromIdx !== undefined) {
          const from = this.cells[fromIdx].position;
          this.addLine(lines, { x: from.x, y: from.y + 0.16, z: from.z }, { x: e.position.x, y: e.position.y + 0.16, z: e.position.z }, viaColor[e.via ?? 'intra-module']);
        }
      }
      if (this.showVents && this.viewTimeS >= e.timeS && this.viewTimeS <= e.timeS + 55) {
        const cell = this.cells[e.cellIndex];
        if (cell) {
          const remain = 1 - (this.viewTimeS - e.timeS) / 55;
          const top = { x: cell.position.x, y: cell.position.y + cell.dimensionsMm.y / 2000, z: cell.position.z };
          const len = 0.55 + 1.1 * Math.max(0.15, remain);
          this.addLine(lines, top, { x: top.x + 0.12, y: top.y + len, z: top.z + 0.05 }, [1, 0.45 + 0.4 * remain, 0.05, 0.25 + 0.7 * remain]);
          this.addLine(lines, top, { x: top.x - 0.1, y: top.y + len * 0.82, z: top.z - 0.08 }, [1, 0.82, 0.15, 0.2 + 0.55 * remain]);
        }
      }
    }
    const maxFloats = this.overlayCapacityVertices * 7;
    const trimmed = lines.slice(0, maxFloats);
    this.overlayVertexCount = trimmed.length / 7;
    if (trimmed.length) {
      const data = new Float32Array(trimmed);
      this.device.queue.writeBuffer(this.overlayBuffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    this.yaw += dx * 0.008;
    this.pitch = Math.max(0.08, Math.min(1.35, this.pitch + dy * 0.006));
    this.dragging = { x: e.clientX, y: e.clientY };
  };
  private onPointerUp = () => { this.dragging = null; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.distance = Math.max(3, Math.min(90, this.distance * (1 + Math.sign(e.deltaY) * 0.08)));
  };

  /** Screen-space center picking; dense instances choose the nearest cell. */
  pickCell(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best: number | null = null;
    let bestDist = 18;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i].position;
      const clip = [
        this.viewProj[0] * c.x + this.viewProj[4] * c.y + this.viewProj[8] * c.z + this.viewProj[12],
        this.viewProj[1] * c.x + this.viewProj[5] * c.y + this.viewProj[9] * c.z + this.viewProj[13],
        this.viewProj[3] * c.x + this.viewProj[7] * c.y + this.viewProj[11] * c.z + this.viewProj[15],
      ];
      const w = clip[2] || 1;
      const sx = (clip[0] / w * 0.5 + 0.5) * rect.width;
      const sy = (-clip[1] / w * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  private updateCamera() {
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const eye: Vec3 = {
      x: this.target.x + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      y: this.target.y + this.distance * Math.sin(this.pitch),
      z: this.target.z + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
    };
    const proj = perspective((48 * Math.PI) / 180, aspect, 0.05, 220);
    const view = lookAt(eye, this.target, { x: 0, y: 1, z: 0 });
    this.viewProj = multiply(proj, view);
    const uniforms = new Float32Array(20);
    uniforms.set(this.viewProj, 0);
    uniforms[16] = this.clipX;
    uniforms[17] = this.clipEnabled ? 1 : 0;
    uniforms[18] = this.cabinOpacity;
    uniforms[19] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
  }

  private loop = () => {
    if (this.destroyed) return;
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private render() {
    if (!this.depthView) return;
    this.updateCamera();
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view, clearValue: { r: 0.02, g: 0.045, b: 0.09, a: 1 }, loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(this.cellPipeline);
    pass.setBindGroup(0, this.cellBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setVertexBuffer(1, this.cellInstanceBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.drawIndexed(CUBE_INDICES.length, this.cells.length);

    if (this.boxCount) {
      pass.setPipeline(this.boxPipeline);
      pass.setBindGroup(0, this.boxBindGroup);
      pass.setVertexBuffer(1, this.boxInstanceBuffer);
      pass.drawIndexed(CUBE_INDICES.length, this.boxCount);
    }

    pass.setPipeline(this.linePipeline);
    pass.setBindGroup(0, this.lineBindGroup);
    if (this.edgeVertexCount) {
      pass.setVertexBuffer(0, this.edgeBuffer);
      pass.draw(this.edgeVertexCount);
    }
    if (this.overlayVertexCount) {
      pass.setVertexBuffer(0, this.overlayBuffer);
      pass.draw(this.overlayVertexCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.depthTexture?.destroy();
    this.vertexBuffer.destroy(); this.indexBuffer.destroy(); this.cellInstanceBuffer.destroy();
    this.boxInstanceBuffer.destroy(); this.edgeBuffer.destroy(); this.overlayBuffer.destroy(); this.uniformBuffer.destroy();
  }
}

function buildBoxEdges(boxes: RenderBox[]): Float32Array {
  const data: number[] = [];
  const color: [number, number, number, number] = [0.55, 0.72, 0.95, 0.55];
  for (const b of boxes) {
    const p = [
      { x: b.min.x, y: b.min.y, z: b.min.z }, { x: b.max.x, y: b.min.y, z: b.min.z },
      { x: b.max.x, y: b.min.y, z: b.max.z }, { x: b.min.x, y: b.min.y, z: b.max.z },
      { x: b.min.x, y: b.max.y, z: b.min.z }, { x: b.max.x, y: b.max.y, z: b.min.z },
      { x: b.max.x, y: b.max.y, z: b.max.z }, { x: b.min.x, y: b.max.y, z: b.max.z },
    ];
    const pairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [aIndex, bIndex] of pairs) {
      const aPoint = p[aIndex];
      const bPoint = p[bIndex];
      data.push(aPoint.x, aPoint.y, aPoint.z, ...color, bPoint.x, bPoint.y, bPoint.z, ...color);
    }
  }
  return new Float32Array(data);
}
