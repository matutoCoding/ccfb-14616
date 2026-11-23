// 领域模型：舱体 / 模组 / 电芯 / 触发 / 探测器 / 仿真 全部共享类型定义
// 单位约定：长度 m，质量 kg，时间 s，温度 K（界面显示用 ℃），热量 J，功率 W，导热系数 W/(m·K)

export type ChemKind = 'LFP' | 'NCM';
export type TriggerKind = 'overcharge' | 'nail' | 'heater';
export type DetectorKind = 'gas' | 'smoke' | 'temp';
export type ContainerSize = '20ft' | '40ft';

/** 电芯化学体系参数（280Ah 方壳这类规格） */
export interface ChemSpec {
  id: string;
  name: string;
  kind: ChemKind;
  /** 标称容量 Ah */
  capacityAh: number;
  /** 单体质量 kg */
  mass: number;
  /** 平均比热容 J/(kg·K) */
  specificHeat: number;
  /** 外形尺寸 m（宽 x 厚 x 高） */
  dims: [number, number, number];
  /** 自产热起始温度 T1（自产热反应起点）K */
  tOnset: number;
  /** 热失控触发温度 T2 K */
  tTrigger: number;
  /** 自产热分段点（K）与对应产热功率 W，按温度分段线性插值 */
  selfHeatTable: { t: number; power: number }[];
  /** 单次热失控总放热量 J */
  runawayEnergy: number;
  /** 失控喷发期观测峰值温度 K（工程等效热库，驱动蔓延） */
  runawayPeakTemp: number;
  /** 喷发持续时长 s（泄压阀喷发方向沿 +Z 局部坐标） */
  ventDuration: number;
  /** 喷发出的可燃气体总量 mol（用于气体探测分区模型） */
  ventGasMol: number;
  /** 喷发出的烟量（相对量纲，烟感模型用） */
  ventSmoke: number;
}

/** 层状材料（隔热垫 / 铝排 / 导热胶） */
export interface LayerMaterial {
  /** 厚度 m */
  thickness: number;
  /** 导热系数 W/(m·K) */
  conductivity: number;
}

/** 模组内结构材料配置：电芯间隔热垫、铝排、导热胶 */
export interface ModuleMaterials {
  /** 电芯之间是否加气凝胶隔热垫 */
  aerogelEnabled: boolean;
  aerogel: LayerMaterial;
  busbar: LayerMaterial;
  thermalGlue: LayerMaterial;
  /** 电芯净间距 m（隔热垫之外的间隙，通常 0） */
  cellGap: number;
  /** 模组外壳等效钢板：厚度 m，导热系数 W/(m·K) */
  shellThickness: number;
  shellConductivity: number;
  /** 液冷板接触：厚度 m，导热系数 W/(m·K)，接触面积 m² */
  coldPlateThickness: number;
  coldPlateConductivity: number;
  coldPlateAreaPerCell: number;
}

/** 模组布局（每簇内模组数、每模组串并联） */
export interface ModuleLayout {
  /** 每簇模组数 */
  modulesPerRack: number;
  /** 每模组电芯串数（沿 X） */
  cellsSeriesX: number;
  /** 每模组电芯并数（沿 Y，通常 1 或 2） */
  cellsParallelY: number;
  /** 模组外形尺寸 m（用于外壳换热面积） */
  moduleDims: [number, number, number];
}

export interface CellOverrides {
  /** key = 全局电芯索引；故意/实际的逐芯参数覆盖（如导热系数数量级填错） */
  [cellIndex: number]: {
    conductivityScale?: number;
    massScale?: number;
    specificHeatScale?: number;
  };
}

/** 液冷系统 */
export interface CoolingConfig {
  enabled: boolean;
  /** 进液温度 K */
  inletTemp: number;
  /** 总流量 L/min */
  flowLpm: number;
  /** 冷却液比热容 J/(kg·K)，密度 kg/L */
  fluidSpecificHeat: number;
  fluidDensity: number;
  /** 每路（每簇一路）并联管路数 */
  branchesPerRack: number;
  /** 泵故障工况：故障的支路（簇）序号集合，空=全正常 */
  failedBranches: number[];
  /** 泵故障发生时刻 s（在此之前全正常） */
  failTime: number;
}

/** 单个触发点 */
export interface TriggerPoint {
  id: string;
  kind: TriggerKind;
  /** 目标电芯全局索引（布局页/3D 点选） */
  cellIndex: number;
  /** 触发时刻 s */
  time: number;
  /** 触发方式参数：加热板功率 W / 针刺等效功率 W / 过充等效功率 W */
  power: number;
  /** 外部加热持续时长 s（到点或达到 T2 即转入失控） */
  duration: number;
}

export interface DetectorSpec {
  id: string;
  kind: DetectorKind;
  label: string;
  /** 舱内坐标 m */
  position: [number, number, number];
  /** 所属分区编号（气体分区模型） */
  zone: number;
  /** 报警阈值：气体 mol/m³（体积摩尔浓度）、烟感遮光率 %/m、温感 K（温升速率或绝对值） */
  threshold: number;
}

export interface SuppressionConfig {
  enabled: boolean;
  /** 灭火剂类型 */
  agent: 'FK-5-1-12' | 'HFC-227ea' | 'water-mist';
  /** 探测确认后喷放延时 s */
  dischargeDelay: number;
  /** 喷放后对电芯的等效降温速率 K/s（按设定值作用到电芯） */
  coolRate: number;
  /** 喷放持续作用时长 s */
  duration: number;
  /** 分区体积 m³（浓度估算用） */
  zoneVolume: number;
}

export interface CabinLayout {
  container: ContainerSize;
  /** 电池簇数量 */
  rackCount: number;
  /** 每簇模组数（与 ModuleLayout.modulesPerRack 联动，改这里直接重排） */
  modulesPerRack: number;
  /** 舱体尺寸 m（20/40 尺标准集装箱，自动给出可覆盖） */
  dims: [number, number, number];
  /** 高压箱位置 m */
  hvBoxPos: [number, number, number];
  /** 空调出风口位置 m（可多个） */
  acVents: [number, number, number][];
  /** 环境（舱内）温度 K */
  ambientTemp: number;
  /** 舱壁自然对流换热系数 W/(m²·K) */
  ambientH: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  cabin: CabinLayout;
  layout: ModuleLayout;
  materials: ModuleMaterials;
  chem: ChemSpec;
  /** 备选化学体系（切换对比用） */
  altChems: ChemSpec[];
  cooling: CoolingConfig;
  triggers: TriggerPoint[];
  detectors: DetectorSpec[];
  suppression: SuppressionConfig;
  overrides: CellOverrides;
}

/** 校验问题（参数数量级错误等） */
export interface ValidationIssue {
  level: 'error' | 'warning';
  cellIndex?: number;
  field: string;
  message: string;
  value?: number;
  expected?: string;
}

export type RunawayState = 0 | 1 | 2 | 3;
// 0 正常, 1 自产热（T>=T1）, 2 失控喷发中（T>=T2 或被触发）, 3 喷发结束（燃料耗尽，残余冷却）

export interface RunawayEvent {
  cellIndex: number;
  /** 进入失控的时刻 s */
  time: number;
  /** 所属模组、簇 */
  moduleId: number;
  rackId: number;
  /** 触发源：'trigger' 外部触发 / 'prop:<n>' 被第 n 号电芯蔓延引燃 */
  cause: string;
}

export interface DetectorAlarmEvent {
  detectorId: string;
  kind: DetectorKind;
  time: number;
  zone: number;
  /** 报警时的读数 */
  reading: number;
}

/** 仿真运行记录（IndexedDB 持久化） */
export interface SimulationRun {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  /** 仿真物理时长 s */
  physicalTime: number;
  /** 墙钟耗时 ms */
  wallMs: number;
  /** 使用的求解器 */
  solver: 'gpu' | 'cpu';
  /** 快照间隔 s */
  snapshotInterval: number;
  cellCount: number;
  events: RunawayEvent[];
  alarms: DetectorAlarmEvent[];
  /** 首个蔓延事件时间 s（-1 表示未发生蔓延） */
  firstPropagationTime: number;
  /** 最终失控电芯数 */
  finalRunawayCount: number;
  /** 方案标签（加不加隔热垫/电芯间距/喷放延时等对比维度） */
  scenarioTag: string;
  /** 快照：TypedArray 无法直接结构化克隆存 IDB，用普通数组分块 */
  snapshotTimes: number[];
  /** 每帧温度，按 snapshot 分块的 number[]（每块长度=cellCount） */
  tempFrames: number[][];
  /** 每帧状态 */
  stateFrames: number[][];
  /** 喷放开始时刻 s，-1 未喷放 */
  dischargeTime: number;
  /** 泵故障实际生效时刻 s，-1 无故障 */
  pumpFailTime: number;
  /** 仿真结束时各簇最高温 K */
  rackMaxTemp: number[];
}

export interface SimProgress {
  physicalTime: number;
  targetTime: number;
  wallMs: number;
  runawayCount: number;
  currentDt: number;
}
