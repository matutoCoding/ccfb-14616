import type {
  CabinConfig,
  CellSpec,
  Scheme,
  Vec3,
} from '../types';

export type NodeKind = 'cell' | 'shell' | 'plate' | 'coolant' | 'fixed';

export interface GraphEdge {
  a: number;
  b: number;
  conductance: number; // W/K
  kind: 'cell-cell' | 'cell-shell' | 'cell-plate' | 'plate-coolant' | 'shell-ambient' | 'shell-shell' | 'flow' | 'benchmark';
  directed?: boolean;
}

export interface ClusterBounds {
  clusterId: string;
  clusterIndex: number;
  center: Vec3;
  min: Vec3;
  max: Vec3;
  moduleIds: string[];
}

export interface ModuleBounds {
  moduleId: string;
  clusterId: string;
  moduleIndex: number;
  center: Vec3;
  min: Vec3;
  max: Vec3;
  cellIndices: number[];
  coolantNode: number;
  plateNode: number;
  shellNode: number;
}

export interface BuiltCell {
  id: string;
  index: number;
  clusterId: string;
  moduleId: string;
  clusterIndex: number;
  moduleIndex: number;
  gridColumn: number;
  gridRow: number;
  position: Vec3;
  spec: CellSpec;
}

export interface ThermalGraph {
  nodes: {
    count: number;
    temp: Float64Array;
    capacity: Float64Array;
    kind: Uint8Array; // 0 cell, 1 shell, 2 plate, 3 coolant, 4 fixed
    cellIndex: Int32Array; // -1 for auxiliary nodes
    fixed: Uint8Array;
    peakTemp: Float64Array;
    heatReceivedJ: Float64Array;
  };
  edges: GraphEdge[];
  csr: {
    offsets: Int32Array;
    neighbors: Int32Array;
    conductance: Float64Array;
    edgeKinds: Uint8Array;
  };
  cells: BuiltCell[];
  modules: ModuleBounds[];
  clusters: ClusterBounds[];
  ambientNode: number;
  inletNodes: Record<string, number>;
  coolantNodesByCircuit: Record<string, number[]>;
  container: CabinConfig['container'];
}

export const NODE_KIND_CODE: Record<NodeKind, number> = {
  cell: 0,
  shell: 1,
  plate: 2,
  coolant: 3,
  fixed: 4,
};

const AIR_K = 0.026;
const ALUMINUM_RHO = 2700;
const ALUMINUM_CP = 900;
const STEEL_RHO = 7850;
const STEEL_CP = 500;

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function containerInterior(cabin: CabinConfig) {
  const c = cabin.container;
  return {
    minX: -c.length / 2 + 0.12,
    maxX: c.length / 2 - 0.12,
    minZ: -c.width / 2 + 0.12,
    maxZ: c.width / 2 - 0.12,
    floorY: 0.12,
    topY: c.height - 0.12,
  };
}

/**
 * Deterministic arrangement. Cluster count / modules per cluster are the
 * primary reflow inputs; all object coordinates remain in metres.
 */
export function arrangeCells(scheme: Scheme): {
  cells: BuiltCell[];
  modules: ModuleBounds[];
  clusters: ClusterBounds[];
} {
  const { cabin } = scheme;
  const interior = containerInterior(cabin);
  const spec = scheme.cellSpecs.find((s) => s.id === scheme.defaultSpecId) ?? scheme.cellSpecs[0];
  const dx = spec.dimensionsMm.x / 1000;
  const dy = spec.dimensionsMm.y / 1000;
  const dz = spec.dimensionsMm.z / 1000;
  const gap = cabin.cellsPerModule > 0 ? scheme.module.cellGapMm / 1000 : 0.002;
  const cellPitchX = dx + gap;
  const cellPitchZ = dz + gap;
  const cols = Math.max(1, cabin.cellColumns);
  const rows = Math.max(1, Math.ceil(cabin.cellsPerModule / cols));
  const moduleCellWidthX = (cols - 1) * cellPitchX + dx;
  const moduleCellWidthZ = (rows - 1) * cellPitchZ + dz;
  const moduleFrameX = moduleCellWidthX + 0.12;
  const moduleFrameZ = moduleCellWidthZ + 0.12;
  const moduleHeight = dy + 0.16;
  const moduleCols = Math.max(1, cabin.moduleColumns);
  const moduleRowsVertical = Math.max(1, Math.ceil(cabin.modulesPerCluster / moduleCols));
  const clusterPitchX = moduleFrameX + 0.18;
  const clusterWidthX = moduleCols * moduleFrameX + (moduleCols - 1) * 0.08 + 0.2;
  const usableX = interior.maxX - interior.minX;
  const clusterZone = Math.max(clusterWidthX + 0.4, usableX / Math.max(1, cabin.clusterCount));
  const totalClusterSpan = cabin.clusterCount * clusterZone;
  const startX = -totalClusterSpan / 2 + clusterZone / 2;

  const cells: BuiltCell[] = [];
  const modules: ModuleBounds[] = [];
  const clusters: ClusterBounds[] = [];
  let globalIndex = 0;

  for (let ci = 0; ci < cabin.clusterCount; ci++) {
    const clusterId = `cluster-${ci + 1}`;
    const cx = startX + ci * clusterZone;
    const clusterModuleIds: string[] = [];
    const clusterMin: Vec3 = { x: cx - clusterWidthX / 2, y: interior.floorY, z: -moduleFrameZ / 2 - 0.1 };
    const clusterMax: Vec3 = { x: cx + clusterWidthX / 2, y: interior.floorY + moduleRowsVertical * (moduleHeight + 0.08), z: moduleFrameZ / 2 + 0.1 };

    for (let mi = 0; mi < cabin.modulesPerCluster; mi++) {
      const moduleId = `${clusterId}-module-${mi + 1}`;
      clusterModuleIds.push(moduleId);
      const mc = mi % moduleCols;
      const ml = Math.floor(mi / moduleCols);
      const mx = cx + (mc - (moduleCols - 1) / 2) * (moduleFrameX + 0.08);
      const my = interior.floorY + 0.08 + ml * (moduleHeight + 0.08);
      const mz = 0;
      const cellIndices: number[] = [];
      const count = cabin.cellsPerModule;

      for (let k = 0; k < count; k++) {
        const gcc = k % cols;
        const gr = Math.floor(k / cols);
        const px = mx + (gcc - (cols - 1) / 2) * cellPitchX;
        const py = my + dy / 2 + 0.045;
        const pz = mz + (gr - (rows - 1) / 2) * cellPitchZ;
        const override = scheme.cellOverrides[`cell-${globalIndex + 1}`] ?? scheme.cellOverrides[String(globalIndex)];
        const cellSpec: CellSpec = override
          ? { ...spec, ...override }
          : spec;
        cells.push({
          id: `cell-${globalIndex + 1}`,
          index: globalIndex,
          clusterId,
          moduleId,
          clusterIndex: ci,
          moduleIndex: mi,
          gridColumn: gcc,
          gridRow: gr,
          position: { x: px, y: py, z: pz },
          spec: cellSpec,
        });
        cellIndices.push(globalIndex);
        globalIndex++;
      }

      modules.push({
        moduleId,
        clusterId,
        moduleIndex: mi,
        center: { x: mx, y: my + moduleHeight / 2, z: mz },
        min: { x: mx - moduleFrameX / 2, y: my, z: mz - moduleFrameZ / 2 },
        max: { x: mx + moduleFrameX / 2, y: my + moduleHeight, z: mz + moduleFrameZ / 2 },
        cellIndices,
        coolantNode: -1,
        plateNode: -1,
        shellNode: -1,
      });
    }

    clusters.push({
      clusterId,
      clusterIndex: ci,
      center: { x: cx, y: (clusterMin.y + clusterMax.y) / 2, z: 0 },
      min: clusterMin,
      max: clusterMax,
      moduleIds: clusterModuleIds,
    });
  }

  return { cells, modules, clusters };
}

function layerResistance(thicknessM: number, k: number, areaM2: number): number {
  if (!Number.isFinite(k) || k <= 0 || areaM2 <= 0) return Number.POSITIVE_INFINITY;
  return thicknessM / (k * areaM2);
}

function safeGFromR(...resistances: number[]): number {
  const r = resistances.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  return r > 0 && Number.isFinite(r) ? 1 / r : 0;
}

function addCsr(graph: ThermalGraph) {
  const n = graph.nodes.count;
  const offsets = new Int32Array(n + 1);
  const directedCount = graph.edges.reduce((sum, e) => sum + (e.directed ? 1 : 2), 0);
  const neighbors = new Int32Array(directedCount);
  const conductance = new Float64Array(directedCount);
  const edgeKinds = new Uint8Array(directedCount);
  const kindCode: Record<GraphEdge['kind'], number> = {
    'cell-cell': 0,
    'cell-shell': 1,
    'cell-plate': 2,
    'plate-coolant': 3,
    'shell-ambient': 4,
    'shell-shell': 5,
    flow: 6,
    benchmark: 7,
  };
  for (const e of graph.edges) {
    offsets[e.a + 1]++;
    if (!e.directed) offsets[e.b + 1]++;
  }
  for (let i = 1; i <= n; i++) offsets[i] += offsets[i - 1];
  const cursor = offsets.slice(0, n);
  for (const e of graph.edges) {
    let p = cursor[e.a]++;
    neighbors[p] = e.b;
    conductance[p] = e.conductance;
    edgeKinds[p] = kindCode[e.kind];
    if (!e.directed) {
      p = cursor[e.b]++;
      neighbors[p] = e.a;
      conductance[p] = e.conductance;
      edgeKinds[p] = kindCode[e.kind];
    }
  }
  graph.csr = { offsets, neighbors, conductance, edgeKinds };
}

/**
 * Builds the lumped thermal resistance network. Every production cell is a
 * node; shell, cold plate and coolant segments are auxiliary nodes so their
 * thermal mass and failure modes are represented explicitly.
 */
export function buildThermalGraph(scheme: Scheme, arrangement?: ReturnType<typeof arrangeCells>): ThermalGraph {
  const laid = arrangement ?? arrangeCells(scheme);
  const { cells, modules, clusters } = laid;
  const nCells = cells.length;
  const edges: GraphEdge[] = [];
  const temp: number[] = cells.map(() => 35);
  const capacity: number[] = cells.map((c) => c.spec.massKg * c.spec.specificHeatJkgK);
  const kind: number[] = new Array(nCells).fill(NODE_KIND_CODE.cell);
  const cellIndex: number[] = cells.map((_, i) => i);
  const fixed: number[] = new Array(nCells).fill(0);
  const ambientTemp = 35;

  const ambientNode = nCells;
  temp.push(ambientTemp);
  capacity.push(1e9);
  kind.push(NODE_KIND_CODE.fixed);
  cellIndex.push(-1);
  fixed.push(1);

  // One shell and cold-plate node per module, plus one coolant node per
  // module on each configured circuit.
  for (const m of modules) {
    const shellNode = temp.length;
    m.shellNode = shellNode;
    const shellArea = 2 * (
      (m.max.x - m.min.x) * (m.max.y - m.min.y) +
      (m.max.x - m.min.x) * (m.max.z - m.min.z) +
      (m.max.z - m.min.z) * (m.max.y - m.min.y)
    );
    const shellVolume = shellArea * scheme.module.shell.thicknessMm / 1000;
    temp.push(35);
    capacity.push(Math.max(5000, shellVolume * STEEL_RHO * STEEL_CP));
    kind.push(NODE_KIND_CODE.shell);
    cellIndex.push(-1);
    fixed.push(0);

    const plateNode = temp.length;
    m.plateNode = plateNode;
    const plateArea = (m.max.x - m.min.x) * (m.max.z - m.min.z);
    const plateVolume = plateArea * scheme.module.coldPlate.thicknessMm / 1000;
    temp.push(32);
    capacity.push(Math.max(4000, plateVolume * ALUMINUM_RHO * ALUMINUM_CP));
    kind.push(NODE_KIND_CODE.plate);
    cellIndex.push(-1);
    fixed.push(0);

    const coolantNode = temp.length;
    m.coolantNode = coolantNode;
    const circuit = scheme.cabin.cooling.find((c) => c.clusterIds.includes(m.clusterId)) ?? scheme.cabin.cooling[0];
    const segLength = Math.max(0.4, (circuit?.pipeLengthM ?? 4) / Math.max(1, modules.length));
    const pipeArea = Math.PI * 0.025 * 0.025 * segLength;
    temp.push(circuit?.inletTempC ?? 28);
    capacity.push(Math.max(800, pipeArea * (circuit?.densityKgM3 ?? 1000) * (circuit?.fluidCpJkgK ?? 3800)));
    kind.push(NODE_KIND_CODE.coolant);
    cellIndex.push(-1);
    fixed.push(0);

    // Plate to coolant: aluminium conduction plus a compact convection film.
    const plateA = Math.max(0.1, plateArea * 0.8);
    const rPlate = layerResistance(scheme.module.coldPlate.thicknessMm / 1000, scheme.module.coldPlate.conductivityWmK, plateA);
    const rFilm = 1 / (350 * plateA);
    edges.push({ a: plateNode, b: coolantNode, conductance: safeGFromR(rPlate, rFilm), kind: 'plate-coolant' });

    // Shell to cabin ambient.
    const hConv = 12;
    edges.push({ a: shellNode, b: ambientNode, conductance: hConv * Math.max(0.2, shellArea), kind: 'shell-ambient' });
  }

  // Cell-to-cell and cell-to-shell/plate edges.
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const indexByGrid = new Map<string, number>();
  for (const c of cells) indexByGrid.set(`${c.moduleId}:${c.gridColumn}:${c.gridRow}`, c.index);

  for (const c of cells) {
    const s = c.spec;
    const dim = s.dimensionsMm;
    const tX = dim.x / 1000;
    const tY = dim.y / 1000;
    const tZ = dim.z / 1000;
    const gapM = scheme.module.cellGapMm / 1000;
    const insT = scheme.module.insulation.thicknessMm / 1000;
    const residualGap = Math.max(0, gapM - insT);

    const connectNeighbor = (neighborIndex: number | undefined, axis: 'x' | 'z') => {
      if (neighborIndex === undefined || neighborIndex <= c.index) return;
      const area = axis === 'x' ? tY * tZ : tX * tY;
      const cellHalfR = axis === 'x'
        ? tX / (s.kThroughWmK * area)
        : tZ / (s.kInPlaneWmK * area);
      const insR = layerResistance(insT, scheme.module.insulation.conductivityWmK, area);
      const airR = residualGap > 0 ? layerResistance(residualGap, AIR_K, area) : 0;
      const stackG = safeGFromR(cellHalfR, cellHalfR, insR, airR);

      const busA = Math.max(1e-6, (scheme.module.busbar.widthMm ?? 40) * scheme.module.busbar.thicknessMm) / 1e6;
      const busLength = axis === 'x' ? tX + gapM + 0.08 : tZ + gapM + 0.08;
      const busR = layerResistance(busLength, scheme.module.busbar.conductivityWmK, busA);
      const busG = Number.isFinite(busR) && busR > 0 ? scheme.module.busbarCountPerGap / busR : 0;
      // Linearised radiation around a 500 C mean face temperature. A solid
      // aerogel sheet blocks the direct face-to-face view, leaving only edge
      // and puncture/bypass radiation; an unfilled air gap gets full view.
      const sigma = 5.67e-8;
      const tMean = 773;
      const radiationViewFactor = scheme.module.insulation.thicknessMm >= 0.5 ? 0.22 : 1;
      const radiationG = 4 * scheme.module.radiationEmissivity * sigma * tMean ** 3 * area * radiationViewFactor;
      edges.push({ a: c.index, b: neighborIndex, conductance: stackG + busG + radiationG, kind: 'cell-cell' });
    };

    connectNeighbor(indexByGrid.get(`${c.moduleId}:${c.gridColumn + 1}:${c.gridRow}`), 'x');
    connectNeighbor(indexByGrid.get(`${c.moduleId}:${c.gridColumn}:${c.gridRow + 1}`), 'z');

    const mod = modules.find((m) => m.moduleId === c.moduleId)!;
    const onBoundary =
      c.gridColumn === 0 ||
      c.gridRow === 0 ||
      c.gridColumn === Math.max(1, scheme.cabin.cellColumns) - 1;
    if (onBoundary) {
      const sideArea = Math.max(0.01, tY * (tX + tZ) * 0.8);
      const rShell = layerResistance(scheme.module.shell.thicknessMm / 1000, scheme.module.shell.conductivityWmK, sideArea);
      edges.push({ a: c.index, b: mod.shellNode, conductance: safeGFromR(rShell, 1 / (8 * sideArea)), kind: 'cell-shell' });
    }

    const footArea = tX * tZ * scheme.module.coldPlateContactAreaFactor;
    const adhesiveR = layerResistance(scheme.module.adhesive.thicknessMm / 1000, scheme.module.adhesive.conductivityWmK, Math.max(0.01, footArea));
    edges.push({ a: c.index, b: mod.plateNode, conductance: safeGFromR(adhesiveR), kind: 'cell-plate' });
  }

  // Shell-to-shell weak rack/conduction paths inside and between modules.
  for (const cl of clusters) {
    const clusterModules = modules.filter((m) => m.clusterId === cl.clusterId);
    for (let i = 0; i < clusterModules.length; i++) {
      for (let j = i + 1; j < clusterModules.length; j++) {
        const a = clusterModules[i];
        const b = clusterModules[j];
        const dx = Math.abs(a.center.x - b.center.x);
        const dy = Math.abs(a.center.y - b.center.y);
        if (dx < 0.5 && dy < 0.4) {
          edges.push({ a: a.shellNode, b: b.shellNode, conductance: 1.8, kind: 'shell-shell' });
        }
      }
    }
  }
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (j !== i + 1) continue;
      const ma = modules.filter((m) => m.clusterId === clusters[i].clusterId).at(-1);
      const mb = modules.filter((m) => m.clusterId === clusters[j].clusterId)[0];
      if (ma && mb) edges.push({ a: ma.shellNode, b: mb.shellNode, conductance: 0.35, kind: 'shell-shell' });
    }
  }

  // Directed coolant flow chain for each pump circuit.
  const inletNodes: Record<string, number> = {};
  const coolantNodesByCircuit: Record<string, number[]> = {};
  for (const circuit of scheme.cabin.cooling) {
    const inletNode = temp.length;
    temp.push(circuit.inletTempC);
    capacity.push(1e8);
    kind.push(NODE_KIND_CODE.fixed);
    cellIndex.push(-1);
    fixed.push(1);
    inletNodes[circuit.id] = inletNode;

    const ordered = modules
      .filter((m) => circuit.clusterIds.includes(m.clusterId))
      .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
    const nodes = ordered.map((m) => m.coolantNode);
    coolantNodesByCircuit[circuit.id] = nodes;
    let upstream = inletNode;
    const flowG = circuit.active && !circuit.pumpFailed
      ? (circuit.flowLpm / 60000) * circuit.densityKgM3 * circuit.fluidCpJkgK
      : 0;
    for (const cn of nodes) {
      edges.push({ a: upstream, b: cn, conductance: flowG, kind: 'flow', directed: true });
      upstream = cn;
    }
  }

  const graph: ThermalGraph = {
    nodes: {
      count: temp.length,
      temp: Float64Array.from(temp),
      capacity: Float64Array.from(capacity),
      kind: Uint8Array.from(kind),
      cellIndex: Int32Array.from(cellIndex),
      fixed: Uint8Array.from(fixed),
      peakTemp: Float64Array.from(temp),
      heatReceivedJ: new Float64Array(temp.length),
    },
    edges,
    csr: { offsets: new Int32Array(), neighbors: new Int32Array(), conductance: new Float64Array(), edgeKinds: new Uint8Array() },
    cells,
    modules,
    clusters,
    ambientNode,
    inletNodes,
    coolantNodesByCircuit,
    container: scheme.cabin.container,
  };
  addCsr(graph);
  return graph;
}

/** Minimal three-node serial verification graph used by the hand calc. */
export function buildHandCalcGraph(): ThermalGraph {
  const temp = new Float64Array([600, 25, 25, 25]);
  const capacity = new Float64Array([5000, 5000, 5000, 1e9]);
  const count = 4;
  const graph: ThermalGraph = {
    nodes: {
      count,
      temp,
      capacity,
      kind: Uint8Array.from([0, 0, 0, 4]),
      cellIndex: Int32Array.from([0, 1, 2, -1]),
      fixed: Uint8Array.from([1, 0, 0, 1]),
      peakTemp: Float64Array.from(temp),
      heatReceivedJ: new Float64Array(count),
    },
    edges: [
      { a: 0, b: 1, conductance: 5, kind: 'benchmark' },
      { a: 1, b: 2, conductance: 5, kind: 'benchmark' },
      { a: 2, b: 3, conductance: 0, kind: 'benchmark' },
    ],
    csr: { offsets: new Int32Array(), neighbors: new Int32Array(), conductance: new Float64Array(), edgeKinds: new Uint8Array() },
    cells: [],
    modules: [],
    clusters: [],
    ambientNode: 3,
    inletNodes: {},
    coolantNodesByCircuit: {},
    container: { kind: '20ft', length: 5.9, width: 2.35, height: 2.4, wallThickness: 0.08 },
  };
  graph.edges = graph.edges.filter((e) => e.conductance > 0);
  addCsr(graph);
  return graph;
}
