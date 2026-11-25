# 储能舱热失控蔓延仿真与评审系统

浏览器内运行的储能电站电池舱热失控蔓延仿真系统：TypeScript + React + WebGPU，热求解核心为手写 WGSL compute shader，舱体方案与仿真帧/事件/报告数据保存在 IndexedDB。

> 工程评审与方案比选工具，不替代真实火烧/热扩散试验、消防设计审查或第三方认证。

## 快速开始

```powershell
npm install
npm run dev
```

打开 Vite 输出的地址（默认 <http://127.0.0.1:5173>；若端口占用会自动切到 5174）。

生产构建：

```powershell
npm run build
npm run preview
```

测试：

```powershell
npm test
```

## 已实现页面

1. **舱体布置**：20/40 尺集装箱；簇数、每簇模组数、每模组电芯数、行列数修改后确定性重排；高压箱、液冷管路、空调出风口、泄爆口等可在俯视图拖动或用 X/Y/Z 输入精确定位。
2. **电芯模组**：LFP/三元 280Ah 规格，可改质量、比热容、尺寸、各向导热系数、自产热分段、起始温度、失控放热、保留比例、喷发时长和气体量；隔热垫、导热胶、铝排、钢壳、冷板的厚度/导热系数均可配置。
3. **触发场景**：过充、针刺、加热板、直接起火；可按簇/模组网格点选任意电芯，也支持两处同时触发；仿真页 3D 视图可直接点电芯设为起火点。
4. **蔓延仿真**：每颗电芯一个节点；WebGPU 实例化绘制温度场，泄压阀位置绘制喷发方向与持续时间；舱体/框架半透明，可按簇位置剖切；时间轴回放、播放速度、点击蔓延链跳转到对应秒。
5. **探测喷放**：可燃气体、烟感、温感可布置；按簇分区的气体/烟气/热量 ODE 估算报警时刻；液冷支路按进液温度、流量和管路热容沿程混合，可设置单路泵停运；全氟己酮喷放延时和降温速率可配置。
6. **评审报告**：一键生成“不加垫 / 2mm / 5mm 垫、2mm / 8mm 间距、0s / 15s / 60s 喷放、无喷放”对比组；表中列出第二颗失控时刻、首颗到第二颗间隔、失控电芯数/比例和最高温度；可导出 CSV 和独立 HTML（浏览器内打印为 PDF）。

## 种子数据与异常参数诊断

首次启动会写入一个两簇 40 尺舱，2×4 模组×48 颗 = **384 颗 LFP 280Ah 电芯**。其中故意保留：

- `cell-7` 厚度方向导热系数 `28000 W/(m·K)`
- `cell-12` 面内导热系数 `0.018 W/(m·K)`
- `cell-19` 厚度方向导热系数 `0.0022 W/(m·K)`

这些值会在“电芯模组”和仿真运行前诊断中报为错误，显示合理区间与建议值。系统不会带着数量级错误强行算出“一舱全炸”；可逐项修复或一键采用推荐材料值。

## 传热模型

每个电芯为一个集中参数节点：

\[
C_i=m_i c_{p,i},\qquad
C_i\frac{dT_i}{dt}
=Q_{\text{self},i}(T_i)
+Q_{\text{trigger},i}(t)
+Q_{\text{runaway},i}(t)
+Q_{\text{suppression},i}(T_i,t)
+\sum_j G_{ij}(T_j-T_i)
\]

相邻电芯的热导由接触面积和材料层热阻串联计算，铝排作为并联热桥，并加入高温段线性化辐射项：

\[
R_{ij}=\frac{t_{\text{cell}}/2}{k_{\text{cell}}A}
+\sum_l \frac{t_l}{k_l A}
+R_{\text{air/contact}},\qquad
G_{ij}=\frac{1}{R_{ij}}+G_{\text{busbar}}+G_{\text{rad}}
\]

壳体、铝冷板和冷却液段是辅助节点；冷板—冷却液、壳体—环境、壳体—壳体弱耦合均进入同一 CSR 邻接网络。

自产热按温度阈值分段取功率。达到失控温度后，总放热能量的保留部分在喷发时长内均匀释放到电芯节点，其余能量进入喷发气体/对流热源和探测分区模型。

### 稳定性与自适应切步

显式 Euler 的正系数稳定条件近似为：

\[
\Delta t \le \frac{C_i}{\sum_j G_{ij}}
\]

实现中使用安全系数 `0.38`：

```ts
dtStable = min(1 s, 0.38 * C_i / sumG_i)
substeps = ceil(requestedDt / dtStable)
```

CPU 参考求解器和 `src/gpu/thermal.wgsl` 使用同一更新方程。冷却液串行平流采用局部后向 Euler 混合，避免流量/小段热容造成过严的 CFL 微步；电芯固体节点仍为显式积分。

## 三电芯手算校核

`src/thermal/handcalc.test.ts` 对应三颗串排电芯：

- \(C_1=C_2=C_3=5000\ \mathrm{J/K}\)
- \(G_{12}=G_{23}=5\ \mathrm{W/K}\)
- 首颗固定 \(T_1=600^\circ\mathrm C\)
- 初温 \(25^\circ\mathrm C\)
- 第二颗失控/报警温度 \(150^\circ\mathrm C\)

令 \(\theta_i=T_i-25\)，则：

\[
\dot\theta_2=0.001(575-2\theta_2+\theta_3),\qquad
\dot\theta_3=0.001(\theta_2-\theta_3)
\]

解析/高精度数值根为：

\[
t(T_2=150^\circ\mathrm C)\approx 280.7\ \mathrm s
\]

自动化测试要求显式求解器结果与该值误差不超过 5%。当前测试通过。

## 12,000 颗性能口径

`src/thermal/performance.test.ts` 构建 12,000 颗电芯、约 12,752 个热节点和 37,759 条热边，积分 7,200 s 物理时间。

在 Node 22 / Vitest 的 CPU 参考路径中，实测约 **9.7–10.1 s** 完成（具体随机器波动），显著低于“页面三分钟内”的预算。浏览器中优先使用 WebGPU WGSL compute；不可用或适配器初始化失败时自动回退到分块让出主线程的 CPU 求解器，进度和停止按钮仍可用。

渲染侧使用单个 instanced cube pipeline 绘制电芯，温度变化只更新实例颜色缓冲；时间轴帧以 `Uint16Array` 分摄氏度（deci-°C）保存，避免为 12k 节点保存大量浮点快照。

## IndexedDB

数据库：`ess-thermal-studio`，版本 1。

- `schemes`：舱体、规格、材料、触发、探测器、液冷和喷放配置。
- `runs`：运行摘要、蔓延事件、报警时刻、液冷结果、诊断问题和压缩后的时间轴帧。

## 目录

```text
src/
  components/          通用 UI
  data/defaults.ts     20/40 尺、LFP/NCM、种子异常数据、12k 压测方案
  gpu/
    thermal.wgsl       手写热积分 compute shader
    GpuThermalSolver.ts
    InstancedRenderer.ts
  pages/               六个评审页面
  report/              对比方案、CSV/HTML 导出
  simulation/          Scheme -> graph -> GPU/CPU -> RunSummary
  thermal/
    graph.ts           布置与热阻网络/CSR
    solver.ts          CPU 参考显式求解器和手算校核
    detectors.ts       分区气体/烟/热报警模型
    validation.ts      数量级与几何诊断
    *.test.ts          手算、种子数据、12k 性能测试
  db.ts                IndexedDB
  store.tsx            React 状态与持久化
```

## 已知边界

- 探测模型是工程分区/集总模型，不是 CFD。
- 辐射用平均温度下的线性化等效热导，未做角系数和火焰射流三维求解。
- WebGPU 路径需要支持 WebGPU 的 Chrome/Edge；无适配器时使用 CPU 路径和 Canvas 2D 热图回退。
- 12k 压测阵列用于计算/渲染扩展性验证，不代表 40 尺集装箱内的真实封装密度或结构重量校核。
