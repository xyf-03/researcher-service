# T07 — AutoFigure HTTP adapter

## Parent specification

Reference: `docs/autofigure/spec.md`（§7 Python 边界 · Testing Decisions 主接缝）
Source of truth: `docs/autofigure/grilling-decisions.md` §4 / §7 / §11 / §14

## What to build

交付 `AutoFigureGenerationPort` 的**生产实现**：经私有 HTTP 调 sidecar，并**定准 sidecar 契约文档**（本票是凭证传输表示的属主）。

- **生产 Adapter**：`AutoFigureGenerationPort` 的 HTTP 实现——normalized 生成输入 → 私有 HTTP 请求 → 解析响应 `{xml, pngBase64, evaluation}` → normalized result；错误/超时 → normalized failure（映射到应用级，不泄漏 secret / raw stack / Python internals）。
- **sidecar HTTP 契约文档（本票交付物）**：定义私有 HTTP 请求表示、**凭证传输**（内部 header / 字段 / 编码）、响应形状、错误形状、超时与重试策略（无自动重试）。
- **边界**：panel-net 内私有、不暴露宿主端口；**不接收 JWT、不接收 userId**；只收生成参数 + 服务端注入的 provider 凭证。
- **Public Port 契约不变**：应用/执行层只认 `AutoFigureGenerationPort`，不感知 HTTP 细节（T03/T04/T06 不受影响）。
- 凭证由 worker 在调用时注入；**永不落日志 / 追踪 / 响应 / Job payload**。

## Blocked by

**T03**（Port 接口 + runner 消费方）。**凭证到 sidecar 的具体 HTTP 传输表示属本票契约**——T03 只约定「worker 从 config 注入凭证」，不预决 header/字段/编码；本票定准。

## Why this ticket exists

把执行层（T03/T04/T06）与真实计算（T08 sidecar）之间的边界收拢到一个生产 Adapter + 一份契约文档：应用层替换能力（fake ↔ HTTP）证明成立，凭证传输被约束在私有契约内，浏览器永不直连 Python。

## Acceptance criteria

- [ ] Adapter 按契约把 normalized 输入映射为 sidecar 请求（契约 schema 校验）。
- [ ] Adapter 解析 sidecar 响应 `{xml, pngBase64, evaluation}` → normalized result。
- [ ] 错误 / 超时 → normalized failure，映射为应用级错误（不泄漏 secret / raw stack / Python internals）。
- [ ] 凭证按契约注入（内部 header/字段），**绝不**出现在日志 / 追踪 / 响应。
- [ ] 契约文档存在且为请求 / 凭证传输 / 响应 / 错误形状的**单一来源**。
- [ ] Adapter 测试用 **mock HTTP 客户端**（契约 schema 测试），不依赖真 sidecar。
- [ ] `AutoFigureGenerationPort` 公开契约不变；T03/T04/T06 断言不因生产实现而改变。

## Relevant global invariants

- **`AutoFigureGenerationPort` 保持窄**：只代表计算能力；不拥有生命周期/状态机/持久化/幂等/超时策略/归属/信封（spec Testing Decisions）。
- **Python 不接收 JWT / userId**；只收生成参数 + 服务端注入凭证（grilling §7 / spec §7）。
- **panel-net 私有、无宿主端口**（grilling §7 / spec §7）；浏览器绝不直连未认证 Python 后端。
- **凭证永不经请求体（浏览器侧）、不入 Job payload、不落盘、不入日志/追踪/公开错误**（grilling §4 / spec §6）。
- **无自动重试**（sidecar 调用失败即应用级 failure，不自动重试）。
- **V1 无删除**；**无 BullMQ AutoFigure 依赖**。

## Approved scope extension — shutdown-driven abort（T07 补充）

追加于主体实现之后；是风险 A（signal 经 Port 契约传递）的**受控补全**，**不新增任何 timeout policy**。
规范性细节见 `docs/autofigure/sidecar-contract.md` §2；wire 层行为见 `httpPort.ts`。

- **机制**：每个 in-flight invocation 由 runner 持有单个 `AbortController`，signal 恒透传 Port。同一
  controller 的两个触发源——(A) T04 应用超时（`AUTOFIGURE_JOB_TIMEOUT_MS`，V1 唯一 execution
  timeout）(B) graceful shutdown / `runner.stop()`。不建两套互相竞争的取消抽象。
- **stop() 语义**：置 `stopping` 闩（一次性）→ 停 interval/sweeper → `currentController?.abort()` →
  await 当前 cycle settle → 返回；幂等。stop 后不再 claim 新 Job。
- **shutdown 不改 Job 业务终态**（实现约束 4）：stop() 绝不 running→failed；shutdown 期间仍 running
  的 Job 保持 running，由下次 startup 的 T04 reconcile 终态化——reconcile 保持为 crash/restart
  interruption 的唯一事实语义。
- **timeout 语义不变**（实现约束 5）：timeout → T04 CAS running→failed + 稳定超时原因 + finishedAt +
  abort invocation；即使 abort 失败，T04 late-result fencing 仍保证 failed 不回 succeeded、产物不发布。
- **错误卫生**（实现约束 6）：普通非 shutdown 的 Port AbortError 不泄漏 raw 错误；shutdown abort 导致的
  in-flight reject 由 runner 正常消费/settle，无 unhandled rejection，不写新的 public failure reason。
- **不实现**（实现约束 8）：distributed cancellation、Python 侧取消协议、health monitoring、
  retry/reconnect、deployment shutdown configuration、T08/T10/T12 scope。

## Explicitly out of scope for this ticket

- **sidecar 实现（Python）→ T08**；**dev/prod 打包与镜像 → T10 / T11**。
- **runner/状态机/超时 → T03/T04**（已交付）；**产物落库/下载 → T06**（已交付）。
- **幂等 → T02**；**前端 → T09**。
- **AutoFigure 独立 Flask API 其余端点**：不接入、不整体暴露（spec §7）。
- **浏览器侧凭证 / 每用户凭证**：V1 无（grilling §13 / spec §6）。

## Testing seams

- **Python 契约接缝（辅助，非新架构接缝）**：给定输入 → 断言响应 JSON 形状（schema 校验）。
- **Port 契约接缝**：Adapter 以 mock HTTP 客户端测试，验证生产实现满足 `AutoFigureGenerationPort` 契约。
- 集成测试可 mock 或真起 sidecar（门控见 T10）。

## Completion evidence

- **fixed point**：`b06dad2c242c674d9c353778fc5014dcba721bee`（T06 artifact persistence 合并点）。
- **implementation commit**：`71c7351`（feat: AutoFigure T07 — production HTTP adapter and runtime wiring）。
- **evidence commit**：`7f5e131`（docs: record T07 completion evidence）。
- **FIRST review 结果**：双轴 APPROVE；修复 2 处 review points（credential redirect 外泄 75% —— `redirect:'error'` + 测试 + 契约文档；byte-exactness 测试字节以 0 开头致 PNG magic 校验拒绝 —— 加真实 magic 前缀），其余 judgement-calls 均确认。
- **Risk A 裁决**（已批准扩 Scope）：T04-owned application timeout（`AUTOFIGURE_JOB_TIMEOUT_MS` 唯一 execution timeout）+ AbortSignal cancellation 经 `AutoFigureGenerationPort` 契约传递。无 adapter-local 超时、无重试、无新错误态。
- **Risk B 裁决**（已批准扩 Scope）：private wire `png_base64`（仅 sidecar 边界；adapter 立即 decode 为 `Uint8Array<ArrayBuffer>`，字段名不泄漏应用层）+ PNG 8-byte magic 校验（`89 50 4E 47 0D 0A 1A 0A`，解码空/不匹配 → 稳定失败，绝不放行 succeeded 落库）。
- **shutdown-driven abort approved scope extension**：追加实现，见上节；stop() 复用同一 AbortController 立即取消在飞 invocation，不改 Job 业务终态，遗留 running 交下次 startup T04 reconcile。
- **SECOND review Standards = APPROVE**（6 条复核点全通过；无硬 violation；无 scope creep）。
- **SECOND review Spec = APPROVE**（8 条 shutdown abort 约束全满足；无硬 violation）。
- **focused tests**：150/150（figuresRunner 42 · figuresHttpPort 18 · figuresAssembly 6 · config 84）。
- **full suite**：714 passed / 6 skipped（仅 2 个预存在 docker smoke 失败 —— `ENOENT /var/run/docker.sock`，无 docker daemon，环境固有）。
- **typecheck**：`tsc --noEmit` clean。
- **build**：OK（`npx node@22.23.2` 跑 prisma generate + tsc + generated 拷贝；system Node v22.2.0 下 `@prisma/dev` ERR_REQUIRE_ESM 为预存在环境问题）。
- **remaining accepted judgement calls**：cooperative cancellation boundary（port 忽略 abort 且永久挂起则 stop() 等待——生产 httpPort 透传 signal，路径不可达）；timeout 先 abort 后 shutdown 到达 → 本进程不写终态，下次 startup reconcile 记 `JOB_RECONCILE_REASON`（原因仍稳定非敏感）；reconcile 保持 crash/restart interruption 唯一事实语义。
- **T08 handoff**：sidecar（Python）按 `docs/autofigure/sidecar-contract.md` 实现——`POST {baseUrl}/v1/generate`，请求 `{prompt}` + `X-Autofigure-Api-Key` header，成功 `{ok:true, xml, png_base64, evaluation}`（`png_base64` 必须为 PNG 8 字节签名开头的 base64），失败 `{ok:false, error}`；无鉴权/CORS、无重试、panel-net 私有不暴露宿主端口。T08 另见本票 Explicitly out of scope。
