import type { ProjectConfig } from '../types';
import { defaultCellSpec, KELVIN_0C } from './constants';

let seq = 0;
const id = () => `proj-${Date.now().toString(36)}-${seq++}`;

function base40ft(): ProjectConfig {
  const cell = defaultCellSpec('LFP');
  return {
    id: id(),
    name: '40尺两簇演示舱(含异常参数电芯)',
    createdAt: Date.now(),
    container: '40ft',
    clusterCount: 2,
    cluster: {
      modulesPerCluster: 8,
      moduleLayout: {
        cellsX: 12, cellsZ: 2,
        wallThickness: 0.002, wallConductivity: 45,
        coldPlateThickness: 0.008, coldPlateConductivity: 202,
        glueBetweenCellAndPlate: { thickness: 0.001, conductivity: 1.5 },
      },
      interlayers: {
        aerogelPad: { thickness: 0.002, conductivity: 0.018 },
        aluminumBar: { thickness: 0.001, conductivity: 202 },
        thermalGlue: { thickness: 0.0005, conductivity: 1.5 },
        cellGap: 0.003,
      },
    },
    cell,
    cellOverrides: {},
    cooling: {
      inletTemp: KELVIN_0C + 25,
      flowLpm: 40,
      fluidCp: 3500,
      fluidDensity: 1060,
      platesPerBranch: 8,
      stoppedBranches: [],
    },
    hvac: { ambientT: KELVIN_0C + 25, airConvectionH: 6 },
    detectors: [
      { id: 'gas-1', kind: 'gas', x: 3, y: 2.2, z: 1.5, threshold: 0.15 },
      { id: 'smoke-1', kind: 'smoke', x: 6, y: 2.2, z: 1.5, threshold: 0.02 },
      { id: 'smoke-2', kind: 'smoke', x: 9, y: 2.2, z: 1.5, threshold: 0.02 },
      { id: 'temp-1', kind: 'temp', x: 6, y: 2.0, z: 1.2, threshold: KELVIN_0C + 70 },
    ],
    nozzles: [
      { id: 'nz-1', x: 3, y: 2.25, z: 1.2, coolingRate: 1.2, radius: 3.5, dischargeDelay: 10 },
      { id: 'nz-2', x: 9, y: 2.25, z: 1.2, coolingRate: 1.2, radius: 3.5, dischargeDelay: 10 },
    ],
    triggers: [
      { cellGlobalIndex: 0, type: 'nail', time: 0 },
    ],
    simDuration: 7200,
  };
}

/**
 * 演示舱:40 尺、2 簇、每簇 8 模组、每模组 24 颗 = 384 颗/簇,共 768 颗。
 * 故意注入 3 颗参数数量级错误的电芯,校验器必须能报出来:
 *  - #12:接触导热填成 18(气凝胶的 1000 倍,疑似把 0.018 漏了小数点)
 *  - #300:比热填成 11000(大一个数量级,J/g 与 J/kg 混了)
 *  - #500:热失控放热量填成 340000(大一个数量级,kJ/J 混了)
 */
export function createDemoProject(): ProjectConfig {
  const cfg = base40ft();
  cfg.cellOverrides = {
    12: { contactK: 18 } as ProjectConfig['cellOverrides'][number],
    300: { specificHeat: 11000 },
    500: { trHeatTotal: 340000 },
  };
  return cfg;
}

/** 大规模性能舱:12000 颗量级,验证 3 分钟跑完两小时物理时间 */
export function createLargeProject(): ProjectConfig {
  const cfg = base40ft();
  cfg.name = '40尺大规模性能舱(1.2万颗)';
  cfg.clusterCount = 4;
  cfg.cluster.modulesPerCluster = 10;
  // 目标 12000 = 4 簇 × 10 模组 × 300 颗/模组(20×15)
  cfg.cluster.moduleLayout.cellsX = 20;
  cfg.cluster.moduleLayout.cellsZ = 15;
  cfg.cooling.stoppedBranches = [2];   // 第 3 路液冷泵停
  cfg.triggers = [{ cellGlobalIndex: 30, type: 'heater', time: 0 }, { cellGlobalIndex: 6000, type: 'nail', time: 600 }];
  cfg.cellOverrides = { 12: { contactK: 18 } as ProjectConfig['cellOverrides'][number] };
  return cfg;
}

/** 三电芯手算小算例(与 test/phys.test.ts 同参数,页面上可直接跑) */
export function createThreeCellProject(): ProjectConfig {
  const cfg = base40ft();
  cfg.name = '三电芯串排手算算例';
  cfg.container = '20ft';
  cfg.clusterCount = 1;
  cfg.cluster.modulesPerCluster = 1;
  cfg.cluster.moduleLayout.cellsX = 3;
  cfg.cluster.moduleLayout.cellsZ = 1;
  // 与手算测试一致:纯 2mm 气凝胶、无铝排/导热胶,削弱外壳/冷板热汇以隔离电芯间传导
  cfg.cluster.interlayers.aluminumBar.thickness = 0;
  cfg.cluster.interlayers.thermalGlue.thickness = 0;
  cfg.cluster.interlayers.aerogelPad = { thickness: 0.002, conductivity: 0.018 };
  // 用低导热厚胶把电芯->冷板热阻拉到接近绝缘,复刻手算的纯电芯链工况
  cfg.cluster.moduleLayout.glueBetweenCellAndPlate = { thickness: 0.05, conductivity: 0.018 };
  cfg.hvac.airConvectionH = 0;
  cfg.cooling.flowLpm = 0.5;
  cfg.simDuration = 14400;
  cfg.triggers = [{ cellGlobalIndex: 0, type: 'nail', time: 0 }];
  cfg.detectors = [];
  cfg.nozzles = [];
  return cfg;
}
