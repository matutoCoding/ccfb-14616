import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStudio } from '../store';
import { arrangeCells } from '../thermal/graph';
import { validateScheme } from '../thermal/validation';
import { repairScheme } from '../thermal/validation';
import { executeScheme } from '../simulation/runSimulation';
import { InstancedRenderer, temperatureColor, type RenderBox, type RenderCell } from '../gpu/InstancedRenderer';
import { Badge, IssueList, Panel, Stat, Toggle } from '../components/ui';
import type { RunSummary } from '../types';
import type { Notify } from '../App';

function hexRgb(hex?: string): [number, number, number] {
  if (!hex) return [0.5, 0.65, 0.85];
  const h = hex.replace('#', '');
  const n = Number.parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function buildBoxes(scheme: ReturnType<typeof useStudio>['scheme'], arranged: ReturnType<typeof arrangeCells>): RenderBox[] {
  const c = scheme.cabin.container;
  const boxes: RenderBox[] = [{
    min: { x: -c.length / 2, y: 0, z: -c.width / 2 },
    max: { x: c.length / 2, y: c.height, z: c.width / 2 },
    color: [0.35, 0.72, 0.95, 0.075],
  }];
  for (const cl of arranged.clusters) {
    boxes.push({ min: cl.min, max: cl.max, color: [0.65, 0.5, 1, 0.055] });
  }
  for (const m of arranged.modules) {
    boxes.push({ min: m.min, max: m.max, color: [0.55, 0.7, 0.9, 0.07] });
  }
  for (const o of scheme.cabin.objects) {
    const [r, g, b] = hexRgb(o.color);
    boxes.push({
      min: { x: o.position.x - o.size.x / 2, y: o.position.y - o.size.y / 2, z: o.position.z - o.size.z / 2 },
      max: { x: o.position.x + o.size.x / 2, y: o.position.y + o.size.y / 2, z: o.position.z + o.size.z / 2 },
      color: [r, g, b, o.enabled ? 0.62 : 0.2],
    });
  }
  for (const d of scheme.cabin.detectors) {
    const color: [number, number, number] = d.kind === 'gas' ? [0.65, 0.45, 1] : d.kind === 'smoke' ? [0.7, 0.76, 0.84] : [1, 0.45, 0.1];
    boxes.push({
      min: { x: d.position.x - 0.07, y: d.position.y - 0.07, z: d.position.z - 0.07 },
      max: { x: d.position.x + 0.07, y: d.position.y + 0.07, z: d.position.z + 0.07 },
      color: [color[0], color[1], color[2], 0.95],
    });
  }
  return boxes;
}

export default function SimulationPage({ notify }: { notify: Notify }) {
  const { scheme, updateScheme, currentRun, addRun, replaceScheme } = useStudio();
  const arranged = useMemo(() => arrangeCells(scheme), [scheme]);
  const cells: RenderCell[] = useMemo(() => arranged.cells.map((c) => ({ position: c.position, dimensionsMm: c.spec.dimensionsMm })), [arranged]);
  const boxes = useMemo(() => buildBoxes(scheme, arranged), [scheme, arranged]);
  const issues = useMemo(() => validateScheme(scheme), [scheme]);
  const blocking = issues.some((i) => i.severity === 'error');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<InstancedRenderer | null>(null);
  const stopRef = useRef(false);
  const [rendererState, setRendererState] = useState<'loading' | 'webgpu' | 'fallback'>('loading');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [durationS, setDurationS] = useState(3600);
  const [preferGpu, setPreferGpu] = useState(true);
  const [displayTime, setDisplayTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [transparent, setTransparent] = useState(true);
  const [showVents, setShowVents] = useState(true);
  const [clipCluster, setClipCluster] = useState('-1');
  const [pickMode, setPickMode] = useState(false);

  const layoutKey = useMemo(() => JSON.stringify({
    id: scheme.id,
    c: scheme.cabin.container.kind,
    n: [scheme.cabin.clusterCount, scheme.cabin.modulesPerCluster, scheme.cabin.cellsPerModule, scheme.cabin.moduleColumns, scheme.cabin.cellColumns, scheme.cabin.cellRows],
  }), [scheme]);

  useEffect(() => {
    let cancelled = false;
    let renderer: InstancedRenderer | null = null;
    setRendererState('loading');
    if (!canvasRef.current) return;
    InstancedRenderer.create(canvasRef.current, cells, boxes).then((r) => {
      if (cancelled || !r) {
        if (!cancelled) setRendererState('fallback');
        r?.dispose();
        return;
      }
      renderer = r;
      rendererRef.current = r;
      r.cabinOpacity = transparent ? 0.38 : 0.92;
      setRendererState('webgpu');
    });
    return () => {
      cancelled = true;
      renderer?.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    if (!currentRun?.frames || !rendererRef.current) return;
    setDisplayTime(0);
    setPlaying(false);
  }, [currentRun?.id]);

  const frameIndex = useMemo(() => {
    if (!currentRun?.frames) return 0;
    const interval = currentRun.frames.intervalS;
    const maxIndex = currentRun.frames.timesS.length - 1;
    return Math.max(0, Math.min(maxIndex, Math.floor(displayTime / interval)));
  }, [currentRun, displayTime]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !currentRun?.frames) return;
    r.setFrame(currentRun.frames, Math.min(frameIndex, currentRun.frames.timesS.length - 1), currentRun.events, displayTime);
  }, [currentRun, frameIndex, displayTime]);

  useEffect(() => { if (rendererRef.current) rendererRef.current.showVents = showVents; }, [showVents]);
  useEffect(() => { if (rendererRef.current) rendererRef.current.cabinOpacity = transparent ? 0.38 : 0.92; }, [transparent]);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const idx = Number(clipCluster);
    if (idx < 0) { r.clipEnabled = false; r.clipX = 0; }
    else { r.clipEnabled = true; r.clipX = arranged.clusters[idx]?.center.x ?? 0; }
  }, [clipCluster, arranged]);

  useEffect(() => {
    if (!playing || !currentRun) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setDisplayTime((t) => {
        const next = t + dt * speed;
        if (next >= currentRun.physicalDurationS) {
          setPlaying(false);
          return currentRun.physicalDurationS;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, currentRun]);

  const handleRun = async (repairFirst = false) => {
    let activeScheme = scheme;
    if (repairFirst) {
      activeScheme = repairScheme(scheme);
      replaceScheme(activeScheme);
      notify('已隔离/修复异常导热参数，使用推荐材料值运行', 'success');
    } else if (blocking) {
      notify('存在阻断级参数诊断，请先修复异常导热系数', 'error');
      return;
    }
    setRunning(true);
    setProgress(0);
    setProgressText('构建热阻网络…');
    stopRef.current = false;
    try {
      const { run } = await executeScheme(activeScheme, {
        durationS,
        preferGpu,
        shouldStop: () => stopRef.current,
        onProgress: (p) => {
          setProgress(Math.round((p.timeS / p.durationS) * 100));
          setProgressText(`${p.backend === 'webgpu' ? 'WebGPU WGSL' : 'CPU 参考'} · ${Math.round(p.timeS)}/${p.durationS} s · 子步 ${p.substepCount}`);
        },
      });
      await addRun(run);
      setProgress(100);
      setProgressText(`${run.backend} 完成：${(run.computeElapsedMs / 1000).toFixed(1)} s`);
      notify(`仿真完成：失控 ${run.runawayCount} 颗，首→次 ${run.firstToSecondS ?? '未蔓延'} s`, run.runawayCount > 1 ? 'info' : 'success');
    } catch (error) {
      console.error(error);
      notify(`仿真失败：${(error as Error).message}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const onCanvasClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!pickMode || !rendererRef.current) return;
    const idx = rendererRef.current.pickCell(e.clientX, e.clientY);
    if (idx === null) return notify('没有点中电芯，请放大或旋转后重试', 'info');
    const cellId = `cell-${idx + 1}`;
    updateTriggerFromClick(cellId, e.shiftKey);
    notify(`已将 ${cellId} 设为手动起火点${e.shiftKey ? '（第二点）' : ''}`, 'success');
  };

  const updateTriggerFromClick = (cellId: string, additive: boolean) => {
    updateScheme((d) => {
      const manual = { cellId, kind: 'manual' as const, powerW: 0, durationS: 0 };
      if (additive && d.trigger.targets.length) {
        d.trigger.targets = [d.trigger.targets[0], manual].slice(0, 2);
        d.trigger.simultaneous = true;
      } else if (additive) {
        d.trigger.targets = [manual];
      } else {
        d.trigger.targets = [manual];
        d.trigger.simultaneous = false;
      }
    });
  };

  const run: RunSummary | null = currentRun;
  const maxTime = run?.physicalDurationS ?? durationS;

  return (
    <div className="page-grid">
      <div className="stat-grid">
        <Stat label="计算节点" value={scheme.cabin.clusterCount * scheme.cabin.modulesPerCluster * scheme.cabin.cellsPerModule} />
        <Stat label="计算后端" value={run?.backend ?? (preferGpu ? 'WebGPU 首选' : 'CPU')} tone={run?.backend === 'webgpu' ? 'good' : undefined} />
        <Stat label="首→次蔓延" value={run?.firstToSecondS ?? '—'} unit={run?.firstToSecondS ? 's' : ''} tone={run?.firstToSecondS && run.firstToSecondS < 120 ? 'bad' : 'warn'} />
        <Stat label="失控电芯" value={run?.runawayCount ?? 0} tone={run && run.runawayCount > 1 ? 'bad' : 'good'} />
      </div>

      {blocking && (
        <Panel title="运行前诊断拦截" subtitle="种子数据中的数量级错误必须先报告/修复，避免产生“一舱全炸”的假结果。">
          <IssueList issues={issues.filter((i) => i.severity === 'error')} compact />
          <div className="row mt-12">
            <button className="btn btn-good" disabled={running} onClick={() => handleRun(true)}>修复异常并运行</button>
            <span className="muted small">也可在“电芯模组”页逐项查看和修复。</span>
          </div>
        </Panel>
      )}

      <div className="visual-stage">
        {rendererState !== 'fallback' && (
          <canvas ref={canvasRef} onClick={onCanvasClick} style={{ cursor: pickMode ? 'crosshair' : 'grab', display: rendererState === 'webgpu' ? 'block' : 'none' }} />
        )}
        {rendererState === 'fallback' && <Heatmap2D run={run} displayTime={displayTime} cells={arranged.cells} />}
        {rendererState === 'loading' && <div className="empty-state" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>正在初始化 WebGPU 实例化渲染器…</div>}

        <div className="stage-overlay">
          <button className={`btn btn-small ${pickMode ? 'btn-danger' : ''}`} onClick={() => setPickMode((v) => !v)}>
            {pickMode ? '🎯 点选模式：点电芯起火' : '🎯 开启点选起火'}
          </button>
          <select className="btn btn-small" value={clipCluster} onChange={(e) => setClipCluster(e.target.value)}>
            <option value="-1">不剖切</option>
            {arranged.clusters.map((c, i) => <option key={c.clusterId} value={i}>剖至 {c.clusterId}</option>)}
          </select>
          {rendererState === 'fallback' && <Badge tone="amber">WebGPU 不可用：2D 热图回退</Badge>}
        </div>

        <div className="stage-panel">
          <div className="glass">
            <Toggle label="舱体/框架半透明" checked={transparent} onChange={setTransparent} />
            <Toggle label="泄压喷发方向" checked={showVents} onChange={setShowVents} />
            <div className="legend" />
            <div className="legend-labels"><span>25℃</span><span>75</span><span>125</span><span>170+</span></div>
          </div>
          <div className="glass">
            <label>物理时长
              <select value={durationS} onChange={(e) => setDurationS(Number(e.target.value))}>
                <option value={600}>10 分钟（快速）</option>
                <option value={1800}>30 分钟</option>
                <option value={3600}>60 分钟</option>
                <option value={7200}>2 小时验收工况</option>
              </select>
            </label>
            <div className="mt-12"><Toggle label="优先 WebGPU 计算着色器" checked={preferGpu} onChange={setPreferGpu} /></div>
            <div className="row mt-12">
              {!running ? <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => handleRun(false)}>▶ 运行仿真</button>
                : <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => { stopRef.current = true; }}>■ 停止</button>}
            </div>
            <div className="progress-track mt-12"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>
            <p className="muted small mt-12">{progressText || 'GPU 分块提交，计算期间页面保持响应'}</p>
          </div>
        </div>
      </div>

      <div className="timeline panel" style={{ borderRadius: 14 }}>
        <button className="btn btn-small btn-primary" disabled={!run} onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ 暂停' : '▶ 回放'}</button>
        <select className="btn btn-small" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={1}>1×</option><option value={10}>10×</option><option value={60}>60×</option><option value={300}>300×</option>
        </select>
        <input type="range" min={0} max={maxTime} step={run?.frames?.intervalS ?? 1} value={displayTime}
          onChange={(e) => { setPlaying(false); setDisplayTime(Number(e.target.value)); }} disabled={!run} />
        <div className="time-label">{formatTime(displayTime)} / {formatTime(maxTime)}</div>
      </div>

      <Panel title="蔓延顺序连线" subtitle="蓝=模组内，橙=跨模组，红=跨簇；时间轴拖动到对应秒后显示。">
        {run?.events.length ? (
          <div className="event-chain">
            {run.events.slice(0, 240).map((e) => (
              <span key={e.order} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button className={`event-chip ${e.via ?? 'intra-module'}`}
                  onClick={() => { setPlaying(false); setDisplayTime(e.timeS); }}
                  title={`${e.cellId} at ${e.timeS}s from ${e.fromCellId ?? 'trigger'}`}>
                  {e.order}. {e.cellId} · {Math.round(e.timeS)}s
                </button>
                <span className="arrow">→</span>
              </span>
            ))}
            {run.events.length > 240 && <Badge tone="amber">仅显示前 240 条，完整顺序见导出报告</Badge>}
          </div>
        ) : <div className="empty-state">运行后这里会按失控顺序生成可点击的蔓延链。</div>}
      </Panel>
    </div>
  );
}

function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function Heatmap2D({ run, displayTime, cells }: { run: RunSummary | null | undefined; displayTime: number; cells: ReturnType<typeof arrangeCells>['cells'] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#07111f'; ctx.fillRect(0, 0, rect.width, rect.height);
    const xs = cells.map((c) => c.position.x), zs = cells.map((c) => c.position.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const scale = Math.min((rect.width - 60) / Math.max(1, maxX - minX), (rect.height - 70) / Math.max(1, maxZ - minZ));
    const ox = 30 - minX * scale + (rect.width - (maxX - minX) * scale) / 2 - 30;
    const oz = 35 - minZ * scale + (rect.height - (maxZ - minZ) * scale) / 2 - 35;
    const frames = run?.frames ?? null;
    const interval = frames?.intervalS ?? 1;
    const fi = frames ? Math.min(frames.timesS.length - 1, Math.floor(displayTime / interval)) : 0;
    cells.forEach((c, i) => {
      const temp = frames ? frames.temperaturesDeciC[fi * frames.cellCount + i] / 10 : 25;
      const state = frames ? frames.states[fi * frames.cellCount + i] : 0;
      const [r, g, b] = temperatureColor(temp, state);
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      const w = Math.max(2, c.spec.dimensionsMm.x / 1000 * scale);
      const h = Math.max(2, c.spec.dimensionsMm.z / 1000 * scale);
      ctx.fillRect(ox + c.position.x * scale - w / 2, oz + c.position.z * scale - h / 2, w, h);
    });
  }, [run, displayTime, cells]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}
