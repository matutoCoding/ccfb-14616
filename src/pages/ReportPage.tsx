import { useMemo, useState } from 'react';
import { useStudio } from '../store';
import { Panel, Badge, Stat } from '../components/ui';
import { buildComparisonRows, buildHtmlReport, downloadTextFile, rowsToCsv } from '../report/report';
import { buildComparisonVariants } from '../report/variants';
import { executeScheme } from '../simulation/runSimulation';
import { idbPutScheme } from '../db';
import type { RunSummary, Scheme } from '../types';
import type { Notify, PageKey } from '../App';

export default function ReportPage({ notify, onNavigate }: { notify: Notify; onNavigate: (p: PageKey) => void }) {
  const { scheme, schemes, runs, currentRun, addRun, removeRun, loadRun, setCurrentRunId } = useStudio();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [compareDuration, setCompareDuration] = useState(3600);
  const [extraSchemes, setExtraSchemes] = useState<Scheme[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>(() => runs.slice(0, 8).map((r) => r.id));

  const allSchemes = useMemo(() => [...extraSchemes, ...schemes], [extraSchemes, schemes]);

  const checkedRuns = useMemo(() => {
    const set = new Set(checkedIds);
    const selected = runs.filter((r) => set.has(r.id));
    return selected.length ? selected : runs.slice(0, 8);
  }, [runs, checkedIds]);

  const rows = useMemo(() => buildComparisonRows(checkedRuns, allSchemes), [checkedRuns, allSchemes]);

  const toggleId = (id: string) => {
    setCheckedIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };

  const runComparison = async () => {
    setBusy(true);
    const variants = buildComparisonVariants(scheme);
    setExtraSchemes((prev) => [...variants, ...prev]);
    const ids: string[] = [];
    try {
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        setProgress(`正在运行 ${i + 1}/${variants.length}：${variant.name}`);
        await idbPutScheme(variant);
        const { run } = await executeScheme(variant, { durationS: compareDuration, preferGpu: true });
        await addRun(run);
        ids.push(run.id);
      }
      setCheckedIds(ids);
      notify('对比方案组已完成并写入 IndexedDB', 'success');
    } catch (error) {
      console.error(error);
      notify(`对比运行失败：${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const exportCsv = () => {
    downloadTextFile(`热失控方案对比_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8');
    notify('CSV 对比表已导出');
  };

  const exportHtml = () => {
    const html = buildHtmlReport(scheme, checkedRuns, rows);
    downloadTextFile(`储能舱热失控评审报告_${Date.now()}.html`, html, 'text/html;charset=utf-8');
    notify('HTML 评审报告已导出，可在浏览器中打印为 PDF', 'success');
  };

  return (
    <div className="page-grid">
      <Panel title="评审结论概览" subtitle="所有方案与帧数据均保存在浏览器 IndexedDB；导出的 HTML 可直接发给专家并离线打开。"
        actions={
          <>
            <button className="btn" onClick={() => onNavigate('simulation')}>返回仿真</button>
            <button className="btn" onClick={exportCsv} disabled={!rows.length}>导出 CSV</button>
            <button className="btn btn-primary" onClick={exportHtml} disabled={!rows.length}>导出专家 HTML 报告</button>
          </>
        }>
        <div className="stat-grid">
          <Stat label="已保存运行" value={runs.length} unit="组" />
          <Stat label="当前对比行" value={rows.length} unit="组" />
          <Stat label="最佳首→次时间" value={best(rows.map((r) => r.firstToSecondS).filter(Boolean) as number[], Math.max)} unit="s" tone="good" />
          <Stat label="最少失控数" value={best(rows.map((r) => r.runawayCount), Math.min)} tone="good" />
        </div>
      </Panel>

      <Panel title="一键方案对比组" subtitle="自动生成：不加垫/2mm/5mm、2mm/8mm 间距、0s/15s/60s 喷放和无喷放。种子异常覆盖值会在对比副本中清除。">
        <div className="row spread">
          <label className="row small muted">每组物理时长
            <select className="btn" value={compareDuration} onChange={(e) => setCompareDuration(Number(e.target.value))}>
              <option value={900}>15 分钟</option>
              <option value={1800}>30 分钟</option>
              <option value={3600}>60 分钟</option>
              <option value={7200}>2 小时</option>
            </select>
          </label>
          <button className="btn btn-good" disabled={busy} onClick={runComparison}>{busy ? '对比计算中…' : '▶ 运行 8 组方案对比'}</button>
        </div>
        {progress && <div className="mt-12"><div className="progress-track"><div className="progress-bar" style={{ width: '45%' }} /></div><p className="muted small mt-12">{progress}</p></div>}
      </Panel>

      <Panel title="关键指标对比表" subtitle="要求字段：首次蔓延时间/首颗到第二颗间隔、最终失控电芯数；可勾选历史运行加入导出。">
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>加入</th><th>方案</th><th>垫 mm</th><th>间距 mm</th><th>喷放 s</th>
              <th>第二颗时刻 s</th><th>首→次 s</th><th>失控数</th><th>比例</th><th>最高温 ℃</th><th>结论</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const run = checkedRuns.find((x) => x.schemeId === r.schemeId && x.schemeName === r.schemeName);
                return (
                  <tr key={`${r.schemeId}-${r.schemeName}`}>
                    <td><input type="checkbox" checked={checkedIds.includes(run?.id ?? '')} onChange={() => run && toggleId(run.id)} /></td>
                    <td style={{ minWidth: 220 }}><b>{r.schemeName}</b><br /><span className="muted small">{r.schemeId}</span></td>
                    <td>{Number.isNaN(r.insulationThicknessMm) ? '—' : r.insulationThicknessMm}</td>
                    <td>{r.cellGapMm}</td>
                    <td>{r.releaseDelayS}</td>
                    <td>{r.firstPropagationS ?? <Badge tone="green">未蔓延</Badge>}</td>
                    <td><b>{r.firstToSecondS ?? '—'}</b></td>
                    <td className={r.runawayCount > 1 ? 'bad' : 'ok'} style={{ color: r.runawayCount > 1 ? '#fca5a5' : '#86efac', fontWeight: 800 }}>{r.runawayCount}</td>
                    <td>{(r.runawayFraction * 100).toFixed(1)}%</td>
                    <td>{r.maxTempC}</td>
                    <td>{r.verdict}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={11}><div className="empty-state">暂无对比运行，请先运行仿真或一键生成对比组。</div></td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="IndexedDB 中的仿真结果" subtitle="帧数据、事件、探测器报警和计算后端均随 RunSummary 持久化。">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th></th><th>运行</th><th>方案</th><th>后端</th><th>节点</th><th>耗时</th><th>失控</th><th>首→次</th><th></th></tr></thead>
            <tbody>
              {runs.map((r: RunSummary) => (
                <tr key={r.id} style={{ background: currentRun?.id === r.id ? 'rgba(56,189,248,.08)' : undefined }}>
                  <td><input type="checkbox" checked={checkedIds.includes(r.id)} onChange={() => toggleId(r.id)} /></td>
                  <td className="mono small">{new Date(r.createdAt).toLocaleString()}<br />{r.id.slice(0, 24)}</td>
                  <td>{r.schemeName}</td>
                  <td><Badge tone={r.backend === 'webgpu' ? 'green' : 'amber'}>{r.backend}</Badge></td>
                  <td>{r.cellCount}</td>
                  <td>{(r.computeElapsedMs / 1000).toFixed(1)}s</td>
                  <td>{r.runawayCount}</td>
                  <td>{r.firstToSecondS ?? '—'}</td>
                  <td><div className="row"><button className="btn btn-small" onClick={async () => {
                    setCurrentRunId(r.id);
                    if (!r.frames) await loadRun(r.id);
                    onNavigate('simulation');
                  }}>回放</button>
                    <button className="btn btn-small btn-danger" onClick={() => removeRun(r.id)}>删除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function best(values: number[], fn: (...args: number[]) => number): number | string {
  if (!values.length) return '—';
  return Math.round(fn(...values));
}
