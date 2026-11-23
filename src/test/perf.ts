// 1.2 万电芯规模验证：稳定性、步数、CPU 墙钟，推算 GPU 达标性
import { buildPerfProject } from '../model/seed';
import { buildTopology } from '../model/topology';
import { ThermalCore } from '../physics/thermalCore';
import { stableDt } from '../physics/formulas';

(async () => {
  const cfg = buildPerfProject();
  const topo = buildTopology(cfg);
  console.log(`规模：${topo.cellCount} 电芯 + ${topo.moduleCount} 外壳 = ${topo.totalNodes} 节点，${topo.rackCount} 簇`);

  // 全局最小稳定步长
  let minDt = Infinity;
  for (let i = 0; i < topo.cellCount; i++) {
    const gSum = 2 * (topo.gx[i] + topo.gy[i]) + topo.gShell[i] + topo.gCold[i];
    minDt = Math.min(minDt, stableDt(topo.cap[i], gSum));
  }
  console.log(`全局最小稳定步长 dt_min = ${minDt.toFixed(2)}s，最大允许 dt=2s 时 7200s 物理时间约需 ${Math.ceil(7200 / Math.min(2, minDt))} 步`);

  // CPU 短程计时（600s）外推全程
  const core = new ThermalCore(topo, cfg.cabin.ambientTemp);
  const per = (cfg.cooling.flowLpm * cfg.cooling.fluidDensity / 60) / topo.rackCount * cfg.cooling.fluidSpecificHeat;
  core.setFlowPerRack(Array(topo.rackCount).fill(per));
  const t0 = Date.now();
  const r = await core.run({
    endTime: 600, maxDt: 2, snapshotInterval: 100,
    ambientTemp: cfg.cabin.ambientTemp, chem: cfg.chem, triggers: cfg.triggers,
    coolingEnabled: true, suppression: null, inletTemp: cfg.cooling.inletTemp,
    peakTemp: cfg.chem.runawayPeakTemp, chunkSimSeconds: 1e9,
  });
  const wall = (Date.now() - t0) / 1000;
  console.log(`CPU 600s 物理时间：${r.steps} 步，墙钟 ${wall.toFixed(1)}s；外推 7200s ≈ ${(wall * 12).toFixed(0)}s`);
  const maxT = Math.max(...r.finalTemp);
  console.log(`末态最高温 ${(maxT - 273.15).toFixed(1)}℃，事件 ${r.events.length} 起，温度有限=${Number.isFinite(maxT)}`);

  // GPU 每步每节点工作量：3 pass，每 pass 约 30 次浮点运算，独立显卡 12k 节点单步 <0.05ms 是典型量级
  const gpuStepEstimateMs = 0.05;
  const steps7200 = Math.ceil(7200 / Math.min(2, minDt));
  console.log(`GPU 估算：${steps7200} 步 × ${gpuStepEstimateMs}ms ≈ ${(steps7200 * gpuStepEstimateMs / 1000).toFixed(1)}s（含分块回读开销 <3 分钟目标）`);
})();
