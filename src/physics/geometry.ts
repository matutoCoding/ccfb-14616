import type { BuildResult, ProjectConfig } from '../types';
import { MATERIAL_CONDUCTIVITY, CELL_EMISSIVITY, VIEW_FACTOR } from './constants';

/** 集装箱内部净尺寸 m (x=长, y=高, z=宽) */
export const CONTAINER_DIMS: Record<'20ft' | '40ft', { x: number; y: number; z: number }> = {
  '20ft': { x: 5.9, y: 2.39, z: 2.35 },
  '40ft': { x: 12.03, y: 2.39, z: 2.35 },
};

export interface ModuleGeom {
  index: number;
  cluster: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** 模组内电芯起始坐标 */
  originX: number; originY: number; originZ: number;
}

export interface EquipmentBox {
  name: string;
  kind: 'hvBox' | 'hvac' | 'pipe' | 'cabinet';
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/** 电芯沿 x 向的层间总间隙(实体夹层厚度之和,全 0 时退回空气隙) */
export function gapX(cfg: ProjectConfig): number {
  const il = cfg.cluster.interlayers;
  const solid = il.aerogelPad.thickness + il.aluminumBar.thickness + il.thermalGlue.thickness;
  return solid > 0 ? solid : il.cellGap;
}

export function buildLayout(cfg: ProjectConfig): BuildResult & { modules: ModuleGeom[]; equipment: EquipmentBox[]; moduleDims: { sx: number; sy: number; sz: number } } {
  const room = CONTAINER_DIMS[cfg.container];
  const { cellsX, cellsZ, wallThickness } = cfg.cluster.moduleLayout;
  const cw = cfg.cell.width, ch = cfg.cell.height, cd = cfg.cell.depth;
  const gx = gapX(cfg);
  const gz = Math.max(cfg.cluster.interlayers.cellGap, 0.001);

  const innerX = cellsX * cw + (cellsX - 1) * gx;
  const innerZ = cellsZ * cd + (cellsZ - 1) * gz;
  const sx = innerX + 2 * wallThickness;
  const sy = ch + 0.05;
  const sz = innerZ + 2 * wallThickness;
  const stackGap = 0.025;
  const clusterH = cfg.cluster.modulesPerCluster * (sy + stackGap) + 0.18;
  const cabinetFrame = 0.06;
  const clusterW = sx + cabinetFrame;
  const clusterD = sz + 0.08;

  const nClusters = cfg.clusterCount;
  const usableX = room.x - 0.6; // 两端留检修/电气空间
  const pitchX = nClusters > 1 ? usableX / nClusters : 0;
  const clusterCX: number[] = [];
  for (let i = 0; i < nClusters; i++) {
    clusterCX.push(nClusters === 1 ? room.x / 2 : 0.4 + pitchX * (i + 0.5));
  }
  // 单排靠墙,留出侧向检修通道
  const clusterCZ = room.z * 0.62;

  const cellsPerModule = cellsX * cellsZ;
  const moduleCount = nClusters * cfg.cluster.modulesPerCluster;
  const cellCount = moduleCount * cellsPerModule;

  const cellPositions = new Float32Array(cellCount * 3);
  const cellModule = new Uint32Array(cellCount);
  const cellBranch = new Uint32Array(cellCount);
  const cellPlateOrder = new Uint32Array(cellCount);
  const moduleBoxes = new Float32Array(moduleCount * 6);
  const moduleCluster = new Uint32Array(moduleCount);
  const modules: ModuleGeom[] = [];
  const equipment: EquipmentBox[] = [];

  for (let c = 0; c < nClusters; c++) {
    const cabMinX = clusterCX[c] - clusterW / 2;
    const cabMaxX = clusterCX[c] + clusterW / 2;
    equipment.push({
      name: `簇#${c + 1}柜体`, kind: 'cabinet',
      minX: cabMinX, minY: 0.05, minZ: clusterCZ - clusterD / 2,
      maxX: cabMaxX, maxY: 0.05 + clusterH, maxZ: clusterCZ + clusterD / 2,
    });
    for (let s = 0; s < cfg.cluster.modulesPerCluster; s++) {
      const m = c * cfg.cluster.modulesPerCluster + s;
      const minY = 0.14 + s * (sy + stackGap);
      const minX = clusterCX[c] - sx / 2;
      const minZ = clusterCZ - sz / 2;
      const maxX = minX + sx, maxY = minY + sy, maxZ = minZ + sz;
      modules.push({ index: m, cluster: c, minX, minY, minZ, maxX, maxY, maxZ,
        originX: minX + wallThickness, originY: minY + 0.03, originZ: minZ + wallThickness });
      moduleBoxes.set([minX, minY, minZ, maxX, maxY, maxZ], m * 6);
      moduleCluster[m] = c;
      for (let iz = 0; iz < cellsZ; iz++) {
        for (let ix = 0; ix < cellsX; ix++) {
          const local = iz * cellsX + ix;
          const gi = m * cellsPerModule + local;
          const px = minX + wallThickness + ix * (cw + gx) + cw / 2;
          const py = minY + 0.03 + ch / 2;
          const pz = minZ + wallThickness + iz * (cd + gz) + cd / 2;
          cellPositions.set([px, py, pz], gi * 3);
          cellModule[gi] = m;
          cellBranch[gi] = c;
          cellPlateOrder[gi] = s;
        }
      }
    }
    // 每簇顶部高压箱
    const topY = 0.05 + clusterH;
    equipment.push({
      name: `簇#${c + 1}高压箱`, kind: 'hvBox',
      minX: cabMinX + 0.02, minY: topY, minZ: clusterCZ - clusterD / 2 + 0.02,
      maxX: cabMaxX - 0.02, maxY: topY + 0.22, maxZ: clusterCZ + clusterD / 2 - 0.02,
    });
  }

  // 液冷主管路(靠墙一侧)
  const pipeZ = room.z - 0.12;
  equipment.push({
    name: '液冷主管', kind: 'pipe',
    minX: 0.2, minY: 2.18, minZ: pipeZ - 0.03,
    maxX: room.x - 0.2, maxY: 2.24, maxZ: pipeZ + 0.03,
  });
  // 空调室内机(端墙顶部)
  equipment.push({
    name: '空调室内机', kind: 'hvac',
    minX: 0.05, minY: room.y - 0.45, minZ: room.z - 0.7,
    maxX: 0.55, maxY: room.y - 0.1, maxZ: room.z - 0.1,
  });

  return {
    cellCount, moduleCount, cellPositions, cellModule, moduleBoxes, moduleCluster,
    clusterPositions: clusterCX.map((x) => ({ x, y: 0.05 + clusterH / 2, z: clusterCZ })),
    roomSize: room, cellBranch, cellPlateOrder, modules, equipment,
    moduleDims: { sx, sy, sz },
  };
}

/** 热网络:所有热阻在 CPU 侧按接触面积+材料算好,TS 与 WGSL 共用 */
export interface ThermalNetwork {
  N: number; M: number; nodeCount: number;
  cellsPerModule: number;
  cellsX: number; cellsZ: number;
  cellC: Float32Array;              // 电芯热容 J/K
  cellContactK: Float32Array;       // 单颗电芯覆盖的接触导热 W/(m·K),NaN=用全局夹层
  shellC: Float32Array;             // 每模组外壳热容
  plateC: Float32Array;             // 每模组冷板热容
  gCellPairX: number;               // x 向相邻电芯导热 W/K(夹层,全局缺省)
  gCellPairZ: number;               // z 向(空气隙)
  gxGap: number;                    // x 向层间总厚度 m
  gxEffK: number;                   // x 向层间等效串联导热系数 W/(m·K)
  gCellShell: number;               // 电芯->外壳(侧隙空气+壁)
  gCellPlate: number;               // 电芯->冷板(导热胶+半板厚)
  gShellAmb: Float32Array;          // 外壳->舱内空气
  gPlateFluid: number;              // 冷板->工质 对流
  faceAreaX: number;                // x 向接触面积
  branchCount: number;
  platesPerBranch: number;
  mDotCp: number;                   // 单支路流量热容 W/K
  enableRadiation: boolean;
  radCoeffX: number;                // x 面辐射系数 eps*F*A*sigma
  radCoeffZ: number;                // z 面
  dtCrit: number;                   // 显式积分稳定上限(含安全系数)
}

const RHO_AL = 2700, CP_AL = 900;

export function buildNetwork(cfg: ProjectConfig, layout: ReturnType<typeof buildLayout>): ThermalNetwork {
  const { cellsX, cellsZ } = cfg.cluster.moduleLayout;
  const N = layout.cellCount, M = layout.moduleCount;
  const cw = cfg.cell.width, ch = cfg.cell.height, cd = cfg.cell.depth;
  const faceAreaX = ch * cd;                 // x 向贴合面
  const faceAreaZ = cw * ch;
  const bottomArea = cw * cd;

  const il = cfg.cluster.interlayers;
  const gx = gapX(cfg);
  // 串联热阻:隔热垫/铝排/导热胶
  const rSolid = il.aerogelPad.thickness / Math.max(il.aerogelPad.conductivity, 1e-6)
    + il.aluminumBar.thickness / Math.max(il.aluminumBar.conductivity, 1e-6)
    + il.thermalGlue.thickness / Math.max(il.thermalGlue.conductivity, 1e-6);
  const rGapX = rSolid > 0 ? rSolid : gx / MATERIAL_CONDUCTIVITY.air;
  const gCellPairX = faceAreaX / rGapX;
  const gxEffK = gx / rGapX;
  const gz = Math.max(il.cellGap, 0.001);
  const gCellPairZ = faceAreaZ / (gz / MATERIAL_CONDUCTIVITY.air);

  const ml = cfg.cluster.moduleLayout;
  // 电芯 -> 模组外壳:侧隙空气(5mm)+ 壁导热
  const sideGap = 0.005;
  const rShell = sideGap / MATERIAL_CONDUCTIVITY.air / faceAreaZ + ml.wallThickness / ml.wallConductivity / faceAreaZ;
  const gCellShell = 1 / rShell;
  // 电芯 -> 冷板:导热胶 + 半块冷板
  const rPlate = ml.glueBetweenCellAndPlate.thickness / ml.glueBetweenCellAndPlate.conductivity / bottomArea
    + 0.5 * ml.coldPlateThickness / ml.coldPlateConductivity / bottomArea;
  const gCellPlate = 1 / rPlate;

  const cellC = new Float32Array(N);
  const cellContactK = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    const spec = { ...cfg.cell, ...(cfg.cellOverrides[i] ?? {}) };
    cellC[i] = spec.mass * spec.specificHeat;
    const ov = cfg.cellOverrides[i] as { contactK?: number } | undefined;
    if (ov?.contactK !== undefined) cellContactK[i] = ov.contactK;
  }

  const { sx, sy, sz } = layout.moduleDims;
  const shellArea = 2 * (sx * sy + sx * sz + sy * sz);
  const shellMass = shellArea * ml.wallThickness * RHO_AL;
  const shellC = new Float32Array(M).fill(shellMass * CP_AL);
  const plateMass = bottomArea * ml.coldPlateThickness * RHO_AL * cellsX * cellsZ;
  const plateC = new Float32Array(M).fill(plateMass * CP_AL);
  const gShellAmb = new Float32Array(M).fill(cfg.hvac.airConvectionH * shellArea);

  // 冷板-工质:按每颗电芯分摊 0.02m2 有效换热面、h=800 W/m2K 估算
  const gPlateFluid = 800 * bottomArea * cellsX * cellsZ;

  const flowKgS = cfg.cooling.flowLpm / 60 * cfg.cooling.fluidDensity / Math.max(1, cfg.clusterCount);
  const mDotCp = flowKgS * cfg.cooling.fluidCp;

  const enableRadiation = true;
  const radCoeffX = CELL_EMISSIVITY * VIEW_FACTOR * faceAreaX * 5.670374419e-8;
  const radCoeffZ = CELL_EMISSIVITY * VIEW_FACTOR * faceAreaZ * 5.670374419e-8;

  // 显式欧拉稳定判据:dt <= C / ΣG,取全网最小值 * 0.4 安全系数
  const sumGCell = 2 * gCellPairX + 2 * gCellPairZ + gCellShell + gCellPlate;
  const dtCell = Math.min(...cellC) / sumGCell;
  const dtShell = shellC[0] / (gShellAmb[0] + cellsX * cellsZ * gCellShell);
  const dtPlate = plateC[0] / (gPlateFluid + cellsX * cellsZ * gCellPlate);
  const dtCrit = 0.4 * Math.min(dtCell, dtShell, dtPlate, 2.0);

  return {
    N, M, nodeCount: N + 3 * M, cellsPerModule: cellsX * cellsZ,
    cellsX, cellsZ, cellC, cellContactK, shellC, plateC,
    gCellPairX, gCellPairZ, gxGap: gx, gxEffK, gCellShell, gCellPlate, gShellAmb, gPlateFluid,
    faceAreaX, branchCount: cfg.clusterCount, platesPerBranch: cfg.cluster.modulesPerCluster,
    mDotCp, enableRadiation, radCoeffX, radCoeffZ, dtCrit,
  };
}
