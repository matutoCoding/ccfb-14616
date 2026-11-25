import type { ProjectConfig, ValidationIssue, CellSpec } from '../types';
import { RANGES, MATERIAL_CONDUCTIVITY } from './constants';

/**
 * 参数校验:单位/数量级错误在这里拦下,而不是让求解器算出"一舱炸"。
 * error = 物理上无法计算或几乎必然是填错;warning = 偏离工程经验但允许试算。
 */
export function validateConfig(cfg: ProjectConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);

  const checkConductivity = (label: string, k: number, thick = 1) => {
    if (!Number.isFinite(k) || k <= 0) {
      push({ level: 'error', field: label, message: `${label} 导热系数非正数:${k}`, value: k });
      return;
    }
    if (k < RANGES.conductivity.min || k > RANGES.conductivity.max) {
      push({
        level: 'error', field: label, value: k,
        expected: `合理区间 ${RANGES.conductivity.min}~${RANGES.conductivity.max} W/(m·K)`,
        message: `${label} 导热系数 ${k} 超出合理区间两个数量级以上,疑似单位填错(常见:气凝胶 0.018、铝 202、空气 0.026)`,
      });
    } else if (thick > 0 && label.includes('隔热垫') && k > 1) {
      push({
        level: 'warning', field: label, value: k,
        message: `隔热垫导热系数 ${k} 比气凝胶典型值(0.018)高两个数量级,垫了几乎不隔热,请确认是否误填成铝的数值`,
      });
    }
  };

  const checkCell = (cell: CellSpec, idx?: number) => {
    const tag = idx === undefined ? '电芯缺省参数' : `电芯 #${idx}`;
    const range = (field: keyof typeof RANGES, v: number, name: string) => {
      const r = RANGES[field];
      if (!Number.isFinite(v)) {
        push({ level: 'error', cellIndex: idx, field, message: `${tag} ${name} 不是有限数值:${v}`, value: v });
      } else if (v < r.min || v > r.max) {
        push({
          level: 'error', cellIndex: idx, field, value: v,
          expected: `${r.min}~${r.max} ${r.unit}`,
          message: `${tag} ${name}=${v} ${r.unit} 超出合理区间,疑似数量级/单位填错`,
        });
      }
    };
    range('specificHeat', cell.specificHeat, '比热');
    range('mass', cell.mass, '质量');
    range('trHeatTotal', cell.trHeatTotal, '热失控放热量');
    range('ventDuration', cell.ventDuration, '喷发时长');
    range('ventGasMol', cell.ventGasMol, '喷发气体量');
    range('temp', cell.selfHeatStartT, '自产热起始温度');
    range('temp', cell.trTriggerT, '自产热起始/触发热量温度');
    if (cell.selfHeatStartT >= cell.trTriggerT) {
      push({ level: 'error', cellIndex: idx, field: 'trTriggerT',
        message: `${tag} 自产热起始温度 ${cell.selfHeatStartT}K 不低于失控触发温度 ${cell.trTriggerT}K` });
    }
    // 能量密度合理性:放热量 / 质量
    const specificEnergy = cell.trHeatTotal / cell.mass;
    if (specificEnergy > 2e6 || specificEnergy < 2e3) {
      push({ level: 'warning', cellIndex: idx, field: 'trHeatTotal', value: cell.trHeatTotal,
        message: `${tag} 单位质量放热量 ${specificEnergy.toExponential(2)} J/kg 偏离电池常见区间(2e3~2e6),核对 kJ/J 单位` });
    }
  };

  checkCell(cfg.cell);
  for (const [k, ov] of Object.entries(cfg.cellOverrides)) {
    const idx = Number(k);
    checkCell({ ...cfg.cell, ...ov }, idx);
    // 与缺省规格做数量级比对:差 5 倍以上基本是单位/小数点错误
    const ratioChecks: [keyof CellSpec, string][] = [
      ['specificHeat', '比热'], ['mass', '质量'], ['trHeatTotal', '放热量'],
      ['ventDuration', '喷发时长'], ['ventGasMol', '喷发气体量'],
    ];
    for (const [field, label] of ratioChecks) {
      const v = ov[field];
      const base = cfg.cell[field];
      if (typeof v === 'number' && typeof base === 'number' && base > 0) {
        const ratio = v / base;
        if (ratio >= 5 || ratio <= 0.2) {
          push({
            level: 'error', cellIndex: idx, field, value: v,
            expected: `缺省值 ${base} 的 0.2~5 倍内`,
            message: `电芯 #${idx} ${label}=${v},是缺省值 ${base} 的 ${ratio.toFixed(2)} 倍,偏离一个数量级,疑似单位填错(kJ/J、J/g 等)`,
          });
        }
      }
    }
    const contactK = (ov as { contactK?: number }).contactK;
    if (contactK !== undefined) {
      if (contactK < RANGES.conductivity.min || contactK > RANGES.conductivity.max) {
        push({
          level: 'error', cellIndex: idx, field: 'contactK', value: contactK,
          expected: `${RANGES.conductivity.min}~${RANGES.conductivity.max} W/(m·K)`,
          message: `电芯 #${idx} 接触导热系数 ${contactK} 超出合理区间,疑似小数点/数量级填错(气凝胶应 ~0.018,铝 ~202)`,
        });
      } else if (contactK > 5) {
        push({
          level: 'warning', cellIndex: idx, field: 'contactK', value: contactK,
          message: `电芯 #${idx} 接触导热 ${contactK} 接近金属量级,隔热垫对该电芯形同虚设,会显著改变蔓延路径`,
        });
      }
    }
  }

  // 夹层材料
  const il = cfg.cluster.interlayers;
  checkConductivity('隔热垫', il.aerogelPad.conductivity, il.aerogelPad.thickness);
  checkConductivity('铝排', il.aluminumBar.conductivity);
  checkConductivity('导热胶', il.thermalGlue.conductivity);
  for (const [name, m] of [['隔热垫', il.aerogelPad], ['铝排', il.aluminumBar], ['导热胶', il.thermalGlue]] as const) {
    if (m.thickness < 0 || m.thickness > RANGES.thickness.max) {
      push({ level: 'error', field: name, value: m.thickness,
        message: `${name}厚度 ${m.thickness}m 异常,注意厚度单位是米(mm 数值要除以 1000)` });
    }
  }
  checkConductivity('模组外壳', cfg.cluster.moduleLayout.wallConductivity);
  checkConductivity('液冷板', cfg.cluster.moduleLayout.coldPlateConductivity);

  // 布置规模
  const { cellsX, cellsZ } = cfg.cluster.moduleLayout;
  if (cellsX * cellsZ > 4096 || cellsX < 1 || cellsZ < 1) {
    push({ level: 'error', field: 'moduleLayout', message: `单模组电芯数 ${cellsX * cellsZ} 异常(1~4096)` });
  }
  const totalCells = cfg.clusterCount * cfg.cluster.modulesPerCluster * cellsX * cellsZ;
  if (totalCells > 20000) {
    push({ level: 'warning', field: 'clusterCount',
      message: `总电芯数 ${totalCells} 超过 2 万,WebGPU 缓冲与回放内存压力大` });
  }
  if (cfg.cooling.flowLpm <= 0) {
    push({ level: 'error', field: 'flowLpm', value: cfg.cooling.flowLpm, message: '液冷流量必须为正' });
  }
  if (cfg.triggers.length === 0) {
    push({ level: 'warning', field: 'triggers', message: '未设置任何触发电芯,仿真不会发生热失控' });
  }
  const trigBad = cfg.triggers.find((t) => t.cellGlobalIndex >= totalCells || t.cellGlobalIndex < 0);
  if (trigBad) {
    push({ level: 'error', field: 'triggers',
      message: `触发电芯序号 ${trigBad.cellGlobalIndex} 超出总电芯数 ${totalCells}` });
  }
  // 探测器阈值
  for (const d of cfg.detectors) {
    if (!(d.threshold > 0)) push({ level: 'error', field: `detector:${d.id}`, message: `探测器 ${d.id} 阈值非正` });
  }
  return issues;
}

export function hasError(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

export { MATERIAL_CONDUCTIVITY };
