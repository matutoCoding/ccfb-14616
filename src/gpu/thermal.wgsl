// 热失控蔓延计算着色器 —— 与 src/physics/referenceSolver.ts 同构的 WGSL 实现
// 显式欧拉积分。为满足 WebGPU 每阶段 ≤8 storage 缓冲限制,电芯/模组字段打包成 struct 数组。

struct Uniforms {
  N: u32, M: u32, cellsX: u32, cellsPerModule: u32,
  platesPerBranch: u32, branchCount: u32, eventMax: u32, triggerCount: u32,
  dt: f32, t: f32, ambientT: f32, inletT: f32,
  gxGap: f32, gxEffK: f32, faceAreaX: f32, gPairZ: f32,
  gShell: f32, gPlate: f32, gPlateFluid: f32, mDotCp: f32,
  radX: f32, radZ: f32, enableRadiation: f32, dischargeT: f32,
  snapshotMax: u32, snapshotSlot: u32, nozzleCount: u32, ioEventBase: u32,
  tC0: f32, tC1: f32, tC2: f32, tC3: f32,
  tC4: f32, tC5: f32, q0: f32, q1: f32,
  q2: f32, q3: f32, q4: f32, q5: f32,
  stoppedMask: u32, miscBase: u32, trigBase: u32, miscStride: u32,
};

// 每颗电芯的全部参数与动态状态打包(一个 storage 缓冲)
struct CellData {
  C: f32, contactK: f32, mass: f32, selfStartT: f32,
  trTriggerT: f32, trHeatTotal: f32, ventDuration: f32, flamePlateauT: f32,
  flameHoldS: f32, state: f32, trTime: f32, pad: f32,
};
struct ModData { shellC: f32, plateC: f32, gShellAmb: f32, pad: f32 };

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read_write> T: array<f32>;
@group(0) @binding(2) var<storage, read_write> Tn: array<f32>;
@group(0) @binding(3) var<storage, read_write> cells: array<CellData>;
@group(0) @binding(4) var<storage, read> mods: array<ModData>;
@group(0) @binding(5) var<storage, read> cellPos: array<f32>;   // N*3
@group(0) @binding(6) var<storage, read> misc: array<f32>;      // 喷嘴 + 触发打包
@group(0) @binding(7) var<storage, read_write> io: array<atomic<i32>>; // 事件 + 计数器
@group(0) @binding(8) var<storage, read_write> snapshots: array<u32>;

// 节点布局:[0,N) 电芯;[N,N+M) 冷板;[N+M,N+2M) 外壳;[N+2M,N+3M) 工质
fn plateIdx(m: u32) -> u32 { return U.N + m; }
fn shellIdx(m: u32) -> u32 { return U.N + U.M + m; }
fn fluidIdx(m: u32) -> u32 { return U.N + 2u * U.M + m; }

fn interpSelf(tC: f32, m: f32) -> f32 {
  if (tC <= U.tC0) { return 0.0; }
  if (tC >= U.tC5) { return m * U.q5; }
  let ts = array<f32, 6>(U.tC0, U.tC1, U.tC2, U.tC3, U.tC4, U.tC5);
  let qs = array<f32, 6>(U.q0, U.q1, U.q2, U.q3, U.q4, U.q5);
  for (var k = 0; k < 5; k = k + 1) {
    if (tC <= ts[k + 1]) {
      let f = clamp((tC - ts[k]) / max(ts[k + 1] - ts[k], 1e-6), 0.0, 1.0);
      return m * (qs[k] + f * (qs[k + 1] - qs[k]));
    }
  }
  return m * U.q5;
}

fn ventProfile(s: f32) -> f32 {
  if (s <= 0.0 || s >= 1.0) { return 0.0; }
  if (s <= 0.25) { return 8.0 * s; }
  return (2.0 / 0.75) * (1.0 - s);
}

fn postVentTemp(plateau: f32, hold: f32, elapsed: f32, vd: f32) -> f32 {
  if (elapsed >= vd && elapsed <= vd + hold) { return plateau; }
  return -1.0;
}

@compute @workgroup_size(1)
fn fluidPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let b = gid.x;
  if (b >= U.branchCount) { return; }
  var tUp = U.inletT;
  for (var s = 0u; s < U.platesPerBranch; s = s + 1) {
    let m = b * U.platesPerBranch + s;
    let fi = fluidIdx(m);
    let pi = plateIdx(m);
    if ((U.stoppedMask & (1u << b)) != 0u) {
      let gNat = 2.5;
      Tn[fi] = (gNat * T[pi] + 0.5 * U.inletT) / (gNat + 0.5);
    } else {
      let gp = U.gPlateFluid;
      let tFluid = (U.mDotCp * tUp + gp * T[pi]) / (U.mDotCp + gp);
      Tn[fi] = tFluid;
      tUp = tFluid;
    }
  }
}

fn pairGX(i: u32, j: u32) -> f32 {
  var ki = U.gxEffK;
  var kj = U.gxEffK;
  let ovI = cells[i].contactK;
  let ovJ = cells[j].contactK;
  if (ovI == ovI) { ki = ovI; }
  if (ovJ == ovJ) { kj = ovJ; }
  let r = U.gxGap * (0.5 / ki + 0.5 / kj);
  return U.faceAreaX / max(r, 1e-9);
}

fn radFrom(j: u32, ti: f32) -> f32 {
  if (U.enableRadiation < 0.5) { return 0.0; }
  var th = -1.0;
  let stj = cells[j].state;
  if (stj == 2.0) {
    th = cells[j].flamePlateauT;
  } else if (stj == 3.0) {
    let pv = postVentTemp(cells[j].flamePlateauT, cells[j].flameHoldS, U.t - cells[j].trTime, cells[j].ventDuration);
    if (pv > 0.0) { th = pv; } else { th = T[j]; }
  } else {
    return 0.0;
  }
  if (th <= ti) { return 0.0; }
  return th * th * th * th - ti * ti * ti * ti;
}

@compute @workgroup_size(256)
fn cellPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= U.N) { return; }
  let m = i / U.cellsPerModule;
  let local = i % U.cellsPerModule;
  var q = 0.0;

  if (local % U.cellsX > 0u) {
    let j = i - 1u;
    q = q + pairGX(i, j) * (T[j] - T[i]) + U.radX * radFrom(j, T[i]);
  }
  if (local % U.cellsX < U.cellsX - 1u) {
    let j = i + 1u;
    q = q + pairGX(i, j) * (T[j] - T[i]) + U.radX * radFrom(j, T[i]);
  }
  if (local >= U.cellsX) {
    let j = i - U.cellsX;
    q = q + U.gPairZ * (T[j] - T[i]) + U.radZ * radFrom(j, T[i]);
  }
  if (local < U.cellsPerModule - U.cellsX) {
    let j = i + U.cellsX;
    q = q + U.gPairZ * (T[j] - T[i]) + U.radZ * radFrom(j, T[i]);
  }
  q = q + U.gShell * (T[shellIdx(m)] - T[i]);
  q = q + U.gPlate * (T[plateIdx(m)] - T[i]);

  let st = cells[i].state;
  if (st == 0.0 || st == 1.0) {
    q = q + interpSelf(T[i] - 273.15, cells[i].mass);
  } else if (st == 2.0) {
    let s = (U.t - cells[i].trTime) / max(cells[i].ventDuration, 1e-6);
    q = q + (cells[i].trHeatTotal / max(cells[i].ventDuration, 1e-6)) * ventProfile(s);
  }

  if (U.dischargeT >= 0.0 && U.t >= U.dischargeT) {
    let px = cellPos[i * 3u];
    let py = cellPos[i * 3u + 1u];
    let pz = cellPos[i * 3u + 2u];
    for (var k = 0u; k < U.nozzleCount; k = k + 1u) {
      let base = U.miscBase + k * 5u;
      let dx = misc[base] - px;
      let dy = misc[base + 1u] - py;
      let dz = misc[base + 2u] - pz;
      let rr = misc[base + 3u];
      if (dx * dx + dy * dy + dz * dz <= rr * rr) {
        q = q - cells[i].C * misc[base + 4u];
        break;
      }
    }
  }

  var newT = T[i] + (q / cells[i].C) * U.dt;
  if (st == 2.0) { newT = max(newT, cells[i].flamePlateauT); }
  if (st == 3.0) {
    let pv = postVentTemp(cells[i].flamePlateauT, cells[i].flameHoldS, U.t - cells[i].trTime, cells[i].ventDuration);
    if (pv > 0.0) { newT = max(newT, pv); }
  }
  if (newT > 1500.0 || newT != newT) { atomicAdd(&io[U.ioEventBase + 1u], 1); }

  // 强制触发:存在 misc 的触发区,(cell,time) 相邻两个 f32
  var forced = false;
  for (var ti = 0u; ti < U.triggerCount; ti = ti + 1u) {
    let tcell = u32(misc[U.trigBase + ti * 2u]);
    let ttime = misc[U.trigBase + ti * 2u + 1u];
    if (tcell == i && U.t >= ttime) { forced = true; }
  }
  if ((forced && (st == 0.0 || st == 1.0)) || ((st == 0.0 || st == 1.0) && newT >= cells[i].trTriggerT)) {
    cells[i].state = 2.0;
    cells[i].trTime = U.t;
    let idx = atomicAdd(&io[U.ioEventBase], 1);
    if (idx < i32(U.eventMax)) {
      atomicStore(&io[u32(idx) * 2u], bitcast<i32>(i));
      atomicStore(&io[u32(idx) * 2u + 1u], bitcast<i32>(U.t));
    }
  } else if (st == 2.0 && U.t - cells[i].trTime >= cells[i].ventDuration) {
    cells[i].state = 3.0;
  } else if (st == 0.0 && newT >= cells[i].selfStartT) {
    cells[i].state = 1.0;
  }
  Tn[i] = newT;
}

@compute @workgroup_size(64)
fn shellPlatePass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  if (m >= U.M) { return; }
  let sh = shellIdx(m);
  let pl = plateIdx(m);
  let fl = fluidIdx(m);
  var qs = mods[m].gShellAmb * (U.ambientT - T[sh]);
  var qp = U.gPlateFluid * (Tn[fl] - T[pl]);
  let base = m * U.cellsPerModule;
  for (var k = 0u; k < U.cellsPerModule; k = k + 1u) {
    qs = qs + U.gShell * (T[base + k] - T[sh]);
    qp = qp + U.gPlate * (T[base + k] - T[pl]);
  }
  Tn[sh] = T[sh] + (qs / mods[m].shellC) * U.dt;
  Tn[pl] = T[pl] + (qp / mods[m].plateC) * U.dt;
}

@compute @workgroup_size(256)
fn snapshotPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let slot = U.snapshotSlot;
  let i = gid.x;
  if (i >= U.N) { return; }
  let qt = u32(clamp((Tn[i] - 200.0) * 64.0, 0.0, 65535.0));
  let word = (qt & 0xFFFFu) | ((u32(cells[i].state) & 0xFFu) << 16u);
  snapshots[slot * U.N + i] = word;
}
