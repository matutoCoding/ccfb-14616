// 参数校验：物理量级范围 + 逐芯覆盖值检查 + 稳定性预判
// 设计目标：导热系数填错数量级（如 0.0002 或 200）必须报 error，而不是默默算出全舱炸
import type { ProjectConfig, ValidationIssue } from './types';
import { buildTopology } from './topology';
import { k2c } from './defaults';

/** 常见材料导热系数合理区间 W/(m·K) */
const K_RANGE: Record<string, [number, number]> = {
  aerogel: [0.008, 0.06],
  metal: [50, 420],
  glue: [0.2, 8],
};

const RANGE_RULES: { field: string; label: string; min: number; max: number; unit: string }[] = [
  { field: 'mass', label: '电芯质量', min: 0.05, max: 8, unit: 'kg' },
  { field: 'specificHeat', label: '比热容', min: 500, max: 2000, unit: 'J/(kg·K)' },
  { field: 'runawayEnergy', label: '热失控放热量', min: 2000, max: 120000, unit: 'J' },
  { field: 'ventDuration', label: '喷发时长', min: 2, max: 120, unit: 's' },
  { field: 'ventGasMol', label: '喷发气体量', min: 0.05, max: 10, unit: 'mol' },
];

export function validateProject(cfg: ProjectConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);

  // —— 电芯化学体系 ——
  if (cfg.chem.tOnset >= cfg.chem.tTrigger) {
    push({ level: 'error', field: 'chem.tTrigger', message: '自产热起始温度 T1 必须低于热失控触发温度 T2' });
  }
  for (const rule of RANGE_RULES) {
    const v = (cfg.chem as unknown as Record<string, number>)[rule.field];
    if (!(v >= rule.min && v <= rule.max)) {
      push({ level: 'error', field: `chem.${rule.field}`, message: `${rule.label} ${v} ${rule.unit} 超出合理区间 [${rule.min}, ${rule.max}]`, value: v, expected: `[${rule.min}, ${rule.max}] ${rule.unit}` });
    }
  }
  // 自产热表单调、覆盖 T1/T2
  const table = cfg.chem.selfHeatTable;
  for (let i = 1; i < table.length; i++) {
    if (table[i].t <= table[i - 1].t || table[i].power < table[i - 1].power) {
      push({ level: 'error', field: 'chem.selfHeatTable', message: `自产热分段表第 ${i} 段不满足温度与功率单调递增` });
    }
  }
  if (table[0].t > cfg.chem.tOnset || table[table.length - 1].t < cfg.chem.tTrigger) {
    push({ level: 'warning', field: 'chem.selfHeatTable', message: '自产热表未完整覆盖 T1~T2 区间，外推段按端点恒定处理' });
  }

  // —— 材料导热系数数量级 ——
  const checkK = (name: string, k: number, range: [number, number], thickness: number) => {
    if (!(k >= range[0] && k <= range[1])) {
      push({ level: 'error', field: `materials.${name}`, message: `${name} 导热系数 ${k} W/(m·K) 数量级异常，合理区间 [${range[0]}, ${range[1]}]`, value: k, expected: `[${range[0]}, ${range[1]}] W/(m·K)` });
    }
    if (thickness <= 0 || thickness > 0.05) {
      push({ level: 'error', field: `materials.${name}.thickness`, message: `${name} 厚度 ${thickness} m 异常（应在 0~0.05m）`, value: thickness });
    }
  };
  if (cfg.materials.aerogelEnabled) checkK('aerogel', cfg.materials.aerogel.conductivity, K_RANGE.aerogel, cfg.materials.aerogel.thickness);
  checkK('busbar', cfg.materials.busbar.conductivity, K_RANGE.metal, cfg.materials.busbar.thickness);
  checkK('thermalGlue', cfg.materials.thermalGlue.conductivity, K_RANGE.glue, cfg.materials.thermalGlue.thickness);
  checkK('shell', cfg.materials.shellConductivity, [5, 300], cfg.materials.shellThickness);

  // —— 布局 ——
  if (cfg.cabin.rackCount < 1 || cfg.cabin.rackCount > 12) push({ level: 'error', field: 'cabin.rackCount', message: '簇数应在 1~12 之间' });
  if (cfg.cabin.modulesPerRack < 1 || cfg.cabin.modulesPerRack > 16) push({ level: 'error', field: 'cabin.modulesPerRack', message: '每簇模组数应在 1~16 之间' });
  if (cfg.layout.cellsSeriesX < 1 || cfg.layout.cellsSeriesX > 80) push({ level: 'error', field: 'layout.cellsSeriesX', message: '串联电芯数异常' });

  // —— 液冷 ——
  if (cfg.cooling.enabled) {
    if (cfg.cooling.inletTemp < k2c(0) + 273.15 - 50 || cfg.cooling.inletTemp > 333) {
      push({ level: 'warning', field: 'cooling.inletTemp', message: `进液温度 ${k2c(cfg.cooling.inletTemp).toFixed(1)}℃ 偏离常见 15~40℃ 区间` });
    }
    if (cfg.cooling.flowLpm <= 0 || cfg.cooling.flowLpm > 2000) {
      push({ level: 'error', field: 'cooling.flowLpm', message: `流量 ${cfg.cooling.flowLpm} L/min 异常` });
    }
  }

  // —— 逐芯覆盖值（故意填错数量级的电芯在这里被点名）——
  const topo = buildTopology(cfg);
  for (const [key, ov] of Object.entries(cfg.overrides)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= topo.cellCount) {
      push({ level: 'error', field: `overrides.${key}`, message: `电芯 #${key} 不存在（当前共 ${topo.cellCount} 颗）` });
      continue;
    }
    if (ov.conductivityScale !== undefined) {
      // 数量级判定：缩放后若把隔热材料拉到金属量级，或金属压到隔热量级，必然是填错
      const s = ov.conductivityScale;
      if (s <= 0 || !Number.isFinite(s)) {
        push({ level: 'error', cellIndex: idx, field: 'overrides.conductivityScale', message: `电芯 #${idx} 导热系数倍率 ${s} 非法`, value: s });
      } else if (s < 0.05 || s > 50) {
        push({ level: 'error', cellIndex: idx, field: 'overrides.conductivityScale', message: `电芯 #${idx} 导热系数倍率 ×${s}，偏差超过一个数量级，疑似数量级填错`, value: s, expected: '0.05~50（即 ±1 个数量级内）' });
      } else if (s < 0.5 || s > 2) {
        push({ level: 'warning', cellIndex: idx, field: 'overrides.conductivityScale', message: `电芯 #${idx} 导热系数倍率 ×${s} 偏离默认值较多`, value: s });
      }
    }
    for (const k of ['massScale', 'specificHeatScale'] as const) {
      const s = ov[k];
      if (s !== undefined && (!(s > 0) || s < 0.2 || s > 5)) {
        push({ level: 'error', cellIndex: idx, field: `overrides.${k}`, message: `电芯 #${idx} ${k} = ${s} 超出合理范围`, value: s });
      }
    }
  }

  // —— 触发点 ——
  for (const t of cfg.triggers) {
    if (!Number.isInteger(t.cellIndex) || t.cellIndex < 0 || t.cellIndex >= topo.cellCount) {
      push({ level: 'error', field: 'triggers', message: `触发点电芯 #${t.cellIndex} 不存在` });
    }
    if (t.power <= 0 || t.power > 5000) push({ level: 'warning', field: 'triggers.power', message: `触发功率 ${t.power}W 偏离常见区间` });
  }
  if (cfg.triggers.length === 0) {
    push({ level: 'warning', field: 'triggers', message: '尚未设置任何触发点，仿真不会发生热失控' });
  }

  // —— 显式积分稳定性预判：C/G 最小时间常数 ——
  let minTau = Infinity;
  for (let i = 0; i < topo.cellCount; i++) {
    const g = 2 * (topo.gx[i] + topo.gy[i]) + topo.gShell[i] + topo.gCold[i];
    minTau = Math.min(minTau, topo.cap[i] / Math.max(g, 1e-9));
  }
  if (minTau < 0.05) {
    push({ level: 'warning', field: 'stability', message: `最小热时间常数 ${minTau.toFixed(3)}s 很小，求解器将自动切小步长，仿真耗时会增加` });
  }

  return issues;
}

export function hasError(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
