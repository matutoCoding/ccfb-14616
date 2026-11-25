// Explicit thermal RC integrator for ESS propagation.
// The TypeScript reference solver in src/thermal/solver.ts implements the
// same update equation; keep these two paths numerically aligned.

struct SimParams {
  dt: f32,
  time: f32,
  nodeCount: u32,
  cellCount: u32,
  onsetTempC: f32,
  selfHeatStartC: f32,
  runawayHeatJ: f32,
  retainedFraction: f32,
  eruptionDurationS: f32,
  suppressionStartS: f32,
  suppressionRateKPerS: f32,
  trigger0: i32,
  trigger1: i32,
  triggerPower0W: f32,
  triggerPower1W: f32,
  triggerDuration0S: f32,
  triggerDuration1S: f32,
  selfT1: f32,
  selfP1: f32,
  selfT2: f32,
  selfP2: f32,
  selfT3: f32,
  selfP3: f32,
  selfT4: f32,
  selfP4: f32,
};

struct NodeInfo {
  capacity: f32,
  kind: u32,
  cellIndex: i32,
  edgeStart: i32,
  edgeEnd: i32,
  pad0: u32,
};

struct ThermalEdge {
  neighbor: i32,
  conductance: f32,
  kind: u32,
  pad0: u32,
};

struct RuntimeNode {
  runawayTime: f32,
  state: u32,
  peakTemp: f32,
  heatReceivedJ: f32,
};

@group(0) @binding(0) var<storage, read> tempIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> tempOut: array<f32>;
@group(0) @binding(2) var<storage, read> nodeInfo: array<NodeInfo>;
@group(0) @binding(3) var<storage, read> edges: array<ThermalEdge>;
@group(0) @binding(4) var<storage, read_write> runtime: array<RuntimeNode>;
@group(0) @binding(5) var<uniform> params: SimParams;

fn self_heat_power(tempC: f32, p: SimParams) -> f32 {
  var power: f32 = 0.0;
  if (tempC >= p.selfT1) { power = max(power, p.selfP1); }
  if (tempC >= p.selfT2) { power = max(power, p.selfP2); }
  if (tempC >= p.selfT3) { power = max(power, p.selfP3); }
  if (tempC >= p.selfT4) { power = max(power, p.selfP4); }
  return power;
}

fn trigger_heat(node: i32, timeS: f32, p: SimParams) -> f32 {
  var q: f32 = 0.0;
  if (node == p.trigger0 && timeS < p.triggerDuration0S) {
    q += p.triggerPower0W;
  }
  if (node == p.trigger1 && timeS < p.triggerDuration1S) {
    q += p.triggerPower1W;
  }
  return q;
}

@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i: u32 = gid.x;
  if (i >= params.nodeCount) { return; }

  let info: NodeInfo = nodeInfo[i];

  // kind 4 is a fixed-temperature boundary (ambient/chiller inlet).
  if (info.kind == 4u) {
    tempOut[i] = tempIn[i];
    runtime[i].peakTemp = max(runtime[i].peakTemp, tempIn[i]);
    return;
  }

  var q: f32 = 0.0;
  var sumG: f32 = 0.0;
  for (var e: i32 = info.edgeStart; e < info.edgeEnd; e = e + 1) {
    let edge: ThermalEdge = edges[e];
    let j: u32 = u32(edge.neighbor);
    let g: f32 = edge.conductance;
    q += g * (tempIn[j] - tempIn[i]);
    sumG += g;

    // Node kind 3 = coolant; edge kind 3 = plate-coolant.
    if (info.kind == 3u && edge.kind == 3u) {
      runtime[i].heatReceivedJ += g * (tempIn[j] - tempIn[i]) * params.dt;
    }
  }

  // Unconditionally stable local implicit mixing for serial coolant advection.
  if (info.kind == 3u) {
    let weightedNeighbour: f32 = q + sumG * tempIn[i];
    let nextCoolant: f32 =
      (info.capacity * tempIn[i] + params.dt * weightedNeighbour) /
      (info.capacity + params.dt * sumG);
    tempOut[i] = clamp(nextCoolant, -50.0, 2200.0);
    runtime[i].peakTemp = max(runtime[i].peakTemp, tempOut[i]);
    return;
  }

  if (info.kind == 0u) {
    let tempC: f32 = tempIn[i];
    q += self_heat_power(tempC, params);
    q += trigger_heat(i32(i), params.time, params);

    let rt: f32 = runtime[i].runawayTime;
    if (rt >= 0.0) {
      let elapsed: f32 = params.time - rt;
      if (elapsed <= params.eruptionDurationS) {
        q += params.runawayHeatJ * params.retainedFraction / params.eruptionDurationS;
        runtime[i].state = 2u;
      } else {
        runtime[i].state = 3u;
      }
    } else if (tempC >= params.onsetTempC) {
      runtime[i].runawayTime = params.time + params.dt;
      runtime[i].state = 2u;
    } else if (tempC >= params.selfHeatStartC) {
      runtime[i].state = 1u;
    }

    if (params.suppressionStartS >= 0.0 && params.time >= params.suppressionStartS && tempC > 45.0) {
      q -= info.capacity * params.suppressionRateKPerS;
    }
  }

  let nextT: f32 = tempIn[i] + q * params.dt / info.capacity;
  // Engineering guard band. Validation is still expected to reject bad k.
  tempOut[i] = clamp(nextT, -50.0, 2200.0);
  runtime[i].peakTemp = max(runtime[i].peakTemp, tempOut[i]);
}
