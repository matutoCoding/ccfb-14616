import { cloneScheme } from '../data/defaults';
import type { Scheme } from '../types';

export interface ComparisonVariantGroup {
  key: 'insulation' | 'gap' | 'delay';
  label: string;
  schemes: Scheme[];
}

function withIds(s: Scheme, suffix: string, name: string): Scheme {
  const next = cloneScheme(s);
  next.id = `variant-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
  next.name = name;
  next.createdAt = Date.now();
  next.updatedAt = Date.now();
  // Comparison runs should not be blocked by the deliberate seed faults.
  next.cellOverrides = {};
  return next;
}

export function buildComparisonVariants(base: Scheme): Scheme[] {
  const baseline = withIds(base, 'baseline', '基准：2mm气凝胶 / 3mm间距 / 15s喷放');

  const noPad = withIds(base, 'no-pad', '不加隔热垫 / 3mm间距 / 15s喷放');
  noPad.module.insulation.thicknessMm = 0;

  const thickPad = withIds(base, 'thick-pad', '5mm气凝胶 / 3mm间距 / 15s喷放');
  thickPad.module.insulation.thicknessMm = 5;

  const gap2 = withIds(base, 'gap-2', '2mm间距+2mm垫 / 15s喷放');
  gap2.module.cellGapMm = 2;
  gap2.module.insulation.thicknessMm = 2;

  const gap8 = withIds(base, 'gap-8', '8mm间距+2mm垫 / 15s喷放');
  gap8.module.cellGapMm = 8;

  const delay0 = withIds(base, 'delay-0', '2mm垫 / 3mm间距 / 0s立即喷放');
  delay0.suppression.active = true;
  delay0.suppression.releaseDelayS = 0;

  const delay60 = withIds(base, 'delay-60', '2mm垫 / 3mm间距 / 60s延时喷放');
  delay60.suppression.active = true;
  delay60.suppression.releaseDelayS = 60;

  const noSuppression = withIds(base, 'no-suppression', '2mm垫 / 无喷放');
  noSuppression.suppression.active = false;

  const variants = [baseline, noPad, thickPad, gap2, gap8, delay0, delay60, noSuppression];
  for (const s of variants.slice(0, 7)) s.suppression.active = true;
  noSuppression.suppression.active = false;
  return variants;
}
