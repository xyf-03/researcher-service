# T09 — Vue figure journey

## Parent specification

Reference: `docs/autofigure/spec.md`（User Stories 1–7 / 9–14 · §8 前端 · §9 feature flag）
Source of truth: `docs/autofigure/grilling-decisions.md` §8 / §12

## What to build

交付 **Vue-native** 的 AutoFigure 用户旅程：输入 → 提交（带幂等键）→ 轮询状态 → 预览/下载 → 历史列表 → 详情重开。

- **新增 `AutoFigureView`**：复用既有 auth store / 信封解析 / 轮询 / 下载卡先例；`frontend/src/router` 增加受保护路由 + 导航入口。
- **提交**：携带 `Idempotency-Key`（T02 契约），解析 #312 信封；处理幂等冲突 / 70040 / 校验错误。
- **状态轮询**：REST 轮询，粒度 = Job 应用级状态 `queued → running → succeeded | failed`；**无假百分比进度**。
- **预览/下载**：succeeded → PNG 预览/下载；未完成/失败 → 明确应用级提示（含**非敏感**失败原因）；不模糊 500。
- **历史与详情**：历史列表（以 Figure 为单位）→ 详情重开。
- **flag 门**：`AUTOFIGURE_ENABLED` 关闭时**不提供导航入口**，直达访问映射为明确「功能未启用」提示（**非裸 404**）。
- **Vue-native**：不引入 React/Next iframe 或 sub-app；不复制 AutoFigure 前端壳（Next 结构 / Tailwind/Radix / localStorage config 传递）。

## Blocked by

**T02**（幂等契约：前端需发送 `Idempotency-Key` 与处理冲突）、**T06**（PNG 下载端点：前端预览/下载）。

## Why this ticket exists

交付 V1 最小用户旅程在面板内的完整 UX（spec US1–14）：用户从提交到拿到 PNG、再到历史回看/重开全部可达；flag 关闭时给出明确提示。是 T12 端到端验证的前端闭环。

## Acceptance criteria

- [ ] 客户端 API 层：提交带 `Idempotency-Key`；正确解析 #312 信封；处理幂等冲突 / 70040 / 90002。
- [ ] 视图：提交 → queued 确认（含 figureId/jobId）→ 轮询到 succeeded/failed；渲染应用级状态，无假百分比。
- [ ] succeeded → PNG 预览与下载；未完成/失败 → 明确应用级提示（非敏感原因），不模糊 500。
- [ ] 历史列表（自己的 Figure）→ 详情重开。
- [ ] flag 关闭：无导航入口；直达 → 「功能未启用」提示（非裸 404）。
- [ ] 客户端测试（vitest + mocked api client）：信封解析 / 幂等键发送 / 错误分支；视图测试覆盖状态序列。
- [ ] `vue-tsc` 类型检查通过（`npm run build`）。
- [ ] 不出现 provider 凭证于任何前端请求 / 存储 / 日志。

## Relevant global invariants

- **Vue-native**：不引入第二前端壳 / 第二认证系统（grilling §8 / spec §8）。
- **应用级状态暴露**：只消费并渲染应用级 Job 状态，不触碰 queue/worker/Python 实现细节。
- **幂等键必带**（grilling §17）；客户端不得发送 userId 作为幂等身份。
- **凭证**：浏览器**永不**持有/发送 provider 凭证（spec §6 / §7）。
- **flag 关闭行为**：无入口 + 明确提示（非裸 404）（spec §9）。
- **V1 无删除**：前端无任何删除入口（owner 或 admin）。

## Explicitly out of scope for this ticket

- **后端/执行/幂等/产物 → T01–T06**（已交付；本票只消费其 API 契约）。
- **draw.io / 手动画布 / continue / refine / enhancement / PDF 输入**：V1 无（grilling §13 / spec §8）。
- **假百分比进度 / SSE / WS 进度**：V1 仅 REST 轮询，粒度 = Job 状态。
- **删除 UI / 管理删除**：V1 无删除（任何角色）。
- **dev/prod 打包 → T10 / T11**；**E2E 门控验证 → T12**。

## Testing seams

- **前端测试接缝（复用既有）**：vitest + mocked API client（信封 / 幂等 / 错误分支 / 视图状态序列）——对齐现有 frontend 测试约定，不新造架构接缝。
- 后端行为断言复用 T02/T06 的 REST 接缝验收（本票不重复验证后端）。

## Completion evidence

- **implementation summary**（固定点 f50f18c → 1831deb `feat: AutoFigure T09 — Vue figure journey`；仅实现/测试/修复，
  不含本 evidence 文档，后者独立 docs 提交）:
  - figures API client（`api/figures.ts`）：create/detail/history/png 四路；Idempotency-Key 由调用方 submission 快照
    提供。`getFigurePngBlob` 二进制路径——Content-Type `image/png` 时 `resp.blob()`（成功豁免 #312 信封、不 base64-in-JSON）；
    非 PNG 时经 `parseEnvelopeBody` 解信封抛 `ApiError`，保留 70040/70042/70043 精确 code。
  - capability store（`stores/autofigure.ts`）：90005→disabled / 20040 等→unknown 可重试 / 0→enabled；probe 单飞，
    复用 list 响应作 history 初值，不重复拉取（约束 2）。
  - `AutoFigureView.vue`：prompt 提交（submission 快照 `{prompt,key}` ↔ promptText 可编辑 ↔ current 三分离，约束 3）→
    queued/running 轮询（interval 单例 + refreshInFlight 无重叠 + visibilitychange 停/恢复）→ succeeded PNG 预览/下载 |
    failed 稳定失败态；历史列表 → 详情重开；flag off → 「功能未启用」非裸 404。PNG stale 响应守卫 + Blob URL 即时回收（约束 4）。
  - router/nav：`/figures` 路由 + nav-figures 链接（enabled 显示 / disabled|unknown 隐藏），authed 后 probe（约束 1）。
- **targeted tests**: figures+client 32/32（`api/figures.test.ts` + `api/client.test.ts`）——含 Spec-1 真实 Response 二进制
  body 安全（`new Response(Uint8Array PNG)` 经 apiFetch 后 bodyUsed===false / blob() 成功 / 70040/70042/70043 精确码 /
  10001 refresh 链无回归）；store/AutoFigureView/router/App 46/46（含 Spec-2 unmount 在飞 PNG 不建 ObjectURL +
  Spec-3 70041→作废旧 key、重试新 key、不永久 70041）；本轮 70041 文案修正后 AutoFigureView focused 21/21。
- **typecheck/build**: `vue-tsc` 类型检查干净；`npm run build`（vue-tsc + vite）EXIT=0。
- **broader tests**: `vitest run` 全量 861/878——17 失败为预存在 chat env 问题（deviceAuth/deviceIdentity/
  multiContainerPairing，jsdom + Node 22.2 `@noble/ed25519` sha512 `crypto.subtle.digest` TypeError；clean fixed point
  复现，T09 未触碰相关文件，不修）。
- **first code review**: 固定点 f50f18c 双轴（Standards + Spec）并行，工作树 diff +1495/−10 未提交。
  - P0 Spec-1：apiFetch 的 #312 信封 sniff 对 PNG 200 调 `resp.json()`——drain 掉 body 后 `resp.blob()` throw。
  - P1 Spec-2：onBeforeUnmount 未失效在飞 PNG 请求 generation——unmount 后在飞 loadPng 仍建 ObjectURL，无人 revoke。
  - P2 Spec-3：服务端确认 70041 后 submission 仍持旧 key——继续复用同 key 永久 70041 死循环。
  - Standards：status 域裸 string 三处并列分支（未用 FigureAppStatus 联合）；`IDEMPOTENCY_KEY_MAX_LENGTH` 导出零消费。
- **fixes**（批准边界内，未扩 scope）:
  - Spec-1：`apiFetch` 仅 Content-Type `application/json` 才嗅探信封，HTTP 200 非 JSON 原样返回不消费 body
    （`isJsonResponse` + `refreshAndRetry` 同守卫）；`parseEnvelopeBody` 导出为正式 helper（apiFetch/apiJson/figures
    三消费方，`__envBody` 为既有缓存协议非 PNG 专用）；`getFigurePngBlob` 复用其保留 70040/70042/70043；4 个 API 测试
    mockResp 补 content-type 头建模真实响应。
  - Spec-2：onBeforeUnmount 先 `figureGeneration += 1` 失效在飞 detail/PNG，再 stopPolling/revokePreview；已建 URL 由
    revokePreview 回收。
  - Spec-3：70041 仅清 `submission`（下次重试生成新 key），不清 `current`（已有 Figure 不受影响）。
  - Standards：STATUS_LABEL/STATUS_TAG_TYPE/isNonTerminal 以 `FigureAppStatus` 定型；删 `IDEMPOTENCY_KEY_MAX_LENGTH`。
- **second code review**: 双轴第二轮（修复后同固定点 f50f18c，未提交 diff 复核）通过——无硬性违规。
  - Spec 轴：四项边界精确满足；7 个重点回归点全过（binary 不被提前 consume / JSON auth+envelope 无回归 /
    70040/70042/70043 保留 / unmount 不泄漏 ObjectURL / 70041 key 可恢复 / 无新 auth-client 抽象 / 无 T10+ creep）。
  - Standards 轴：无文档标准违反；仅 judgement-call 级 smell（记录不修，见下）。
- **accepted judgement calls**（不扩 scope，记录在案）：6 测试文件重复 mockResp；figures.ts 重复实现 content-type
  sniff；statusTagType middle-man 透传；loadPng 第二道 gen 守卫不可达（createObjectURL 同步）；STATUS_LABEL `??`
  兜底不可达；`probed=true` disabled 单 SPA 会话内跨登出留存（flag 翻转时导航可能保持隐藏）。
- **70041 文案修正**：`检测到幂等键冲突，请刷新后重试` → `检测到幂等键冲突，请重试`（与「重试自动换新 key」实际
  行为一致，去误导性「刷新」）。仅文案，无行为/测试结构/capability 机制改动；修正后 AutoFigureView focused 21/21。
- **commit**: 1831deb（implementation，16 文件 +1495/−10）+ 本 evidence 文档（docs 段提交）。
