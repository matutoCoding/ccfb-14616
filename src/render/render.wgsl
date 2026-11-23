// 渲染着色器：实例化电芯 + 模组/舱体半透明盒 + 喷发锥 + 探测器
// 每条管线使用独立 bind group（绑定号互不干扰）
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  pad: f32,
};
@group(0) @binding(0) var<uniform> cam: Camera;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
  @location(2) alpha: f32,
};

struct Instance {
  model: mat4x4<f32>,
  color: vec4<f32>,
};

// —— 电芯实例 ——
@group(1) @binding(0) var<storage, read> cellInstances: array<Instance>;

@vertex
fn vsCell(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>,
          @builtin(instance_index) ii: u32) -> VSOut {
  let inst = cellInstances[ii];
  let world = inst.model * vec4<f32>(position, 1.0);
  var out: VSOut;
  out.pos = cam.viewProj * world;
  out.normal = normalize((inst.model * vec4<f32>(normal, 0.0)).xyz);
  out.color = inst.color.rgb;
  out.alpha = inst.color.a;
  return out;
}
@fragment
fn fsCell(in: VSOut) -> @location(0) vec4<f32> {
  let L = normalize(vec3<f32>(0.4, 0.8, 0.6));
  let diff = clamp(dot(normalize(in.normal), L), 0.25, 1.0);
  return vec4<f32>(in.color * (0.35 + 0.65 * diff), in.alpha);
}

// —— 通用半透明/线框实例（模组外壳、舱体、液冷管路、喷发锥、探测器）——
@group(1) @binding(0) var<storage, read> plainInstances: array<Instance>;

@vertex
fn vsPlain(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>,
           @builtin(instance_index) ii: u32) -> VSOut {
  let inst = plainInstances[ii];
  var out: VSOut;
  out.pos = cam.viewProj * inst.model * vec4<f32>(position, 1.0);
  out.normal = normalize((inst.model * vec4<f32>(normal, 0.0)).xyz);
  out.color = inst.color.rgb;
  out.alpha = inst.color.a;
  return out;
}
@fragment
fn fsPlain(in: VSOut) -> @location(0) vec4<f32> {
  let L = normalize(vec3<f32>(0.4, 0.8, 0.6));
  let diff = clamp(dot(normalize(in.normal), L), 0.3, 1.0);
  return vec4<f32>(in.color * (0.4 + 0.6 * diff), in.alpha);
}
