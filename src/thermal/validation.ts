import type { Scheme, ValidationIssue } from '../types';

const RANGES = {
  cellThrough: { min: 0.2, max: 8, suggested: 2.8 },
  cellInPlane: { min: 5, max: 80, suggested: 26 },
  insulation: { min: 0.01, max: 0.12, suggested: 0.024 },
  adhesive: { min: 0.2, max: 6, suggested: 1.2 },
  aluminium: { min: 70, max: 260, suggested: 165 },
  steel: { min: 12, max: 90, suggested: 45 },
  thickness: { min: 0.05, max: 100, suggested: 2 },
};

function issue(init: ValidationIssue): ValidationIssue {
  return init;
}

export function validateScheme(scheme: Scheme): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const spec = scheme.cellSpecs.find((s) => s.id === scheme.defaultSpecId) ?? scheme.cellSpecs[0];

  if (!spec) {
    issues.push({
      id: 'no-cell-spec', severity: 'error', scope: 'cell', field: 'cellSpecs', value: 'empty',
      message: '至少需要一种电芯规格。', repairable: false,
    });
    return issues;
  }

  for (const [cellId, ov] of Object.entries(scheme.cellOverrides ?? {})) {
    if (ov.kThroughWmK !== undefined) {
      const v = ov.kThroughWmK;
      if (!Number.isFinite(v) || v <= 0 || v < RANGES.cellThrough.min || v > RANGES.cellThrough.max) {
        issues.push(issue({
          id: `${cellId}-kThrough`,
          severity: 'error',
          scope: 'cell',
          targetId: cellId,
          targetName: cellId,
          field: 'kThroughWmK',
          value: v,
          message: `${cellId} 的厚度方向导热系数 ${v} W/(m·K) 超出方壳电芯有效范围 ${RANGES.cellThrough.min}–${RANGES.cellThrough.max}，疑似数量级填错。继续计算会产生虚假的极强热连接和极小稳定步长。`,
          expectedRange: [RANGES.cellThrough.min, RANGES.cellThrough.max],
          suggestedValue: spec.kThroughWmK || RANGES.cellThrough.suggested,
          repairable: true,
        }));
      }
    }
    if (ov.kInPlaneWmK !== undefined) {
      const v = ov.kInPlaneWmK;
      if (!Number.isFinite(v) || v <= 0 || v < RANGES.cellInPlane.min || v > RANGES.cellInPlane.max) {
        issues.push({
          id: `${cellId}-kInPlane`,
          severity: 'error',
          scope: 'cell',
          targetId: cellId,
          targetName: cellId,
          field: 'kInPlaneWmK',
          value: v,
          message: `${cellId} 的面内导热系数 ${v} W/(m·K) 超出有效范围 ${RANGES.cellInPlane.min}–${RANGES.cellInPlane.max}，疑似单位或数量级错误。`,
          expectedRange: [RANGES.cellInPlane.min, RANGES.cellInPlane.max],
          suggestedValue: spec.kInPlaneWmK || RANGES.cellInPlane.suggested,
          repairable: true,
        });
      }
    }
  }

  const materialChecks: Array<[string, number, { min: number; max: number; suggested: number }, string]> = [
    ['隔热垫导热系数', scheme.module.insulation.conductivityWmK, RANGES.insulation, 'insulation.k'],
    ['导热胶导热系数', scheme.module.adhesive.conductivityWmK, RANGES.adhesive, 'adhesive.k'],
    ['铝排导热系数', scheme.module.busbar.conductivityWmK, RANGES.aluminium, 'busbar.k'],
    ['冷板导热系数', scheme.module.coldPlate.conductivityWmK, RANGES.aluminium, 'coldPlate.k'],
    ['钢壳导热系数', scheme.module.shell.conductivityWmK, RANGES.steel, 'shell.k'],
  ];
  for (const [name, value, range, field] of materialChecks) {
    if (!Number.isFinite(value) || value <= 0 || value < range.min || value > range.max) {
      issues.push({
        id: `material-${field}`, severity: 'error', scope: 'material', field, value,
        targetName: name,
        message: `${name}=${value} W/(m·K) 不在 ${range.min}–${range.max} W/(m·K) 的材料合理区间。`,
        expectedRange: [range.min, range.max], suggestedValue: range.suggested, repairable: true,
      });
    }
  }

  for (const [name, layer] of [
    ['隔热垫', scheme.module.insulation],
    ['导热胶', scheme.module.adhesive],
    ['铝排', scheme.module.busbar],
    ['模组外壳', scheme.module.shell],
    ['冷板', scheme.module.coldPlate],
  ] as const) {
    if (!Number.isFinite(layer.thicknessMm) || layer.thicknessMm < 0 || layer.thicknessMm > 100) {
      issues.push({
        id: `thickness-${layer.id}`, severity: 'error', scope: 'material', field: `${layer.id}.thicknessMm`,
        value: layer.thicknessMm, targetName: name,
        message: `${name}厚度 ${layer.thicknessMm} mm 超出 0–100 mm 可计算范围。`,
        expectedRange: [0, 100], suggestedValue: RANGES.thickness.suggested, repairable: true,
      });
    }
  }

  const totalCells = scheme.cabin.clusterCount * scheme.cabin.modulesPerCluster * scheme.cabin.cellsPerModule;
  if (totalCells <= 0 || totalCells > 20000) {
    issues.push({
      id: 'cell-count-range', severity: totalCells > 20000 ? 'warning' : 'error', scope: 'layout', field: 'cellCount',
      value: totalCells, message: `当前节点数 ${totalCells}，建议演示不超过 12000；超过 20000 可能超出浏览器缓冲和交互预算。`,
      repairable: false,
    });
  }

  if (scheme.cabin.cellsPerModule !== scheme.cabin.cellColumns * scheme.cabin.cellRows) {
    issues.push({
      id: 'module-grid-mismatch', severity: 'warning', scope: 'layout', field: 'cellRows',
      value: `${scheme.cabin.cellColumns}x${scheme.cabin.cellRows}`,
      message: `每模组电芯数 ${scheme.cabin.cellsPerModule} 与网格 ${scheme.cabin.cellColumns}×${scheme.cabin.cellRows} 不一致，末尾会出现空格。`,
      repairable: false,
    });
  }

  for (const c of scheme.cabin.cooling) {
    if (c.pumpFailed) {
      issues.push({
        id: `pump-failed-${c.id}`, severity: 'warning', scope: 'cooling', targetId: c.id, targetName: c.name,
        field: 'pumpFailed', value: true, message: `${c.name} 泵停运：该支路冷却液流量置零，邻近簇将仅通过壳体/空气弱耦合升温。`,
        repairable: false,
      });
    }
    if (!(c.inletTempC > -20 && c.inletTempC < 60)) {
      issues.push({
        id: `cooling-temp-${c.id}`, severity: 'error', scope: 'cooling', targetId: c.id, targetName: c.name,
        field: 'inletTempC', value: c.inletTempC, message: '进液温度应在 -20–60 ℃。', expectedRange: [-20, 60], suggestedValue: 28, repairable: true,
      });
    }
  }

  if (!scheme.trigger.targets.length) {
    issues.push({ id: 'no-trigger', severity: 'error', scope: 'physics', field: 'trigger.targets', value: 0, message: '至少选择一个触发电芯。', repairable: false });
  }
  if (scheme.trigger.targets.length > 2) {
    issues.push({ id: 'too-many-triggers', severity: 'warning', scope: 'physics', field: 'trigger.targets', value: scheme.trigger.targets.length, message: '需求支持两处同时触发；多余触发点仍会计算，但评审对比可能不直观。', repairable: false });
  }

  return issues;
}

export function repairScheme(scheme: Scheme, issueIds?: string[]): Scheme {
  const next = structuredClone(scheme);
  const idSet = issueIds ? new Set(issueIds) : null;
  const should = (id: string) => !idSet || idSet.has(id);
  const spec = next.cellSpecs.find((s) => s.id === next.defaultSpecId) ?? next.cellSpecs[0];

  for (const issue of validateScheme(next)) {
    if (!issue.repairable || !should(issue.id)) continue;
    if (issue.scope === 'cell' && issue.targetId) {
      const field = issue.field as 'kThroughWmK' | 'kInPlaneWmK';
      next.cellOverrides[issue.targetId] = {
        ...next.cellOverrides[issue.targetId],
        [field]: issue.suggestedValue ?? spec[field],
      };
    }
    if (issue.id === 'material-insulation.k') next.module.insulation.conductivityWmK = RANGES.insulation.suggested;
    if (issue.id === 'material-adhesive.k') next.module.adhesive.conductivityWmK = RANGES.adhesive.suggested;
    if (issue.id === 'material-busbar.k') next.module.busbar.conductivityWmK = RANGES.aluminium.suggested;
    if (issue.id === 'material-coldPlate.k') next.module.coldPlate.conductivityWmK = RANGES.aluminium.suggested;
    if (issue.id === 'material-shell.k') next.module.shell.conductivityWmK = RANGES.steel.suggested;
    if (issue.field.endsWith('thicknessMm') && typeof issue.suggestedValue === 'number') {
      if (issue.id.includes('insulation')) next.module.insulation.thicknessMm = issue.suggestedValue;
      if (issue.id.includes('adhesive')) next.module.adhesive.thicknessMm = issue.suggestedValue;
      if (issue.id.includes('busbar')) next.module.busbar.thicknessMm = issue.suggestedValue;
      if (issue.id.includes('shell')) next.module.shell.thicknessMm = issue.suggestedValue;
      if (issue.id.includes('coldPlate')) next.module.coldPlate.thicknessMm = issue.suggestedValue;
    }
    if (issue.scope === 'cooling' && issue.targetId && issue.field === 'inletTempC') {
      const c = next.cabin.cooling.find((x) => x.id === issue.targetId);
      if (c) c.inletTempC = 28;
    }
  }
  next.updatedAt = Date.now();
  return next;
}

export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
