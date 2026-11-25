import { useStudio } from '../store';
import { NumberField, Panel, SelectField, Toggle, Badge, Stat } from '../components/ui';
import type { Detector, DetectorKind } from '../types';
import type { Notify } from '../App';

export default function SafetyPage({ notify: _notify }: { notify: Notify }) {
  void _notify;
  const { scheme, updateScheme, currentRun } = useStudio();

  const addDetector = (kind: DetectorKind) => {
    updateScheme((d) => {
      const idx = d.cabin.detectors.length + 1;
      d.cabin.detectors.push({
        id: `det-${kind}-${Date.now()}`,
        kind,
        name: `${kind === 'gas' ? '可燃气体' : kind === 'smoke' ? '烟感' : '温感'} ${idx}`,
        position: { x: 0, y: 2.2, z: 0.6 },
        alarmThreshold: kind === 'gas' ? 0.8 : kind === 'smoke' ? 0.12 : 57,
        rateThreshold: kind === 'temperature' ? 8 : 0,
        zoneId: 'zone-cluster-1',
      });
    });
  };

  const updateDetector = (id: string, patch: Partial<Detector>) => {
    updateScheme((d) => {
      const det = d.cabin.detectors.find((x) => x.id === id);
      if (det) Object.assign(det, patch);
    });
  };

  const alarmFor = (id: string) => currentRun?.alarms.find((a) => a.detectorId === id);
  const coolingResult = (id: string) => currentRun?.cooling.find((c) => c.circuitId === id);

  return (
    <div className="page-grid">
      <div className="stat-grid">
        <Stat label="探测器" value={scheme.cabin.detectors.length} unit="个" />
        <Stat label="液冷支路" value={scheme.cabin.cooling.length} unit="路" />
        <Stat label="喷放延时" value={scheme.suppression.releaseDelayS} unit="s" tone="warn" />
        <Stat label="降温速率" value={scheme.suppression.coolingRateCPerMin} unit="℃/min" />
      </div>

      <div className="grid-2">
        <div style={{ display: 'grid', gap: 18 }}>
          <Panel title="探测器布置与分区报警" subtitle="分区模型按喷发气体量、烟气量和对流热估算报警时刻；右侧显示最近一次仿真结果。"
            actions={<>
              <button className="btn btn-small" onClick={() => addDetector('gas')}>＋气体</button>
              <button className="btn btn-small" onClick={() => addDetector('smoke')}>＋烟感</button>
              <button className="btn btn-small" onClick={() => addDetector('temperature')}>＋温感</button>
            </>}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>名称/类型</th><th>分区</th><th>X</th><th>Y</th><th>Z</th><th>阈值</th><th>最近报警</th><th></th></tr></thead>
                <tbody>
                  {scheme.cabin.detectors.map((d) => {
                    const alarm = alarmFor(d.id);
                    return (
                      <tr key={d.id}>
                        <td style={{ minWidth: 130 }}>
                          <input value={d.name} onChange={(e) => updateDetector(d.id, { name: e.target.value })} />
                          <select value={d.kind} onChange={(e) => updateDetector(d.id, { kind: e.target.value as DetectorKind })}>
                            <option value="gas">可燃气体</option><option value="smoke">烟感</option><option value="temperature">温感</option>
                          </select>
                        </td>
                        <td><input value={d.zoneId ?? ''} onChange={(e) => updateDetector(d.id, { zoneId: e.target.value })} /></td>
                        {(['x', 'y', 'z'] as const).map((axis) => (
                          <td key={axis}><input type="number" step="0.1" value={d.position[axis]}
                            onChange={(e) => updateDetector(d.id, { position: { ...d.position, [axis]: Number(e.target.value) } })} /></td>
                        ))}
                        <td><input type="number" step="0.01" value={d.alarmThreshold}
                          onChange={(e) => updateDetector(d.id, { alarmThreshold: Number(e.target.value) })} /></td>
                        <td>{alarm ? (alarm.timeS === null ? <Badge tone="gray">未报警</Badge> : <Badge tone="red">{alarm.timeS.toFixed(0)}s</Badge>) : <span className="muted">运行后</span>}</td>
                        <td><button className="btn btn-small btn-danger" onClick={() => updateScheme((s) => { s.cabin.detectors = s.cabin.detectors.filter((x) => x.id !== d.id); })}>删</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {currentRun && <p className="muted small mt-12">报警估算来自运行 <span className="mono">{currentRun.id.slice(0, 18)}</span>；峰值见评审报告。</p>}
          </Panel>

          <Panel title="全氟己酮喷放" subtitle="延时包含探测确认、逻辑与启动瓶响应；喷放后按目标降温速率形成负焓流。">
            <Toggle label="启用灭火介质喷放" checked={scheme.suppression.active}
              onChange={(v) => updateScheme((d) => { d.suppression.active = v; })} />
            <div className="form-grid three mt-12">
              <NumberField label="喷放延时" value={scheme.suppression.releaseDelayS} unit="s" min={0}
                onChange={(v) => updateScheme((d) => { d.suppression.releaseDelayS = v; })} />
              <NumberField label="设计降温速率" value={scheme.suppression.coolingRateCPerMin} unit="℃/min" min={0}
                onChange={(v) => updateScheme((d) => { d.suppression.coolingRateCPerMin = v; })} />
              <NumberField label="有效持续时间" value={scheme.suppression.durationS} unit="s"
                onChange={(v) => updateScheme((d) => { d.suppression.durationS = v; })} />
            </div>
            <SelectField label="介质" value={scheme.suppression.agentName}
              options={[{ value: '全氟己酮 C6F12O', label: '全氟己酮 C6F12O' }, { value: '七氟丙烷 HFC-227ea', label: '七氟丙烷' }, { value: '细水雾', label: '细水雾' }]}
              onChange={(v) => updateScheme((d) => { d.suppression.agentName = v; })} />
          </Panel>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          {scheme.cabin.cooling.map((circuit) => {
            const result = coolingResult(circuit.id);
            return (
              <Panel key={circuit.id} title={circuit.name} subtitle={`覆盖 ${circuit.clusterIds.join(', ')}；沿管序对冷却液节点做稳定混合。`}
                actions={result ? <Badge tone={result.failed ? 'red' : 'green'}>{result.failed ? '泵停运' : `峰值液温 ${result.peakFluidTempC}℃`}</Badge> : undefined}>
                <Toggle label="支路可用" checked={circuit.active} onChange={(v) => updateScheme((d) => {
                  const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.active = v;
                })} />
                <Toggle label="模拟该路液冷泵停电/故障" checked={circuit.pumpFailed} onChange={(v) => updateScheme((d) => {
                  const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.pumpFailed = v;
                  if (v) c.active = true;
                })} hint="故障时流量置零，电芯只能经冷板热容和壳体弱耦合升温。" />
                <div className="form-grid three mt-12">
                  <NumberField label="进液温度" value={circuit.inletTempC} unit="℃" onChange={(v) => updateScheme((d) => {
                    const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.inletTempC = v;
                  })} />
                  <NumberField label="流量" value={circuit.flowLpm} unit="L/min" onChange={(v) => updateScheme((d) => {
                    const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.flowLpm = v;
                  })} />
                  <NumberField label="管长" value={circuit.pipeLengthM} step={0.1} unit="m" onChange={(v) => updateScheme((d) => {
                    const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.pipeLengthM = v;
                  })} />
                  <NumberField label="密度" value={circuit.densityKgM3} unit="kg/m³" onChange={(v) => updateScheme((d) => {
                    const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.densityKgM3 = v;
                  })} />
                  <NumberField label="比热容" value={circuit.fluidCpJkgK} unit="J/kgK" onChange={(v) => updateScheme((d) => {
                    const c = d.cabin.cooling.find((x) => x.id === circuit.id)!; c.fluidCpJkgK = v;
                  })} />
                </div>
                {result && <p className="muted small">最近运行带走热量：{(result.heatRemovedJ / 1e6).toFixed(2)} MJ</p>}
              </Panel>
            );
          })}
          <Panel title="探测设计提示">
            <p className="muted small">
              可燃气体探测器通常布置在顶部或泄压口附近；烟感受气流和空调影响，应结合通风路径；温感/温升电缆适合贴簇或模组布置。
              本系统的分区模型用于方案比选，不能替代 GB 51048、NB/T 42090 等试验或消防性能化设计。
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
