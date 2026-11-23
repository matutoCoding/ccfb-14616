// 舱体拓扑构建：电芯节点排布 + 相邻关系 + 分层材料热阻 + 液冷节点映射
// 节点编号：[0, cellCount) 为电芯节点，[cellCount, cellCount+moduleCount) 为模组外壳节点
import type { ProjectConfig } from './types';

export interface Topology {
  cellCount: number;
  moduleCount: number;
  rackCount: number;
  totalNodes: number;
  /** 每簇模组数 */
  modulesPerRack: number;
  cellsPerModule: number;
  // —— 电芯静态属性（长度 cellCount）——
  posX: Float64Array; posY: Float64Array; posZ: Float64Array;
  rackId: Int32Array;
  moduleId: Int32Array;
  /** 热容 C = m·cp  J/K */
  cap: Float64Array;
  /** 各方向接触电导 G W/K（已含隔热垫/胶/铝排并联路径） */
  gx: Float64Array;   // 串联方向 ±X
  gy: Float64Array;   // 并联方向 ±Y
  gShell: Float64Array; // 到模组外壳
  gCold: Float64Array;  // 到液冷板
  /** 邻居索引，-1 表示无 */
  neighbor: Int32Array; // 每行 4 个：-X,+X,-Y,+Y（扁平化 length = 4*N）
  /** 模组外壳节点编号 */
  shellNode: Int32Array;
  // —— 模组外壳属性（长度 moduleCount，索引从 0 开始，节点号 = cellCount + m）——
  shellCap: Float64Array;
  shellGAmbient: Float64Array;
  shellPos: Float64Array; // xyz*3
  moduleRack: Int32Array;
  /** 相邻模组外壳之间的电导（堆叠方向） */
  shellGNext: Float64Array;
  // —— 每簇/每模组在舱内的几何尺寸 ——
  rackOrigin: Float64Array; // rackCount*3
  moduleDims: [number, number, number];
  cellDims: [number, number, number];
  /** 全局电芯索引 -> 模组内序号 */
  indexInModule: Int32Array;
}

/** 分层串联热阻 R = Σ(δ/λ)，返回面积比热阻 m²·K/W */
function layerResistance(layers: { thickness: number; conductivity: number }[]): number {
  let r = 0;
  for (const l of layers) r += l.thickness / l.conductivity;
  return r;
}

export function buildTopology(cfg: ProjectConfig): Topology {
  const { cabin, layout, materials: mat, chem, overrides } = cfg;
  const racks = cabin.rackCount;
  const mpr = cabin.modulesPerRack;
  const nx = layout.cellsSeriesX;
  const ny = layout.cellsParallelY;
  const cpm = nx * ny;
  const moduleCount = racks * mpr;
  const cellCount = moduleCount * cpm;
  const totalNodes = cellCount + moduleCount;

  const posX = new Float64Array(cellCount), posY = new Float64Array(cellCount), posZ = new Float64Array(cellCount);
  const rackId = new Int32Array(cellCount), moduleId = new Int32Array(cellCount);
  const cap = new Float64Array(cellCount);
  const gx = new Float64Array(cellCount), gy = new Float64Array(cellCount);
  const gShell = new Float64Array(cellCount), gCold = new Float64Array(cellCount);
  const neighbor = new Int32Array(4 * cellCount).fill(-1);
  const shellNode = new Int32Array(cellCount);
  const indexInModule = new Int32Array(cellCount);

  const shellCap = new Float64Array(moduleCount);
  const shellGAmbient = new Float64Array(moduleCount);
  const shellPos = new Float64Array(3 * moduleCount);
  const moduleRack = new Int32Array(moduleCount);
  const shellGNext = new Float64Array(moduleCount);
  const rackOrigin = new Float64Array(3 * racks);

  const [cw, ct, ch] = chem.dims;
  const faceX = cw * ch;   // 串联接触面（大面 174×207）
  const faceY = ct * ch;   // 并联接触面（窄面 72×207）

  // 串联方向层状热阻（气凝胶可开关 + 导热胶），铝排走并联路径
  const stackLayers: { thickness: number; conductivity: number }[] = [];
  if (mat.aerogelEnabled) stackLayers.push(mat.aerogel);
  stackLayers.push(mat.thermalGlue);
  const rAreaStack = layerResistance(stackLayers); // m²K/W
  const rAreaGlue = layerResistance([mat.thermalGlue]);

  // 铝排并联电导：等效截面积 20 mm²，路径长度取电芯间距
  const busArea = 20e-6;
  const pitchX = ct + (mat.aerogelEnabled ? mat.aerogel.thickness : 0) + mat.cellGap;
  const gBusbar = mat.busbar.conductivity * busArea / Math.max(pitchX, 1e-4);

  // 外壳、液冷板面积比热阻
  // 电芯到模组外壳：30% 侧面积有效接触，路径含 2mm 空气间隙（λ≈0.026）+ 钢板
  const rAreaShell = 0.002 / 0.026 + mat.shellThickness / mat.shellConductivity;
  const rAreaCold = layerResistance([mat.thermalGlue, { thickness: mat.coldPlateThickness, conductivity: mat.coldPlateConductivity }]);

  // —— 舱内布局：簇沿舱长方向排列，模组在簇内竖直堆叠 ——
  const [mL, mW, mH] = layout.moduleDims;
  const gapRack = 0.9;
  const totalRackLen = racks * mL + (racks - 1) * gapRack;
  const startX = (cabin.dims[0] - totalRackLen) / 2;

  for (let r = 0; r < racks; r++) {
    const ox = startX + r * (mL + gapRack);
    const oy = (cabin.dims[1] - mW) / 2;
    rackOrigin.set([ox, oy, 0.15], r * 3);
    for (let m = 0; m < mpr; m++) {
      const mid = r * mpr + m;
      const oz = 0.15 + m * (mH + 0.03);
      moduleRack[mid] = r;
      shellPos.set([ox + mL / 2, oy + mW / 2, oz + mH / 2], mid * 3);
      // 外壳热容：钢板表面积 × 厚度 × 密度7850 × 比热475
      const surf = 2 * (mL * mW + mL * mH + mW * mH);
      shellCap[mid] = surf * mat.shellThickness * 7850 * 475;
      shellGAmbient[mid] = cabin.ambientH * surf * 0.25; // 模组外表面只有部分直接对舱内空气
      if (m < mpr - 1) shellGNext[mid] = mat.shellConductivity * (mW * mH * 0.5) / (0.03 + 2 * mat.shellThickness);

      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const local = iy * nx + ix;
          const idx = mid * cpm + local;
          indexInModule[idx] = local;
          rackId[idx] = r;
          moduleId[idx] = mid;
          shellNode[idx] = cellCount + mid;
          // 电芯在模组内的位置（留边距 15mm）
          const px = ox + 0.015 + (ix + 0.5) * pitchX;
          const py = oy + 0.015 + (iy + 0.5) * (cw + 0.002);
          const pz = oz + mH / 2;
          posX[idx] = px; posY[idx] = py; posZ[idx] = pz;

          const ov = overrides[idx];
          const kScale = ov?.conductivityScale ?? 1;
          const mScale = ov?.massScale ?? 1;
          const cScale = ov?.specificHeatScale ?? 1;
          cap[idx] = chem.mass * mScale * chem.specificHeat * cScale;

          // 串联面电导 = 接触面积 / 面积比热阻 + 铝排并联
          gx[idx] = kScale * (faceX / rAreaStack + gBusbar);
          gy[idx] = kScale * (faceY / rAreaGlue);
          // 到外壳：G = 有效接触面积(30%侧面) / 面积比热阻（空气间隙+钢板）
          const shellContactArea = 2 * (ct + cw) * ch * 0.3;
          gShell[idx] = kScale * shellContactArea / rAreaShell;
          gCold[idx] = kScale * mat.coldPlateAreaPerCell / rAreaCold;

          // 邻居（全局索引）
          if (ix > 0) neighbor[4 * idx + 0] = idx - 1;
          if (ix < nx - 1) neighbor[4 * idx + 1] = idx + 1;
          if (iy > 0) neighbor[4 * idx + 2] = idx - nx;
          if (iy < ny - 1) neighbor[4 * idx + 3] = idx + nx;
        }
      }
    }
  }

  return {
    cellCount, moduleCount, rackCount: racks, totalNodes,
    modulesPerRack: mpr, cellsPerModule: cpm,
    posX, posY, posZ, rackId, moduleId, cap, gx, gy, gShell, gCold,
    neighbor, shellNode, shellCap, shellGAmbient, shellPos, moduleRack, shellGNext,
    rackOrigin, moduleDims: layout.moduleDims, cellDims: chem.dims, indexInModule,
  };
}

/** 给定全局电芯索引，返回舱内坐标（3D 点选/高亮复用） */
export function cellPosition(topo: Topology, idx: number): [number, number, number] {
  return [topo.posX[idx], topo.posY[idx], topo.posZ[idx]];
}
