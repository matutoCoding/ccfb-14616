// 评审报告：多方案对比（隔热垫/电芯间距/喷放延时）+ 首次蔓延时间/失控数汇总 + 导出
import type { ProjectConfig, SimulationRun } from '../model/types';
import { k2c } from '../model/defaults';

export interface ScenarioRow {
  tag: string;
  solver: string;
  physicalTime: number;
  wallMs: number;
  firstPropagation: number;
  runawayCount: number;
  totalCells: number;
  runawayPct: number;
  dischargeTime: number;
  firstAlarm: number;
  rackMaxTemp: number[];
  pumpFailTime: number;
  aerogel: boolean;
  cellGapMm: number;
  dischargeDelay: number;
}

export function runToRow(run: SimulationRun, cfg: ProjectConfig): ScenarioRow {
  return {
    tag: run.scenarioTag,
    solver: run.solver.toUpperCase(),
    physicalTime: run.physicalTime,
    wallMs: run.wallMs,
    firstPropagation: run.firstPropagationTime,
    runawayCount: run.finalRunawayCount,
    totalCells: run.cellCount,
    runawayPct: (100 * run.finalRunawayCount) / run.cellCount,
    dischargeTime: run.dischargeTime,
    firstAlarm: run.alarms.length ? run.alarms[0].time : -1,
    rackMaxTemp: run.rackMaxTemp,
    pumpFailTime: run.pumpFailTime,
    aerogel: cfg.materials.aerogelEnabled,
    cellGapMm: cfg.materials.cellGap * 1000,
    dischargeDelay: cfg.suppression.dischargeDelay,
  };
}

export function buildMarkdown(cfg: ProjectConfig, rows: ScenarioRow[]): string {
  const now = new Date().toLocaleString();
  const L: string[] = [];
  L.push(`# 储能舱热失控蔓延仿真评审报告`);
  L.push('');
  L.push(`生成时间：${now}`);
  L.push('');
  L.push(`## 一、舱体与电芯配置`);
  L.push(`- 集装箱：${cfg.cabin.container}（${cfg.cabin.dims.map((d) => d.toFixed(2)).join('×')} m）`);
  L.push(`- 电池簇：${cfg.cabin.rackCount} 簇，每簇 ${cfg.cabin.modulesPerRack} 模组，电芯总数 ${rows[0]?.totalCells ?? '-'}`);
  L.push(`- 电芯：${cfg.chem.name}，单体 ${cfg.chem.mass}kg，比热容 ${cfg.chem.specificHeat} J/(kg·K)`);
  L.push(`- T1 自产热起始 ${k2c(cfg.chem.tOnset).toFixed(0)}℃，T2 失控触发 ${k2c(cfg.chem.tTrigger).toFixed(0)}℃，单次放热量 ${cfg.chem.runawayEnergy} J，喷发 ${cfg.chem.ventDuration} s`);
  L.push(`- 气凝胶隔热垫：${cfg.materials.aerogelEnabled ? `加（${cfg.materials.aerogel.thickness * 1000}mm，λ=${cfg.materials.aerogel.conductivity} W/m·K）` : '不加'}`);
  L.push(`- 液冷：${cfg.cooling.enabled ? `进液 ${k2c(cfg.cooling.inletTemp).toFixed(1)}℃，${cfg.cooling.flowLpm} L/min` : '关闭'}`);
  if (cfg.cooling.failedBranches.length) L.push(`- 泵故障工况：簇 ${cfg.cooling.failedBranches.map((r) => r + 1).join('、')} 在 ${cfg.cooling.failTime}s 停泵`);
  L.push(`- 灭火剂：${cfg.suppression.agent}，喷放延时 ${cfg.suppression.dischargeDelay}s，等效降温 ${cfg.suppression.coolRate} K/s`);
  L.push('');
  L.push(`## 二、方案对比汇总`);
  L.push('');
  L.push('| 方案 | 求解器 | 物理时长(s) | 隔热垫 | 间距(mm) | 喷放延时(s) | 首次报警(s) | 喷放时刻(s) | 首次蔓延(s) | 失控电芯 | 失控占比 | 墙钟(s) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| ${r.tag} | ${r.solver} | ${r.physicalTime.toFixed(0)} | ${r.aerogel ? '加' : '无'} | ${r.cellGapMm.toFixed(1)} | ${r.dischargeDelay} | ${fmt(r.firstAlarm)} | ${fmt(r.dischargeTime)} | ${fmt(r.firstPropagation)} | ${r.runawayCount} | ${r.runawayPct.toFixed(2)}% | ${(r.wallMs / 1000).toFixed(1)} |`);
  }
  L.push('');
  L.push(`## 三、各簇最终最高温度`);
  L.push('');
  L.push('| 方案 | ' + rows[0]?.rackMaxTemp.map((_, i) => `簇${i + 1}(℃)`).join(' | ') + ' |');
  L.push('|---' + '|---'.repeat(rows[0]?.rackMaxTemp.length ?? 1) + '|');
  for (const r of rows) {
    L.push(`| ${r.tag} | ${r.rackMaxTemp.map((t) => k2c(t).toFixed(1)).join(' | ')} |`);
  }
  L.push('');
  L.push(`## 四、评审结论要点`);
  const best = [...rows].filter((r) => r.firstPropagation >= 0).sort((a, b) => b.firstPropagation - a.firstPropagation)[0];
  if (best) {
    L.push(`- 延缓首次蔓延最有效的方案为「${best.tag}」，首次蔓延时间 ${best.firstPropagation.toFixed(1)}s，最终失控 ${best.runawayCount} 颗（占 ${best.runawayPct.toFixed(2)}%）。`);
  } else {
    L.push('- 所有方案在仿真时长内均未发生跨芯蔓延。');
  }
  const noSpread = rows.filter((r) => r.firstPropagation < 0);
  if (noSpread.length) L.push(`- 方案 ${noSpread.map((r) => `「${r.tag}」`).join('、')} 在观测窗内未发生蔓延，可作为优选边界。`);
  L.push('- 注：本报告基于集总参数热网络模型与显式积分，分区探测为工程估算模型，详细设计应结合全尺寸热失控试验复核。');
  L.push('');
  return L.join('\n');
}

export function buildCsv(rows: ScenarioRow[]): string {
  const head = ['方案', '求解器', '物理时长s', '隔热垫', '间距mm', '喷放延时s', '首次报警s', '喷放时刻s', '首次蔓延s', '失控电芯数', '电芯总数', '失控占比%', '墙钟s'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.tag, r.solver, r.physicalTime.toFixed(0), r.aerogel ? '加' : '无', r.cellGapMm.toFixed(2),
      r.dischargeDelay, fmt(r.firstAlarm), fmt(r.dischargeTime), fmt(r.firstPropagation),
      r.runawayCount, r.totalCells, r.runawayPct.toFixed(3), (r.wallMs / 1000).toFixed(2),
    ].join(','));
  }
  return '﻿' + lines.join('\n');
}

function fmt(v: number): string { return v < 0 ? '未发生' : v.toFixed(1); }
