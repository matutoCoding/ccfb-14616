export type Vec3 = { x: number; y: number; z: number };

export type ContainerKind = '20ft' | '40ft';
export type CellChemistry = 'LFP' | 'NCM';
export type TriggerKind = 'overcharge' | 'nail' | 'heater' | 'manual';
export type DetectorKind = 'gas' | 'smoke' | 'temperature';
export type ObjectKind =
  | 'hvBox'
  | 'coolantPipe'
  | 'acVent'
  | 'firePanel'
  | 'exhaust'
  | 'custom';

export interface ContainerSpec {
  kind: ContainerKind;
  /** internal dimensions, metres */
  length: number;
  width: number;
  height: number;
  wallThickness: number;
}

export interface CabinObject {
  id: string;
  kind: ObjectKind;
  name: string;
  position: Vec3;
  size: Vec3;
  color?: string;
  circuitId?: string;
  enabled: boolean;
}

export interface Detector {
  id: string;
  kind: DetectorKind;
  name: string;
  position: Vec3;
  /** gas: vol%; smoke: 1/m optical density; temperature: C */
  alarmThreshold: number;
  /** temperature rate-of-rise alarm, C/min */
  rateThreshold?: number;
  zoneId?: string;
}

export interface CoolingCircuit {
  id: string;
  name: string;
  inletTempC: number;
  flowLpm: number;
  fluidCpJkgK: number;
  densityKgM3: number;
  pipeLengthM: number;
  active: boolean;
  pumpFailed: boolean;
  clusterIds: string[];
  path: Vec3[];
}

export interface CabinConfig {
  container: ContainerSpec;
  clusterCount: number;
  modulesPerCluster: number;
  cellsPerModule: number;
  moduleColumns: number;
  moduleLevels: number;
  cellColumns: number;
  cellRows: number;
  clusterSpacingM: number;
  objects: CabinObject[];
  detectors: Detector[];
  cooling: CoolingCircuit[];
}

export interface SelfHeatSegment {
  id: string;
  /** temperature at which this constant heat rate starts, C */
  fromC: number;
  heatW: number;
}

export interface CellSpec {
  id: string;
  name: string;
  chemistry: CellChemistry;
  capacityAh: number;
  nominalVoltageV: number;
  massKg: number;
  specificHeatJkgK: number;
  dimensionsMm: Vec3;
  /** effective through-plane thermal conductivity, W/(m K) */
  kThroughWmK: number;
  /** effective in-plane conductivity, W/(m K) */
  kInPlaneWmK: number;
  selfHeat: SelfHeatSegment[];
  selfHeatStartC: number;
  onsetTempC: number;
  /** total exothermic energy released during runaway, J */
  runawayHeatJ: number;
  /** fraction directly retained in the cell; remainder is vented/convected */
  retainedFraction: number;
  eruptionDurationS: number;
  ventGasM3: number;
}

export interface MaterialLayer {
  id: string;
  name: string;
  thicknessMm: number;
  conductivityWmK: number;
  /** optional contact area in mm2; geometry computes it when omitted */
  areaMm2?: number;
  widthMm?: number;
}

export interface ModuleConfig {
  cellGapMm: number;
  insulation: MaterialLayer;
  adhesive: MaterialLayer;
  busbar: MaterialLayer;
  busbarCountPerGap: number;
  shell: MaterialLayer;
  coldPlate: MaterialLayer;
  coldPlateContactAreaFactor: number;
  radiationEmissivity: number;
}

export interface TriggerTarget {
  cellId: string;
  kind: TriggerKind;
  /** overcharge SOC increment, 0..1 */
  soc?: number;
  powerW?: number;
  durationS?: number;
}

export interface TriggerConfig {
  targets: TriggerTarget[];
  simultaneous: boolean;
}

export interface SuppressionConfig {
  agentName: string;
  /** detection/confirmation plus release delay, s */
  releaseDelayS: number;
  /** target cell cooling rate after agent reaches pack, C/min */
  coolingRateCPerMin: number;
  durationS: number;
  active: boolean;
}

export interface Scheme {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  cabin: CabinConfig;
  cellSpecs: CellSpec[];
  defaultSpecId: string;
  module: ModuleConfig;
  trigger: TriggerConfig;
  suppression: SuppressionConfig;
  /** per-cell conductivity overrides / deliberately bad seed data */
  cellOverrides: Record<string, Partial<Pick<CellSpec, 'kThroughWmK' | 'kInPlaneWmK'>>>;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  id: string;
  severity: IssueSeverity;
  scope: 'cell' | 'material' | 'layout' | 'cooling' | 'detector' | 'physics';
  targetId?: string;
  targetName?: string;
  field: string;
  value: number | string | boolean;
  message: string;
  expectedRange?: [number, number];
  suggestedValue?: number | string;
  repairable: boolean;
}

export interface CellRuntimeInfo {
  id: string;
  index: number;
  clusterId: string;
  moduleId: string;
  clusterIndex: number;
  moduleIndex: number;
  position: Vec3;
  specId: string;
}

export interface PropagationEvent {
  order: number;
  cellId: string;
  cellIndex: number;
  clusterId: string;
  moduleId: string;
  clusterIndex: number;
  moduleIndex: number;
  timeS: number;
  position: Vec3;
  fromCellId?: string;
  via?: 'intra-module' | 'cross-module' | 'cross-cluster' | 'trigger';
}

export interface DetectorAlarm {
  detectorId: string;
  name: string;
  kind: DetectorKind;
  timeS: number | null;
  peakValue: number;
  threshold: number;
  zoneId: string;
}

export interface CoolingCircuitResult {
  circuitId: string;
  name: string;
  failed: boolean;
  peakFluidTempC: number;
  heatRemovedJ: number;
}

export interface FrameBundle {
  intervalS: number;
  timesS: Float32Array;
  /** deci-degrees C, 0..6553.5 C */
  temperaturesDeciC: Uint16Array;
  states: Uint8Array;
  cellCount: number;
}

export interface RunSummary {
  id: string;
  schemeId: string;
  schemeName: string;
  createdAt: number;
  backend: 'webgpu' | 'cpu-reference';
  status: 'completed' | 'failed' | 'stopped';
  physicalDurationS: number;
  computeElapsedMs: number;
  cellCount: number;
  stepCount: number;
  substepCount: number;
  maxStableDtS: number;
  firstRunawayS: number | null;
  firstPropagationS: number | null;
  firstToSecondS: number | null;
  runawayCount: number;
  events: PropagationEvent[];
  alarms: DetectorAlarm[];
  cooling: CoolingCircuitResult[];
  issues: ValidationIssue[];
  suppressionStartS: number | null;
  finalMaxTempC: number;
  frames?: FrameBundle;
}

export interface ComparisonRow {
  schemeId: string;
  schemeName: string;
  insulationThicknessMm: number;
  cellGapMm: number;
  releaseDelayS: number;
  firstPropagationS: number | null;
  firstToSecondS: number | null;
  runawayCount: number;
  runawayFraction: number;
  maxTempC: number;
  verdict: string;
}
