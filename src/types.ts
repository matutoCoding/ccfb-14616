// 领域模型类型定义 —— 储能舱热失控蔓延仿真

export type ContainerSize = '20ft' | '40ft';
export type Chemistry = 'LFP' | 'NCM'; // 磷酸铁锂 / 三元
export type TriggerType = 'overcharge' | 'nail' | 'heater';
export type DetectorKind = 'gas' | 'smoke' | 'temp';
export type NodeKind = 0 | 1 | 2; // 0=电芯 1=模组外壳 2=液冷板

/** 单颗电芯规格(方壳) */
export interface CellSpec {
  chemistry: Chemistry;
  capacityAh: number;        // 标称容量 Ah,如 280
  width: number;             // x 向厚度 m
  height: number;            // y 向 m
  depth: number;             // z 向 m
  mass: number;              // kg
  specificHeat: number;      // J/(kg·K)
  /** 自产热起始温度(自产热温升速率曲线起点) K */
  selfHeatStartT: number;
  /** 热失控触发温度 K */
  trTriggerT: number;
  /** 热失控总放热量 J */
  trHeatTotal: number;
  /** 喷发持续时间 s */
  ventDuration: number;
  /** 喷发可燃气总量 mol */
  ventGasMol: number;
  /** 喷发后火焰平台温度 K(外部火焰+残燃等效) */
  flamePlateauT: number;
  /** 平台维持时长 s */
  flameHoldS: number;
  /** 个别电芯覆盖:电芯间等效接触导热 W/(m·K),用于异常参数注入 */
  contactK?: number;
}

/** 模组内夹层材料(隔热垫/铝排/导热胶) */
export interface LayerMaterial {
  thickness: number;         // m
  conductivity: number;      // W/(m·K)
}

export interface ModuleInterlayers {
  aerogelPad: LayerMaterial; // 电芯间隔热垫(厚度=0 表示不加)
  aluminumBar: LayerMaterial;
  thermalGlue: LayerMaterial;
  cellGap: number;           // 电芯间总间隙 m(不含实体夹层时按空气处理)
}

export interface ModuleLayout {
  cellsX: number;            // x 向电芯数
  cellsZ: number;            // z 向电芯数
  wallThickness: number;     // 模组外壳壁厚 m
  wallConductivity: number;  // 外壳(铝/钢)导热 W/(m·K)
  coldPlateThickness: number;
  coldPlateConductivity: number;
  glueBetweenCellAndPlate: LayerMaterial;
}

export interface ClusterSpec {
  modulesPerCluster: number; // 每簇模组数(竖直堆叠)
  moduleLayout: ModuleLayout;
  interlayers: ModuleInterlayers;
}

export interface LiquidCoolingSpec {
  inletTemp: number;         // K
  /** 单路体积流量 L/min */
  flowLpm: number;
  /** 工质比热 J/(kg·K)、密度 kg/m3 */
  fluidCp: number;
  fluidDensity: number;
  /** 每条支路带的冷板数;停泵工况按支路整体切断 */
  platesPerBranch: number;
  /** 停运支路索引集合(液冷泵停) */
  stoppedBranches: number[];
}

export interface HVACSpec {
  ambientT: number;          // 舱内初始/空调送风温度 K
  airConvectionH: number;    // 外壳对舱内空气对流换热系数 W/(m2·K)
}

export interface DetectorSpec {
  id: string;
  kind: DetectorKind;
  /** 舱内坐标 m */
  x: number; y: number; z: number;
  /** 报警阈值:gas=mol/m3 浓度, smoke=消光率(无量纲), temp=K */
  threshold: number;
}

export interface NozzleSpec {
  id: string;
  x: number; y: number; z: number;
  /** 喷放后对作用半径内电芯的降温速率 K/s */
  coolingRate: number;
  /** 作用半径 m */
  radius: number;
  /** 全氟己酮设计喷放延时 s(探测报警后) */
  dischargeDelay: number;
}

export interface TriggerEvent {
  /** 被触发电芯的全局序号(按排布生成) */
  cellGlobalIndex: number;
  type: TriggerType;
  /** 触发时刻 s */
  time: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  createdAt: number;
  container: ContainerSize;
  clusterCount: number;
  cluster: ClusterSpec;
  cell: CellSpec;
  /** 个别电芯参数覆盖(用于异常参数/定制):key=全局电芯序号 */
  cellOverrides: Record<number, Partial<CellSpec>>;
  cooling: LiquidCoolingSpec;
  hvac: HVACSpec;
  detectors: DetectorSpec[];
  nozzles: NozzleSpec[];
  triggers: TriggerEvent[];
  /** 仿真物理时长 s */
  simDuration: number;
}

/** 参数校验问题 */
export interface ValidationIssue {
  level: 'error' | 'warning';
  cellIndex?: number;
  field: string;
  message: string;
  value?: number;
  expected?: string;
}

/** 生成后的几何/网络结构(CPU 侧,用于建图与渲染) */
export interface BuildResult {
  cellCount: number;
  moduleCount: number;
  /** 每颗电芯的世界坐标与所属模组 */
  cellPositions: Float32Array; // xyz * N
  cellModule: Uint32Array;
  /** 模组包围盒:minX,minY,minZ,maxX,maxY,maxZ * M */
  moduleBoxes: Float32Array;
  /** 模组 -> 簇 */
  moduleCluster: Uint32Array;
  clusterPositions: { x: number; y: number; z: number }[];
  /** 容器内尺寸 m */
  roomSize: { x: number; y: number; z: number };
  /** 每个电芯所属液冷支路 */
  cellBranch: Uint32Array;
  /** 支路在流动方向上的顺序序号(用于沿程温升) */
  cellPlateOrder: Uint32Array;
}

/** 仿真结束后的汇总结果 */
export interface SimSummary {
  physicalTime: number;
  wallTimeMs: number;
  steps: number;
  finalDt: number;
  trCount: number;
  firstPropagationTime: number | null; // 第二颗失控相对首颗的时间 s
  trOrder: { cell: number; t: number; module: number }[];
  detectorAlarms: { detectorId: string; kind: DetectorKind; t: number }[];
  dischargeTime: number | null;
  maxT: number;
  diverged: boolean;
}

export interface SnapshotMeta {
  t: number;
  /** 量化温度缓冲 u16 (T*64 偏移 200K) */
  temp: Uint16Array;
  /** 状态字节:0 正常 1 自产热 2 失控喷发中 3 已失控 */
  state: Uint8Array;
}

export interface SimResult {
  projectId: string;
  runAt: number;
  summary: SimSummary;
  /** 回放快照(稀疏,默认每 2s 物理时间一帧) */
  snapshots: SnapshotMeta[];
  snapshotInterval: number;
  /** 蔓延连线:按失控顺序 */
  propagationLinks: { from: number; to: number; t: number }[];
}

export interface StoredProject {
  config: ProjectConfig;
  results: SimResult[];
}
