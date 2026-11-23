// 储能舱热失控蔓延仿真计算着色器（WGSL）
// 与 src/physics/thermalCore.ts 的 CPU 参照解逐式对应：
// 显式欧拉 + 分段自产热 + 热失控状态机 + 液冷显式温升 + 喷放降温
// 缓冲打包遵守 WebGPU 限制：每阶段 storage buffer ≤ maxStorageBuffersPerShaderStage(通常 8)
// 三个 pass：heatReduce（液冷热量原子归算）→ cooling（冷板温度）→ integrate（积分）

struct Params {
  nCell: u32,
  nModule: u32,
  nRack: u32,
  modulesPerRack: u32,
  dt: f32,
  time: f32,
  coolingOn: u32,
  supActive: u32,
  supCoolRate: f32,
  ambient: f32,
  inletTemp: f32,
  tOnset: f32,
  tTrigger: f32,
  runawayEnergy: f32,
  ventDuration: f32,
  peakTemp: f32,
  tableLen: u32,
  pad0: u32,
  pad1: f32,
  pad2: f32,
};

// 电芯动态状态（读写），每元素 32 字节
struct CellState {
  temp: f32,
  state: u32,
  energy: f32,
  vent: f32,
  newRunaway: u32,
  extPower: f32,
  extForce: u32,
  pad: u32,
};

// 电芯静态参数（只读），每元素 64 字节
struct CellStatic {
  cap: f32,
  gx: f32,
  gy: f32,
  gShell: f32,
  gCold: f32,
  shellNode: u32,
  moduleId: u32,
  rackId: u32,
  n0: i32,
  n1: i32,
  n2: i32,
  n3: i32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
  pad3: f32,
};

// 模组外壳（冷板温度与外壳状态打包）
struct ModuleStatic {
  shellCap: f32,
  shellGAmbient: f32,
  shellGNext: f32,
  rack: u32,
};

struct ModuleDyn {
  shellTemp: f32,
  coldTemp: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> cells: array<CellState>;          // nCell
@group(0) @binding(2) var<storage, read> statics: array<CellStatic>;             // nCell
@group(0) @binding(3) var<storage, read_write> modules: array<ModuleDyn>;        // nModule
@group(0) @binding(4) var<storage, read> modStatic: array<ModuleStatic>;         // nModule
@group(0) @binding(5) var<storage, read> tableT: array<f32>;
@group(0) @binding(6) var<storage, read> tableQ: array<f32>;
@group(0) @binding(7) var<storage, read_write> rackHeat: array<atomic<u32>>;      // nRack，定点 mW
@group(0) @binding(8) var<storage, read> mdotCp: array<f32>;                     // nRack

fn selfHeat(t: f32) -> f32 {
  let n = P.tableLen;
  if (t <= tableT[0]) { return tableQ[0]; }
  for (var i: u32 = 1u; i < n; i = i + 1u) {
    if (t <= tableT[i]) {
      let f = (t - tableT[i - 1u]) / (tableT[i] - tableT[i - 1u]);
      return tableQ[i - 1u] + f * (tableQ[i] - tableQ[i - 1u]);
    }
  }
  return tableQ[n - 1u];
}

// pass0：归算每簇液冷换热功率（原子加，mW 定点）
@compute @workgroup_size(64)
fn heatReduce(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.nCell) { return; }
  if (P.coolingOn == 0u || mdotCp[statics[i].rackId] <= 0.0) { return; }
  var qc = statics[i].gCold * (cells[i].temp - modules[statics[i].moduleId].coldTemp);
  qc = clamp(qc, 0.0, 4.0e6);
  atomicAdd(&rackHeat[statics[i].rackId], u32(qc * 1000.0));
}

// pass1：簇热量 → 各模组冷板温度
@compute @workgroup_size(64)
fn cooling(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  if (id >= P.nModule) { return; }
  let r = modStatic[id].rack;
  if (P.coolingOn == 0u || mdotCp[r] <= 0.0) {
    modules[id].coldTemp = P.inletTemp;
    return;
  }
  let heatW = f32(atomicLoad(&rackHeat[r])) / 1000.0;
  let rise = clamp(heatW / mdotCp[r], 0.0, 150.0);
  let local = f32(id % P.modulesPerRack) + 0.5;
  let frac = local / f32(P.modulesPerRack);
  modules[id].coldTemp = P.inletTemp + frac * rise;
}

// pass2：电芯 + 外壳积分
@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  let total = P.nCell + P.nModule;
  if (id >= total) { return; }

  if (id < P.nCell) {
    let i = id;
    let st = statics[i];
    var T = cells[i].temp;
    var qConv = 0.0;
    if (st.n0 >= 0) { qConv = qConv + st.gx * (cells[u32(st.n0)].temp - T); }
    if (st.n1 >= 0) { qConv = qConv + st.gx * (cells[u32(st.n1)].temp - T); }
    if (st.n2 >= 0) { qConv = qConv + st.gy * (cells[u32(st.n2)].temp - T); }
    if (st.n3 >= 0) { qConv = qConv + st.gy * (cells[u32(st.n3)].temp - T); }
    qConv = qConv + st.gShell * (modules[st.shellNode - P.nCell].shellTemp - T);
    if (P.coolingOn == 1u && mdotCp[st.rackId] > 0.0) {
      qConv = qConv + st.gCold * (modules[st.moduleId].coldTemp - T);
    }

    var qGen = 0.0;
    var s = cells[i].state;
    if (s < 2u) { qGen = qGen + selfHeat(T); }

    if (s == 0u && T >= P.tOnset) { s = 1u; }
    if (s == 0u && cells[i].extForce == 1u) {
      s = 2u;
      cells[i].vent = P.ventDuration;
      cells[i].newRunaway = 1u;
    }
    if (s == 1u && (T >= P.tTrigger || cells[i].extForce == 1u)) {
      s = 2u;
      cells[i].vent = P.ventDuration;
      cells[i].newRunaway = 1u;
    }
    if (s == 2u) {
      let qr = P.runawayEnergy / max(P.ventDuration, 1e-6);
      qGen = qGen + qr;
      cells[i].vent = cells[i].vent - P.dt;
      cells[i].energy = cells[i].energy + qr * P.dt;
      if (cells[i].vent <= 0.0 || cells[i].energy >= P.runawayEnergy) {
        s = 3u;
        cells[i].vent = 0.0;
      }
    }
    qGen = qGen + cells[i].extPower;
    cells[i].state = s;

    if (P.supActive == 1u) { qConv = qConv - P.supCoolRate * st.cap; }

    var nT = T + P.dt * (qConv + qGen) / st.cap;
    if (s == 2u) {
      let alpha = 1.0 - exp(-P.dt / 2.0);
      nT = nT + alpha * (P.peakTemp - nT);
    }
    cells[i].temp = clamp(nT, P.ambient, 1500.0);
  } else {
    let m = id - P.nCell;
    let ms = modStatic[m];
    let Ts = modules[m].shellTemp;
    var q = ms.shellGAmbient * (P.ambient - Ts);
    if (m > 0u && modStatic[m - 1u].rack == ms.rack) {
      q = q + ms.shellGNext * (modules[m - 1u].shellTemp - Ts);
    }
    if (m + 1u < P.nModule && modStatic[m + 1u].rack == ms.rack) {
      q = q + ms.shellGNext * (modules[m + 1u].shellTemp - Ts);
    }
    let nTs = Ts + P.dt * q / ms.shellCap;
    modules[m].shellTemp = clamp(nTs, P.ambient, 1200.0);
  }
}
