import { useMemo, useState } from 'react';
import { useStudio } from '../store';
import { arrangeCells } from '../thermal/graph';
import { NumberField, Panel, Badge } from '../components/ui';
import type { TriggerKind, TriggerTarget } from '../types';
import type { Notify, PageKey } from '../App';

const KINDS: Array<{ value: TriggerKind; label: string; desc: string; power: number; duration: number }> = [
  { value: 'nail', label: '针刺', desc: '内短瞬时焦耳热，功率高且持续到短路失效窗口。', power: 12000, duration: 1800 },
  { value: 'overcharge', label: '过充', desc: 'SOC 升高后持续能量注入，可能伴随自产热加剧。', power: 6500, duration: 3600 },
  { value: 'heater', label: '加热板', desc: '外部加热板持续加热电芯底部/侧面。', power: 9000, duration: 900 },
  { value: 'manual', label: '直接起火', desc: '用于复现试验报告：t=0 直接进入热失控喷发。', power: 0, duration: 0 },
];

export default function TriggerPage({ notify, onNavigate }: { notify: Notify; onNavigate: (p: PageKey) => void }) {
  const { scheme, updateScheme } = useStudio();
  const arranged = useMemo(() => arrangeCells(scheme), [scheme]);
  const [clusterIndex, setClusterIndex] = useState(0);
  const [moduleIndex, setModuleIndex] = useState(0);
  const [kind, setKind] = useState<TriggerKind>(scheme.trigger.targets[0]?.kind ?? 'nail');
  const simultaneous = scheme.trigger.targets.length >= 2 || scheme.trigger.simultaneous;

  const safeCluster = Math.min(clusterIndex, scheme.cabin.clusterCount - 1);
  const clusterModules = arranged.modules.filter((m) => m.clusterId === `cluster-${safeCluster + 1}`);
  const safeModule = Math.min(moduleIndex, Math.max(0, clusterModules.length - 1));
  const module = clusterModules[safeModule];
  const moduleCells = module ? arranged.cells.filter((c) => c.moduleId === module.moduleId) : [];

  const commitTargets = (targets: TriggerTarget[], simul = targets.length >= 2) => {
    updateScheme((d) => {
      d.trigger.targets = targets.slice(0, 2);
      d.trigger.simultaneous = simul;
    });
  };

  const chooseKind = (nextKind: TriggerKind) => {
    setKind(nextKind);
    const preset = KINDS.find((k) => k.value === nextKind)!;
    commitTargets(scheme.trigger.targets.map((t) => ({
      ...t,
      kind: nextKind,
      powerW: preset.power || undefined,
      durationS: preset.duration || undefined,
    })));
  };

  const toggleCell = (cellId: string) => {
    const existing = scheme.trigger.targets.find((t) => t.cellId === cellId);
    if (existing) {
      commitTargets(scheme.trigger.targets.filter((t) => t.cellId !== cellId));
      return;
    }
    const preset = KINDS.find((k) => k.value === kind)!;
    const target: TriggerTarget = {
      cellId,
      kind,
      powerW: preset.power || undefined,
      durationS: preset.duration || undefined,
    };
    if (simultaneous && scheme.trigger.targets.length < 2) {
      commitTargets([...scheme.trigger.targets, target], true);
    } else {
      commitTargets([target], false);
    }
  };

  const setTwoMode = (two: boolean) => {
    if (!two) commitTargets(scheme.trigger.targets.slice(0, 1), false);
    else if (scheme.trigger.targets.length === 0) commitTargets([], true);
    else if (scheme.trigger.targets.length === 1) commitTargets(scheme.trigger.targets, true);
  };

  return (
    <div className="page-grid grid-2">
      <div style={{ display: 'grid', gap: 18 }}>
        <Panel title="触发方式" subtitle="三种滥用试验加直接起火；支持两处同时触发。">
          <div className="grid-2" style={{ gap: 10 }}>
            {KINDS.map((k) => (
              <button key={k.value} className={`btn ${kind === k.value ? 'btn-primary' : ''}`} style={{ height: 'auto', padding: 13, textAlign: 'left', display: 'block' }}
                onClick={() => chooseKind(k.value)}>
                <b>{k.label}</b>
                <span className="muted small" style={{ display: 'block', marginTop: 5, whiteSpace: 'normal' }}>{k.desc}</span>
              </button>
            ))}
          </div>
          <div className="row spread mt-16">
            <label className="toggle-row" style={{ margin: 0 }}>
              <span>两处同时触发<small>开启后可在右侧网格选择第二颗电芯</small></span>
              <input type="checkbox" checked={simultaneous} onChange={(e) => setTwoMode(e.target.checked)} />
              <i className="switch" />
            </label>
            <button className="btn" onClick={() => {
              const mid = arranged.cells[Math.floor(arranged.cells.length / 2)]?.id;
              commitTargets(mid ? [scheme.trigger.targets[0] ?? { cellId: 'cell-1', kind }, { cellId: mid, kind }].slice(0, 2) : [], true);
              notify('已设置首尾/中部双触发示例');
            }}>快速设置双点</button>
          </div>
        </Panel>

        <Panel title="触发目标与注入参数" subtitle="功率和持续时间可按厂家试验或滥用报告调整。">
          {scheme.trigger.targets.length === 0 && <div className="empty-state">尚未选择电芯，请在右侧网格点选。</div>}
          {scheme.trigger.targets.map((target, idx) => (
            <div key={target.cellId} className="issue issue-info" style={{ marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <b>触发点 {idx + 1}：{target.cellId}</b>
                <div className="form-grid three mt-12">
                  <NumberField label="热注入功率" value={target.powerW ?? 0} unit="W"
                    onChange={(v) => updateScheme((d) => { d.trigger.targets[idx].powerW = v; })} />
                  <NumberField label="持续时间" value={target.durationS ?? 0} unit="s"
                    onChange={(v) => updateScheme((d) => { d.trigger.targets[idx].durationS = v; })} />
                  <NumberField label="SOC 增量" value={target.soc ?? 0} step={0.05} min={0} max={1}
                    onChange={(v) => updateScheme((d) => { d.trigger.targets[idx].soc = v; })} />
                </div>
              </div>
              <button className="btn btn-small btn-danger" onClick={() => commitTargets(scheme.trigger.targets.filter((t) => t.cellId !== target.cellId))}>移除</button>
            </div>
          ))}
          <div className="row mt-12">
            <button className="btn btn-primary" onClick={() => onNavigate('simulation')}>去仿真页运行 →</button>
            <span className="muted small">仿真页 3D 视图也可开启“点选起火”后直接点电芯。</span>
          </div>
        </Panel>
      </div>

      <Panel title="点选触发电芯" subtitle="按簇/模组筛选；红色描边为当前触发点。">
        <div className="row" style={{ marginBottom: 12 }}>
          <select className="btn" value={safeCluster} onChange={(e) => { setClusterIndex(Number(e.target.value)); setModuleIndex(0); }}>
            {Array.from({ length: scheme.cabin.clusterCount }, (_, i) => <option key={i} value={i}>{`cluster-${i + 1}`}</option>)}
          </select>
          <select className="btn" value={safeModule} onChange={(e) => setModuleIndex(Number(e.target.value))}>
            {clusterModules.map((m, i) => <option key={m.moduleId} value={i}>{m.moduleId}</option>)}
          </select>
          <Badge tone="gray">{moduleCells.length} 颗</Badge>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${scheme.cabin.cellColumns}, minmax(0,1fr))`, gap: 5 }}>
          {moduleCells.map((cell) => {
            const active = scheme.trigger.targets.some((t) => t.cellId === cell.id);
            return (
              <button key={cell.id} className={`btn btn-small ${active ? 'btn-danger' : ''}`}
                style={{ padding: '8px 0', minWidth: 0 }}
                title={`${cell.id} · col ${cell.gridColumn} row ${cell.gridRow}`}
                onClick={() => toggleCell(cell.id)}>
                {cell.index + 1}
              </button>
            );
          })}
        </div>
        <p className="muted small mt-12">编号为全局电芯序号；网格按模组行列排列，和热阻邻接关系一致。</p>
      </Panel>
    </div>
  );
}
