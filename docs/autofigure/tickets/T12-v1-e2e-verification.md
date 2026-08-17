# T12 — V1 E2E verification

## Parent specification

Reference: `docs/autofigure/spec.md`（Solution · User Stories · Out of Scope · Testing Decisions）
Source of truth: `docs/autofigure/grilling-decisions.md` 全表

## What to build

V1 的**最终门控集成验证**：在全部 11 票交付后，跑通**全链路 + 负路径清单**，作为 V1 发布判定的门。**本票不新增任何产品行为**——只验证已批准行为在完整栈上正确协作。

- **正路径（门控真实）**：认证 → submit（幂等键）→ queued → running → succeeded → PNG 下载 → 历史列表 → 详情重开。
- **负路径清单**（逐项断言稳定信封/行为）：
  - 未认证请求 → 鉴权错误（10001）。
  - 跨用户 Figure 访问 → 70040（同码防探测）。
  - 缺失 `Idempotency-Key` → 校验错误。
  - 同 key + 同输入重放 → 同一 Figure/Job（含 succeeded 后重放）。
  - 同 key + 不同输入 → 幂等冲突。
  - feature disabled（flag 关）→ 90005 / 前端「功能未启用」提示。
  - sidecar 不可用（flag 开）→ 可检测，不模糊 500。
  - 超时 → 稳定 failed、无产物、Figure 保留（短超时注入，不真实等 30min）。
- 逐项验收只依赖各票已声明 blockers 交付的行为；验证中发现缺口 → 归属到具体票，不在本票修补。
- 测试经既有接缝（REST / Port fake / 门控真实）+ config 短超时；**不真实等待 30 分钟**。

## Blocked by

**T09**（前端旅程）、**T10**（dev 接线 + 真实 smoke）、**T11**（生产打包 + 健康行为）。

## Why this ticket exists

V1 发布判定的唯一门：证明已批准能力集在完整栈上端到端正确，且所有负路径保持稳定信封/行为。**它是验证票，不是新功能票。**

## Acceptance criteria

- [ ] 正路径（门控真实，sidecar + key 就绪）：submit → succeeded → PNG 字节 → 历史 → 详情重开。
- [ ] 未认证 → 10001。
- [ ] 跨用户 Figure（非 admin）→ 70040；不存在 → 70040（同码）。
- [ ] 缺失 `Idempotency-Key` → 校验错误；同 key 重放（含 succeeded 后）→ 同一 Figure/Job；不同输入 → 冲突。
- [ ] flag 关 → 90005（后端）+ 前端「功能未启用」提示。
- [ ] flag 开 + sidecar 不可用 → 可检测，不模糊 500。
- [ ] 超时（短超时）→ 稳定 failed、无产物、Figure 保留。
- [ ] **V1 删除缺失确认**：全栈（API / 前端 / 文档）无任何 Figure 删除路径（owner 或 admin）。
- [ ] Figure 1:1 GenerationJob 不变量在正/负路径均保持。
- [ ] 全程不泄露 provider 凭证（响应 / 日志 / 追踪）。
- [ ] 常规套件不依赖真实 key（门控跳过）。

## Relevant global invariants

- **Figure 1:1 GenerationJob**（贯穿验证）。
- **V1 无删除**（owner 与 admin 均无）；无硬删/级联公开行为。
- **无 BullMQ AutoFigure 依赖**；**无自动重试**。
- **#312 信封**；**70040 同码防探测**；**flag 默认关闭行为**。
- **凭证永不经请求体/不落盘/不入日志/追踪/公开错误**。
- **无 V2 功能**（continue/refine/finalize/enhance/PDF 输入/draw.io 等均不在验证范围）。

## Explicitly out of scope for this ticket

- **任何新产品行为 / 新端点 / 新 UI**：本票只验证。
- **缺口修补**：验证发现的缺口归因到具体票，不在本票实现。
- **自动重试 / 删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **门控真实集成接缝（辅助）**：正路径与需真 key/sidecar 的负路径（自动探测门控）。
- **REST 信封接缝 + Port fake 接缝**：可在无真实 key 环境跑的大部分负路径。
- **config 短超时**：超时路径（绝不真实等待 30min）。

## Completion evidence

- 性质：**验证票（evidence-only）**——零产品代码变更，仅本 evidence 段（+ evidence 文档 commit）。
- fixed point: `f8ba3bb`（T11 merge commit，实施基线）。
- implementation commit: **无**（T12 纯验证，不新增任何产品行为）。
- acceptance criteria 状态：
  - **AC2–AC11（确定性）**: **PASS** —— 全部经既有接缝（REST 信封 / Port fake / config 短超时）验证，覆盖证据见下方负路径段。
  - **AC1（真实 provider 正路径）**: **BLOCKED / NOT EXECUTED** —— Docker daemon 不可用（`/var/run/docker.sock` socket 缺失）+ `AUTOFIGURE_LLM_KEY` 未设置。按 ticket AC1 为「门控真实」条件门控（Testing seams 标辅助、AC11 强制常规套件不依赖真实 key），**不伪造 PASS、不 weaken AC**；真实 submit → succeeded → PNG **从未在任何环境被证明**。
  - **发布就绪性注意项**: 真实「文本 → 图」生产链在真实 provider 环境未被证明；`autofigure` 镜像构建/推送/生产运行时亦从未被 CI/CD 执行（见 CI/CD 段）。
- validation（确定性矩阵，全量结果）:
  - server 聚焦 AutoFigure：`npm test -- --run figures` → **6 test files passed | 1 skipped（figuresSmoke）**，**134 tests passed | 1 skipped**（figures.test 37 / figuresHistory.test 20 / figuresPng.test 11 / figuresRunner.test 42 / figuresHttpPort.test 18 / figuresAssembly.test 6）
  - server config/smokeGating：`npm test -- --run config smokeGating` → **121 passed**（config 85 / smokeGating 7 / configRenderer 16 / modelsConfigBuilder 13）
  - server 全量：`npm test` → **722 passed | 7 skipped，2 failed**（failed = containers-smoke / pairingSmoke，需真 docker daemon，`connect ENOENT /var/run/docker.sock`；T10 evidence 同款基线，非 T12 改动）
  - server typecheck：`npm run typecheck` → **PASS**（tsc --noEmit，exit 0）
  - server build：`npm run build` → stock Node 22.2.0 下 **prebuild `prisma generate` 失败**（`ERR_REQUIRE_ESM`：`@prisma/dev@0.24.17` require ESM-only `zeptomatch`；Node 22.2.0 低于 require(esm) 无 flag 门槛 22.12）。**环境工具链，非 AutoFigure**（AutoFigure 对 deps/build/prisma 零变更；CI `lts/*` 不受影响）。`NODE_OPTIONS=--experimental-require-module npm run build` → **EXIT=0**（Prisma generate + tsc + generated 拷贝全通过，`dist/figures/` 产物齐备：assembly/httpPort/port/routes/runner/service）
  - frontend 聚焦 AutoFigure：`npx vitest run src/api/figures.test.ts src/stores/autofigure.test.ts src/views/AutoFigureView.test.ts` → **42 passed**（13 + 8 + 21）
  - frontend 全量：`npm run test` → **861 passed | 17 failed**（17 failed 全在 `src/chat/` 设备配对域：deviceIdentity 9 / deviceAuth 5 / multiContainerPairing 3 —— Node 22.2.0 实验 require(esm) 下 `@noble/ed25519@3`（ESM）的 Uint8Array 被 `crypto.subtle.digest` realm 检查拒绝；**本地工具链产物，非真实回归、非 AutoFigure**；CI `lts/*` 原生 require(esm) 不受影响）
  - frontend build：`npm run build`（vue-tsc -b && vite build）→ **PASS**（exit 0）
  - sidecar 契约测试：`cd deploy/autofigure-sidecar && ./.venv/bin/python -m pytest service/tests -q` → **17 passed**；import 卫生（`import autofigure` + generator）ok
  - dev compose：`docker compose -f deploy/docker-compose.dev.yml config` → **PASS**（无 daemon）
  - prod compose：`docker compose -f deploy/docker-compose.deploy.yml config`（临时 .env 渲染后删除）→ **PASS**
  - prod 10 项不变量断言 → **ALL 10 PASS**（AUTOFIGURE_ENABLED 默认 false / 全文件无 service_healthy（depends_on 均 service_started）/ sidecar 无 ports·volumes / AUTOFIGURE_LLM_KEY 空串安全 / 内部 DNS autofigure:8080 / JOB_TIMEOUT_MS 1800000 / panel-net / restart unless-stopped / mem_limit 2g（"2147483648"）/ healthcheck 127.0.0.1:8080/health）
  - cd.yml 结构校验 → **PASS**（4 build&push：server/frontend/openclaw/autofigure；autofigure context=deploy/autofigure-sidecar、file=Dockerfile、tags=:latest+:IMAGE_TAG(head_sha)、cache=autofigure；normalize `AUTOFIGURE_IMAGE`；Stage .env 渲染 `PANEL_AUTOFIGURE_IMAGE` + `AUTOFIGURE_LLM_KEY` 可选 secret）
- 负路径 AC 覆盖（全确定性，经既有接缝；各用例均在上述 passing 集内）:
  - AC2 未认证 → 10001（figures.test「未认证 / 坏 token → 10001 同码」）
  - AC3 跨用户/不存在 → 70040 同码防探测（figuresHistory / figuresPng 归属门，逐字节一致）
  - AC4 幂等全契约（缺 key → 校验错误；同 key 四态重放 → 同 Figure/Job；异输入 → 70041）（figures.test 幂等用例全覆盖，重放含 succeeded 后）
  - AC5 flag 关 → 90005（figures.test「flag 关 → 90005 路由未装配」）+ 前端「功能未启用」（AutoFigureView `data-test="autofigure-disabled"`「AutoFigure 功能未启用」，非裸 404）
  - AC6 flag 开 + sidecar 不可用 → 可检测、不模糊 500（figuresHttpPort「sidecar 不可达（ECONNREFUSED）→ ok:false GENERATION_EXECUTION_ERROR，无重试」+ figuresAssembly「enabled + sidecar 非 2xx → failed + 白名单稳定原因」）
  - AC7 超时 → 稳定 failed、无产物、Figure 保留（figuresRunner `timeoutRunningJobs` / `JOB_TIMEOUT_REASON` / 迟到成功丢弃）
  - AC8 V1 删除缺失 → 全栈确认（figuresHistory「admin 无删除能力：DELETE /figures/:id → 90005，行仍在」+ 前端 figures.ts「无 delete：V1 无删除」+ 路由仅 POST/GET/GET/:id/GET/:id/png）
  - AC9 Figure 1:1 GenerationJob（figures.test「jobCount == figureCount 1:1」/ figuresRunner「seed Figure + 1:1 queued Job」）
  - AC10 凭证不泄露（figuresHttpPort「凭证只走 header X-Autofigure-Api-Key，body 绝不含」「不跟随重定向（redirect:'error'）」「诊断日志不插值凭证/header/body」）
  - AC11 常规套件不依赖真实 key（smokeGating「三条件门控」+ figuresSmoke `describe.skipIf` 跳过）
- CI/CD 核验：AutoFigure 分支（af/*、feature/autofigure-integration）**零 CI 运行记录**（`gh run list` 空）；CD 仅 master 触发（workflow_run），最近 CD 运行早于 AutoFigure → **autofigure 镜像从未被 CI/CD 构建推送**（CI-owned，T11 已如实记录 NOT EXECUTED）。
- Docker image build（autofigure）/ GHCR push / production runtime smoke: **NOT EXECUTED** —— Docker daemon 不可用 + key 未设；**不声称本地通过**，由 CD 管线首次部署时验证。
- 预存/环境失败（单独归类，**非 AutoFigure**、非 T12 引入）:
  - containers-smoke / pairingSmoke（需真 docker daemon，`connect ENOENT /var/run/docker.sock`；T10 基线同款）
  - server build prebuild `prisma generate`（Node 22.2.0 < require(esm) 门槛 22.12；CI `lts/*` 不受影响；build 核心步骤 tsc+generated 拷贝 PASS）
  - frontend 全量 17 chat 设备配对失败（Node 22.2.0 实验 require(esm) + `@noble/ed25519@3` ESM/webcrypto realm；CI 不受影响）
- scope exclusions：V1 无删除 / 无 BullMQ AutoFigure 依赖 / 无自动重试 / 无 V2 能力（continue·refine·enhance·PDF·draw.io·共享·每用户凭证·FigureProject·修订 等）/ 本票零产品行为、零缺口修补。
- first code review（双轴，对 evidence diff）:
  - Spec axis: **0 blocking** —— evidence 精确反映 T12 AC 清单/scope 边界/门控语义；AC1 分类（条件门控 + BLOCKED/NOT EXECUTED）与 ticket「门控真实」「辅助接缝」「AC11 常规套件不依赖真实 key」一致；无 T13/V2 越界、无缺口修补。
  - Standards axis: **2 findings（review 后、commit 前修复）**——①server 聚焦结果双数字表述歧义（test files vs tests）→ 拆明「6 test files passed | 1 skipped」+「134 tests passed | 1 skipped」；②AC4 覆盖「55 处断言」计数不精确 → 改为「幂等用例全覆盖」。另核验：无 stale/contradictory 声明、凭证零泄露（evidence 未印 key）、所有计数与运行输出一致（134/1、121、722/7/2、861/17、42、17 pytest）、diff 仅触及本 ticket。
- fixes（review 后、commit 前）: 上述 2 处 evidence 表述精确化，均无行为变化。
- second code review: 无（仅 evidence 文档，修复为表述精确化，未引入新内容；修复后逐条复核通过）。
- commit: 无 implementation commit（T12 纯验证）；`d425869`（completion-evidence commit：docs: record T12 completion evidence）
