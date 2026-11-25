import { useMemo, useState, type ReactNode } from 'react';
import { useStudio } from '../store';
import { IssueList, NumberField, Panel, Badge, Stat } from '../components/ui';
import { repairScheme, validateScheme } from '../thermal/validation';
import { runHandCalcCheck, type HandCalcCheck } from '../thermal/solver';
import type { MaterialLayer } from '../types';
import type { Notify } from '../App';

function LayerFields({ layer, onChange, extra }: { layer: MaterialLayer; onChange: (patch: Partial<MaterialLayer>) => void; extra?: ReactNode }) {
  return (
    <div className="form-grid three">
      <NumberField label={`${layer.name}厚度`} value={layer.thicknessMm} step={0.1} min={0} unit="mm" onChange={(v) => onChange({ thicknessMm: v })} />
      <NumberField label="导热系数" value={layer.conductivityWmK} step={0.001} min={0} unit="W/mK" onChange={(v) => onChange({ conductivityWmK: v })} />
      {extra}
    </div>
  );
}

export default function ModulesPage({ notify }: { notify: Notify }) {
  const { scheme, updateScheme, replaceScheme } = useStudio();
  const [specId, setSpecId] = useState(scheme.defaultSpecId);
  const [check, setCheck] = useState<HandCalcCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const issues = useMemo(() => validateScheme(scheme), [scheme]);
  const spec = scheme.cellSpecs.find((s) => s.id === specId) ?? scheme.cellSpecs[0];

  const updateSpec = (patch: Partial<typeof spec>) => {
    updateScheme((d) => {
      const target = d.cellSpecs.find((s) => s.id === spec.id);
      if (target) Object.assign(target, patch);
    });
  };

  const updateLayer = (key: 'insulation' | 'adhesive' | 'busbar' | 'shell' | 'coldPlate', patch: Partial<MaterialLayer>) => {
    updateScheme((d) => Object.assign(d.module[key], patch));
  };

  const repair = (ids?: string[]) => {
    const next = repairScheme(scheme, ids);
    replaceScheme(next);
    notify(ids ? '已按材料合理区间修复该参数' : '已一键修复所有可修复异常参数', 'success');
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const result = await runHandCalcCheck();
      setCheck(result);
      notify(result.passed ? `手算校核通过：误差 ${(result.errorFraction * 100).toFixed(2)}%` : '手算校核未通过', result.passed ? 'success' : 'error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page-grid">
      <div className="stat-grid">
        <Stat label="电芯规格" value={spec.name.includes('磷酸铁锂') ? 'LFP 280Ah' : 'NCM 280Ah'} />
        <Stat label="质量×比热 C" value={Math.round(spec.massKg * spec.specificHeatJkgK).toLocaleString()} unit="J/K" />
        <Stat label="自产热起始" value={spec.selfHeatStartC} unit="℃" />
        <Stat label="热失控起始" value={spec.onsetTempC} unit="℃" tone="warn" />
      </div>

      <div className="grid-2">
        <div style={{ display: 'grid', gap: 18 }}>
          <Panel title="电芯规格库" subtitle="质量、比热、自产热分段、失控能量和喷发时长均参与积分。">
            <div className="row spread">
              <select className="btn" value={specId} onChange={(e) => setSpecId(e.target.value)}>
                {scheme.cellSpecs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="btn btn-small" onClick={() => updateScheme((d) => { d.defaultSpecId = spec.id; })}>设为舱体默认规格</button>
              <Badge tone={spec.chemistry === 'LFP' ? 'green' : 'amber'}>{spec.chemistry}</Badge>
            </div>
            <div className="form-grid three mt-12">
              <NumberField label="容量" value={spec.capacityAh} unit="Ah" onChange={(v) => updateSpec({ capacityAh: v })} />
              <NumberField label="质量" value={spec.massKg} step={0.01} unit="kg" onChange={(v) => updateSpec({ massKg: v })} />
              <NumberField label="比热容" value={spec.specificHeatJkgK} unit="J/kgK" onChange={(v) => updateSpec({ specificHeatJkgK: v })} />
              <NumberField label="厚向导热 k⊥" value={spec.kThroughWmK} step={0.1} unit="W/mK" onChange={(v) => updateSpec({ kThroughWmK: v })} />
              <NumberField label="面内导热 k∥" value={spec.kInPlaneWmK} step={0.1} unit="W/mK" onChange={(v) => updateSpec({ kInPlaneWmK: v })} />
              <NumberField label="失控起始" value={spec.onsetTempC} unit="℃" onChange={(v) => updateSpec({ onsetTempC: v })} />
              <NumberField label="自产热起始" value={spec.selfHeatStartC} unit="℃" onChange={(v) => updateSpec({ selfHeatStartC: v })} />
              <NumberField label="失控总放热" value={spec.runawayHeatJ} step={100000} unit="J" onChange={(v) => updateSpec({ runawayHeatJ: v })} />
              <NumberField label="自身保留比例" value={spec.retainedFraction} step={0.01} min={0} max={1} onChange={(v) => updateSpec({ retainedFraction: v })} />
              <NumberField label="喷发时长" value={spec.eruptionDurationS} unit="s" onChange={(v) => updateSpec({ eruptionDurationS: v })} />
              <NumberField label="喷发气体量" value={spec.ventGasM3} step={0.01} unit="m³" onChange={(v) => updateSpec({ ventGasM3: v })} />
            </div>
            <h3 className="form-section-title">自产热温度分段（达到阈值取该段功率）</h3>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>起始温度 ℃</th><th>自产热功率 W</th></tr></thead>
                <tbody>
                  {spec.selfHeat.map((seg, idx) => (
                    <tr key={seg.id}>
                      <td><input type="number" value={seg.fromC} onChange={(e) => updateScheme((d) => {
                        const target = d.cellSpecs.find((s) => s.id === spec.id)!;
                        target.selfHeat[idx].fromC = Number(e.target.value);
                      })} /></td>
                      <td><input type="number" value={seg.heatW} onChange={(e) => updateScheme((d) => {
                        const target = d.cellSpecs.find((s) => s.id === spec.id)!;
                        target.selfHeat[idx].heatW = Number(e.target.value);
                      })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="三电芯串排手算校核" subtitle="固定首颗 600℃，C=5000 J/K，G₁₂=G₂₃=5 W/K；解析根 280.7 s。">
            <div className="row">
              <button className="btn btn-primary" disabled={checking} onClick={runCheck}>{checking ? '校核计算中…' : '运行 5% 误差校核'}</button>
              {check && <Badge tone={check.passed ? 'green' : 'red'}>{check.passed ? '通过' : '未通过'}：{check.computedS.toFixed(1)} s / 误差 {(check.errorFraction * 100).toFixed(2)}%</Badge>}
            </div>
            {check && <p className="muted small mt-12">{check.formula}</p>}
          </Panel>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          <Panel title="参数诊断" subtitle="种子舱故意保留三颗数量级错误电芯；正式仿真前必须报告并处理。">
            <IssueList issues={issues} onRepairOne={(id) => repair([id])} onRepairAll={() => repair()} />
          </Panel>

          <Panel title="单电芯异常导热覆盖值" subtitle="这些覆盖值用于复现“填表时数量级错误”的数据治理场景。">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>电芯</th><th>k⊥ W/mK</th><th>k∥ W/mK</th><th></th></tr></thead>
                <tbody>
                  {Object.entries(scheme.cellOverrides).map(([id, ov]) => (
                    <tr key={id}>
                      <td><b>{id}</b></td>
                      <td style={{ color: ov.kThroughWmK !== undefined && (ov.kThroughWmK < 0.2 || ov.kThroughWmK > 8) ? '#fca5a5' : undefined }}>
                        {ov.kThroughWmK ?? '—'}
                      </td>
                      <td style={{ color: ov.kInPlaneWmK !== undefined && (ov.kInPlaneWmK < 5 || ov.kInPlaneWmK > 80) ? '#fca5a5' : undefined }}>
                        {ov.kInPlaneWmK ?? '—'}
                      </td>
                      <td><button className="btn btn-small" onClick={() => updateScheme((d) => { delete d.cellOverrides[id]; })}>移除覆盖</button></td>
                    </tr>
                  ))}
                  {!Object.keys(scheme.cellOverrides).length && <tr><td colSpan={4} className="muted">暂无单电芯覆盖值。</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="模组热阻材料层" subtitle="热导 G=A/Σ(tᵢ/kᵢ)；铝排按并联热桥计入。">
            <LayerFields layer={scheme.module.insulation} onChange={(p) => updateLayer('insulation', p)} />
            <LayerFields layer={scheme.module.adhesive} onChange={(p) => updateLayer('adhesive', p)} />
            <LayerFields layer={scheme.module.busbar} onChange={(p) => updateLayer('busbar', p)}
              extra={<NumberField label="每间隙铝排数" value={scheme.module.busbarCountPerGap} min={0} onChange={(v) => updateScheme((d) => { d.module.busbarCountPerGap = v; })} />} />
            <LayerFields layer={scheme.module.shell} onChange={(p) => updateLayer('shell', p)} />
            <LayerFields layer={scheme.module.coldPlate} onChange={(p) => updateLayer('coldPlate', p)}
              extra={<NumberField label="接触面积系数" value={scheme.module.coldPlateContactAreaFactor} step={0.01} min={0.1} max={1} onChange={(v) => updateScheme((d) => { d.module.coldPlateContactAreaFactor = v; })} />} />
            <NumberField label="表面发射率" value={scheme.module.radiationEmissivity} step={0.05} min={0} max={1}
              onChange={(v) => updateScheme((d) => { d.module.radiationEmissivity = v; })} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
