import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useStudio } from '../store';
import { CONTAINERS, createDefaultScheme, createStressScheme } from '../data/defaults';
import { arrangeCells } from '../thermal/graph';
import { NumberField, Panel, SelectField, Badge } from '../components/ui';
import type { CabinObject, ContainerKind, Vec3 } from '../types';
import type { PageKey, Notify } from '../App';

const VIEW_W = 1100;
const VIEW_H = 430;

export default function LayoutPage({ notify, onNavigate }: { notify: Notify; onNavigate: (p: PageKey) => void }) {
  const { scheme, updateScheme, addScheme } = useStudio();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const arranged = useMemo(() => arrangeCells(scheme), [scheme]);
  const c = scheme.cabin.container;
  const scale = Math.min((VIEW_W - 80) / (c.length + 1.4), (VIEW_H - 70) / (c.width + 1.4));
  const px = (x: number) => VIEW_W / 2 + x * scale;
  const pz = (z: number) => VIEW_H / 2 + z * scale;
  const showCells = arranged.cells.length <= 1600;

  const updateCabinNumber = (key: 'clusterCount' | 'modulesPerCluster' | 'cellsPerModule' | 'moduleColumns' | 'cellColumns' | 'cellRows', value: number) => {
    updateScheme((d) => { d.cabin[key] = Math.max(1, Math.round(value)); });
  };

  const setContainer = (kind: ContainerKind) => {
    updateScheme((d) => {
      d.cabin.container = { ...CONTAINERS[kind] };
      if (kind === '20ft' && d.cabin.clusterCount > 1) d.cabin.clusterCount = 1;
    });
  };

  const addObject = () => {
    updateScheme((d) => {
      d.cabin.objects.push({
        id: `obj-${Date.now()}`, kind: 'custom', name: '新设备',
        position: { x: 0, y: 1, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 }, enabled: true,
      });
    });
  };

  const updateObject = (id: string, patch: Partial<CabinObject>) => {
    updateScheme((d) => {
      const obj = d.cabin.objects.find((o) => o.id === id);
      if (obj) Object.assign(obj, patch);
    });
  };

  const updateObjectVec = (id: string, key: 'position' | 'size', axis: keyof Vec3, value: number) => {
    updateScheme((d) => {
      const obj = d.cabin.objects.find((o) => o.id === id);
      if (obj) obj[key][axis] = value;
    });
  };

  const removeObject = (id: string) => updateScheme((d) => { d.cabin.objects = d.cabin.objects.filter((o) => o.id !== id); });

  const pointToMeters = (clientX: number, clientY: number): Vec3 => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0, z: 0 };
    const pt = new DOMPoint(clientX, clientY);
    const ctm = svg.getScreenCTM();
    const p = ctm ? pt.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
    return { x: (p.x - VIEW_W / 2) / scale, y: 0, z: (p.y - VIEW_H / 2) / scale };
  };

  const startDrag = (e: ReactPointerEvent<SVGGElement>, obj: CabinObject) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = pointToMeters(ev.clientX, ev.clientY);
      updateObjectVec(obj.id, 'position', 'x', Math.round(p.x * 100) / 100);
      updateObjectVec(obj.id, 'position', 'z', Math.round(p.z * 100) / 100);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const loadStress = async () => {
    const s = createStressScheme(12000);
    await addScheme(s);
    notify('已生成 12,000 节点性能压测方案', 'success');
  };

  const resetSeed = async () => {
    await addScheme(createDefaultScheme());
    notify('已恢复两簇 40 尺种子舱，包含三颗异常参数电芯', 'success');
  };

  return (
    <div className="page-grid grid-2">
      <div style={{ display: 'grid', gap: 18 }}>
        <Panel title="集装箱与重排" subtitle="修改簇数或每簇模组数后，坐标、热阻连接和实例缓冲全部按同一规则重算。"
          actions={<><button className="btn btn-small" onClick={resetSeed}>恢复种子</button><button className="btn btn-small btn-primary" onClick={loadStress}>12k压测</button></>}>
          <SelectField label="舱型" value={c.kind} onChange={setContainer}
            options={[{ value: '20ft', label: '20尺标准集装箱' }, { value: '40ft', label: '40尺标准集装箱' }]} />
          <div className="form-grid three">
            <NumberField label="簇数" value={scheme.cabin.clusterCount} min={1} max={20} step={1} onChange={(v) => updateCabinNumber('clusterCount', v)} />
            <NumberField label="每簇模组" value={scheme.cabin.modulesPerCluster} min={1} max={80} onChange={(v) => updateCabinNumber('modulesPerCluster', v)} />
            <NumberField label="每模组电芯" value={scheme.cabin.cellsPerModule} min={1} max={120} onChange={(v) => updateCabinNumber('cellsPerModule', v)} />
            <NumberField label="模组横向列" value={scheme.cabin.moduleColumns} min={1} max={10} onChange={(v) => updateCabinNumber('moduleColumns', v)} />
            <NumberField label="电芯列" value={scheme.cabin.cellColumns} min={1} max={20} onChange={(v) => updateCabinNumber('cellColumns', v)} />
            <NumberField label="电芯行" value={scheme.cabin.cellRows} min={1} max={20} onChange={(v) => updateCabinNumber('cellRows', v)} />
          </div>
          <div className="row spread mt-12">
            <div><Badge tone="blue">{arranged.cells.length.toLocaleString()} 电芯节点</Badge>{' '}<Badge tone="gray">{arranged.modules.length} 模组</Badge>{' '}<Badge tone="gray">{arranged.clusters.length} 簇</Badge></div>
            <button className="btn btn-primary" onClick={() => onNavigate('modules')}>下一步：电芯参数</button>
          </div>
        </Panel>

        <Panel title="舱体设备位置" subtitle="俯视图中可直接拖动设备；Y 为高度，也可在表中精确输入。" actions={<button className="btn btn-small" onClick={addObject}>＋ 添加设备</button>}>
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="data">
              <thead><tr><th>名称</th><th>X m</th><th>Y m</th><th>Z m</th><th></th></tr></thead>
              <tbody>
                {scheme.cabin.objects.map((o) => (
                  <tr key={o.id}>
                    <td><input value={o.name} onChange={(e) => updateObject(o.id, { name: e.target.value })} /></td>
                    {(['x', 'y', 'z'] as const).map((axis) => (
                      <td key={axis}><input type="number" step="0.1" value={o.position[axis]}
                        onChange={(e) => updateObjectVec(o.id, 'position', axis, Number(e.target.value))} /></td>
                    ))}
                    <td><button className="btn btn-small btn-danger" onClick={() => removeObject(o.id)}>删</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="俯视布置校核" subtitle="蓝框为集装箱，橙/青块为高压箱、空调、管路等；红点为触发目标。" className="flush">
        <div style={{ padding: 12 }}>
          <svg ref={svgRef} className="layout-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
            <defs>
              <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(148,163,184,.12)" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width={VIEW_W} height={VIEW_H} fill="url(#grid)" />
            <rect x={px(-c.length / 2)} y={pz(-c.width / 2)} width={c.length * scale} height={c.width * scale}
              rx="8" fill="rgba(56,189,248,.055)" stroke="#38bdf8" strokeWidth="2.2" />
            <text x={px(-c.length / 2) + 10} y={pz(-c.width / 2) + 20} fill="#7dd3fc" fontSize="15" fontWeight="700">
              {c.kind} 内部 {c.length.toFixed(2)}×{c.width.toFixed(2)}×{c.height.toFixed(2)} m
            </text>

            {arranged.clusters.map((cl) => (
              <rect key={cl.clusterId} x={px(cl.min.x)} y={pz(cl.min.z)} width={(cl.max.x - cl.min.x) * scale}
                height={(cl.max.z - cl.min.z) * scale} rx="10" fill="rgba(167,139,250,.07)" stroke="#a78bfa" strokeDasharray="7 5" />
            ))}
            {arranged.modules.map((m) => (
              <rect key={m.moduleId} x={px(m.min.x)} y={pz(m.min.z)} width={(m.max.x - m.min.x) * scale}
                height={(m.max.z - m.min.z) * scale} rx="5" fill="rgba(148,163,184,.08)" stroke="rgba(203,213,225,.45)" />
            ))}

            {showCells && arranged.cells.map((cell) => {
              const isTrigger = scheme.trigger.targets.some((t) => t.cellId === cell.id);
              const w = cell.spec.dimensionsMm.x / 1000 * scale;
              const h = cell.spec.dimensionsMm.z / 1000 * scale;
              return <rect key={cell.id} className={`cell-rect ${isTrigger ? 'trigger' : ''}`}
                x={px(cell.position.x) - w / 2} y={pz(cell.position.z) - h / 2} width={Math.max(1.2, w)} height={Math.max(1.2, h)}
                fill={isTrigger ? '#ef4444' : cell.spec.chemistry === 'LFP' ? 'rgba(34,197,94,.72)' : 'rgba(245,158,11,.78)'}>
                <title>{cell.id} · {cell.spec.name}</title>
              </rect>;
            })}
            {!showCells && (
              <text x={VIEW_W / 2} y={VIEW_H - 18} textAnchor="middle" fill="#94a3b8" fontSize="13">
                {arranged.cells.length.toLocaleString()} 颗电芯：俯视图已切换为模组/簇聚合显示，3D 实例化仍逐颗渲染
              </text>
            )}

            {scheme.cabin.detectors.map((d) => (
              <g key={d.id}>
                <circle cx={px(d.position.x)} cy={pz(d.position.z)} r="7"
                  fill={d.kind === 'gas' ? '#a78bfa' : d.kind === 'smoke' ? '#94a3b8' : '#f97316'} stroke="#fff" strokeWidth="1" />
                <text x={px(d.position.x) + 10} y={pz(d.position.z) + 4} fill="#cbd5e1" fontSize="11">{d.name}</text>
              </g>
            ))}

            {scheme.cabin.objects.map((o) => {
              const w = o.size.x * scale;
              const h = o.size.z * scale;
              return (
                <g key={o.id} className="layout-object" onPointerDown={(e) => startDrag(e, o)} opacity={o.enabled ? 1 : 0.35}>
                  <rect x={px(o.position.x) - w / 2} y={pz(o.position.z) - h / 2} width={Math.max(18, w)} height={Math.max(14, h)}
                    rx="5" fill={o.color ?? '#64748b'} fillOpacity="0.72" stroke="#e2e8f0" />
                  <text x={px(o.position.x)} y={pz(o.position.z) + 4} textAnchor="middle">{o.name}</text>
                </g>
              );
            })}
          </svg>
          <p className="muted small mt-12">提示：拖动彩色设备块可调整 X/Z 坐标；探测器位置在“探测喷放”页配置。</p>
        </div>
      </Panel>
    </div>
  );
}
