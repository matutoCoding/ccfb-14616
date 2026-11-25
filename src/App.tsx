import { useEffect, useState } from 'react';
import { useStudio } from './store';
import LayoutPage from './pages/LayoutPage';
import ModulesPage from './pages/ModulesPage';
import TriggerPage from './pages/TriggerPage';
import SimulationPage from './pages/SimulationPage';
import SafetyPage from './pages/SafetyPage';
import ReportPage from './pages/ReportPage';

export type PageKey = 'layout' | 'modules' | 'trigger' | 'simulation' | 'safety' | 'report';
export type Notify = (message: string, tone?: 'info' | 'success' | 'error') => void;

const NAV: Array<{ key: PageKey; label: string; icon: string; title: string; desc: string }> = [
  { key: 'layout', label: '舱体布置', icon: '🧊', title: '舱体布置', desc: '20/40尺集装箱、簇模组重排、热源与辅件定位' },
  { key: 'modules', label: '电芯模组', icon: '🔋', title: '电芯与模组参数', desc: 'LFP/三元规格、材料热阻层和异常参数诊断' },
  { key: 'trigger', label: '触发场景', icon: '⚡', title: '触发场景', desc: '过充、针刺、加热板与双点同时触发' },
  { key: 'simulation', label: '蔓延仿真', icon: '🌡️', title: '热失控蔓延仿真', desc: 'WebGPU WGSL 计算、实例化温度场、时间轴与蔓延链' },
  { key: 'safety', label: '探测喷放', icon: '🚨', title: '探测、液冷与喷放', desc: '探测器分区报警、液冷泵故障和全氟己酮降温' },
  { key: 'report', label: '评审报告', icon: '📋', title: '方案对比与评审报告', desc: '隔热垫、间距、喷放延时比选，导出 HTML/CSV' },
];

export default function App() {
  const { ready, scheme } = useStudio();
  const [page, setPage] = useState<PageKey>('layout');
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: string }>>([]);
  const [gpu, setGpu] = useState<boolean | null>(null);

  useEffect(() => {
    setGpu(typeof navigator !== 'undefined' && 'gpu' in navigator);
  }, []);

  const notify: Notify = (message, tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };

  if (!ready) {
    return <div className="empty-state" style={{ margin: 80 }}>正在从 IndexedDB 装载舱体方案与仿真结果…</div>;
  }

  const current = NAV.find((n) => n.key === page)!;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">热</div>
          <div>
            <h1>储能蔓延仿真</h1>
            <p>ESS Thermal Propagation Studio</p>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => setPage(item.key)}>
              <span className="ico">{item.icon}</span>
              <span className="label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-card">
          <b>计算环境</b>
          <div><span className={`backend-dot ${gpu ? 'ok' : ''}`} />{gpu ? 'WebGPU 可用，WGSL 计算着色器就绪' : '未检测到 WebGPU，将使用 CPU 参考求解器'}</div>
          <p className="muted mt-12">当前方案：{scheme.name}<br />节点：{(scheme.cabin.clusterCount * scheme.cabin.modulesPerCluster * scheme.cabin.cellsPerModule).toLocaleString()} 颗</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="crumb">储能电站消防安全评审 / {current.label}</div>
            <h2>{current.title}</h2>
          </div>
          <div className="top-actions">
            <span className="badge badge-blue">IndexedDB 自动保存</span>
            <button className="btn" onClick={() => setPage('simulation')}>进入仿真 →</button>
          </div>
        </header>
        <div className="content">
          {page === 'layout' && <LayoutPage notify={notify} onNavigate={setPage} />}
          {page === 'modules' && <ModulesPage notify={notify} />}
          {page === 'trigger' && <TriggerPage notify={notify} onNavigate={setPage} />}
          {page === 'simulation' && <SimulationPage notify={notify} />}
          {page === 'safety' && <SafetyPage notify={notify} />}
          {page === 'report' && <ReportPage notify={notify} onNavigate={setPage} />}
        </div>
      </main>

      <div className="toast-wrap">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.message}</div>)}
      </div>
    </div>
  );
}
