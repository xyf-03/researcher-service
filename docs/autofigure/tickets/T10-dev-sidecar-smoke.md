# T10 — Dev sidecar smoke

## Parent specification

Reference: `docs/autofigure/spec.md`（§10 部署 · Testing Decisions E2E 门控 smoke）
Source of truth: `docs/autofigure/grilling-decisions.md` §10 / §11 / §12

## What to build

交付 **dev 栈接线**与**本地真实生成 smoke**：把 T08 sidecar 接进容器化 dev 栈，并跑通一条真实 text-to-figure 生成链路（门控）。

- **dev compose 接线**：`deploy/docker-compose.dev.yml` 增加 sidecar 服务（panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`）；**零 host 挂载**（ADR 0013）；config 经 env 注入。
- **门控真实生成 smoke**：需真 sidecar + 真 key，**自动探测门控**（对齐 `containers-smoke` 门控模式）；不满足条件即跳过，常规套件不依赖真实 key。
- 验证：submit → queued → running → succeeded → PNG 字节（经完整链）。
- sidecar 可达性经 panel-net 内部（无宿主端口暴露）。

## Blocked by

**T08**（sidecar 服务 + Dockerfile）。

## Why this ticket exists

证明集成在 dev 环境真实可跑：镜像可构建、私有网络接线正确、完整生成链在本地产生 PNG。是生产打包（T11）与最终门控验证（T12）的实测前提。

## Acceptance criteria

- [ ] dev 栈 up：sidecar 服务在 panel-net 内 `up`，`/health` 可达。
- [ ] sidecar 无宿主端口暴露；零 host 挂载。
- [ ] **门控 smoke**：sidecar + key 就绪时，真实生成链 submit → succeeded → PNG 字节；条件缺失自动跳过（不失败常规套件）。
- [ ] `AUTOFIGURE_ENABLED` 开启时整链生效；config 经 env 注入。
- [ ] smoke 不等待真实 30min（超时经短超时 config）。

## Relevant global invariants

- **零 host 挂载**（ADR 0013）；config 入镜像 / 经 env（grilling §10）。
- **panel-net 私有、无宿主端口**（grilling §7 / spec §7）。
- **凭证只经服务端 env 注入**；smoke 的 key 来自环境，不落盘/不入日志。
- **门控测试**：需真 sidecar + 真 key 的用例自动探测门控（grilling §11 / spec Testing Decisions）。
- **无 BullMQ AutoFigure 依赖**；**V1 无删除**。

## Explicitly out of scope for this ticket

- **生产 deploy compose + GHCR 镜像管线 → T11**。
- **sidecar 实现本身 → T08**（已交付）；**adapter → T07**（已交付）。
- **前端 → T09**；**最终门控集成验证 → T12**。
- **删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **门控真实集成接缝（辅助）**：真 sidecar + 真 key 的 smoke（自动探测门控，对齐 containers-smoke）。
- 常规测试套件仍以 fake Port 为主，**不**因本票引入对真实 key 的常规依赖。

## Completion evidence

- fixed point: `e4c5a0e`（T09 merge commit，实施基线）
- implementation commit: `41231f6` — `feat: AutoFigure T10 — dev compose sidecar wiring + gated real-generation smoke`（8 文件，+474/−8）
  - `deploy/docker-compose.dev.yml` / `.env.example` / `README.md`：dev 栈 sidecar 接线（仅 panel-dev-net、无宿主端口、零 host 挂载、mem_limit 2g judgement call、/health 容器 healthcheck；server env 四键注入，JOB_TIMEOUT_MS 显式 1800000 防空串）
  - `server/src/config.ts`（注释对齐 8080）+ `server/test/config.test.ts`（SIDECAR_URL 用例 → 8080；新增 JOB_TIMEOUT_MS 空串 fail-fast 用例）
  - `server/test/smokeGating.ts` / `smokeGating.test.ts`：门控三条件（docker 可用 + `AUTOFIGURE_SMOKE==='1'` + `AUTOFIGURE_LLM_KEY` 非空，不含宿主侧 SIDECAR_URL）
  - `server/test/figuresSmoke.test.ts`：门控真实生成 smoke（dockerode 编排 sidecar 到 bridge、无 -p 发布；走 bootstrap B1 → login → password/change C1 → 二次 login → POST /figures → 轮询 → GET /:id/png 签名校验）
- first code review（双轴）:
  - Standards: 0 硬违规；4 judgement calls（readSmokeTimeoutMs 轻度重复、smoke env 轻度散落、.env.example smoke 提示与实际生效路径不一致、figuresSmoke C1 密码注释措辞）
  - Spec: 0 阻塞/缺失硬项；3 minor/文档级缺口（smoke 不经 assembleAutoFigureRuntime 整链——合理偏离、compose panel-net 拓扑无自动化验证、AUTOFIGURE_SMOKE_TIMEOUT_MS 未列入 .env.example）
- fixes（review 后、commit 前）: `.env.example` smoke 提示行改为宿主 vitest 语义 + 补 `AUTOFIGURE_SMOKE_TIMEOUT_MS`；figuresSmoke 头注释收敛——均文档级 nit，无行为变化
- second code review: 无（T10 仅一轮 /code-review；修复均为文档级、未引入行为变化，无需复检）
- typecheck/build: `npm run typecheck` 干净；`npm run build` EXIT=0
- broader tests: 全量 server 套件 722 passed；2 项既有环境门控失败（containers-smoke / pairingSmoke 需真 docker daemon，本机 daemon 不可用，非 T10 改动）
- targeted tests（post-fix）: config.test 85 + smokeGating.test 7 + figuresSmoke 门控跳过 → 92 passed | 1 skipped
- real gated smoke: **SKIPPED / NOT EXECUTED** —— 本机 Docker daemon 不可用（`/var/run/docker.sock` 指向缺失 socket），门控三条件不满足（docker 探测 false），`describe.skipIf` 整套跳过。**不声称真实 submit → succeeded → PNG 链通过**。Docker 可用后按 `deploy/README.md`「门控真实生成 smoke」执行：
  ```
  docker compose -f deploy/docker-compose.dev.yml build autofigure   # 或 docker build deploy/autofigure-sidecar -t autofigure-sidecar:dev
  cd server && AUTOFIGURE_SMOKE=1 AUTOFIGURE_LLM_KEY=sk-... npm test -- figuresSmoke
  ```
- T11/T12: 明确 out of scope，未开始
- commit: `41231f6`（implementation commit）+ `4815f06`（completion-evidence commit：docs: record T10 completion evidence）
