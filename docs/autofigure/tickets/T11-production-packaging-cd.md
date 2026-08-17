# T11 — Production packaging / CD

## Parent specification

Reference: `docs/autofigure/spec.md`（§9 feature flag · §10 部署 · User Stories 19 / 21）
Source of truth: `docs/autofigure/grilling-decisions.md` §10 / §12

## What to build

交付 **生产打包与 CD**：`autofigure` 第 4 镜像走既有 GHCR 管线、deploy compose 增加 sidecar 服务，并落实健康行为的**行为要求**（精确 wiring 实现定义）。

- **镜像管线**：`autofigure` 镜像（Python + Playwright chromium 构建期 + 依赖）走既有 GHCR 构建/推送管线；许可/署名（`CITATION_AND_ATTRIBUTION.md` / `TRADEMARK.md`）入镜像。
- **deploy compose**：`docker-compose.deploy.yml` 增加 sidecar 服务（panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`）；**零 host 挂载**（ADR 0013）；config 入镜像。
- **健康行为要求（行为级，精确 wiring 实现定义）**：
  - feature disabled → 面板 `/api/health` **不依赖** sidecar（panel 健康独立）。
  - feature enabled → sidecar 不可用**必须可被检测**（经既有部署面探针）。
  - 如何接线（探针合并/独立 health 端点等）**实现定义**，不硬编码到全局 `/api/health`。
- **feature flag** `AUTOFIGURE_ENABLED` 生产默认关闭（分阶段发布，必要时快速关闭）。
- 不复制 AutoFigure `start.sh`/`stop.sh`/Flask 形态。

## Blocked by

**T08**（sidecar 服务 + Dockerfile）。

## Why this ticket exists

让集成可上线：镜像管线、生产编排、许可合规，以及**可运维性**（flag 关闭时面板不被 sidecar 拖累、flag 开启时 sidecar 故障可发现）。CD 覆盖是 T12 最终验证的生产侧前提。

## Acceptance criteria

- [ ] `autofigure` 镜像构建成功并推送到 GHCR（既有管线）。
- [ ] 许可/署名文件（`CITATION_AND_ATTRIBUTION.md` / `TRADEMARK.md`）存在于镜像内。
- [ ] deploy compose 含 sidecar 服务：panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`；零 host 挂载。
- [ ] **flag 关闭**：面板 `/api/health` 独立于 sidecar（sidecar 缺失/未起时面板健康不受影响）。
- [ ] **flag 开启**：sidecar 不可用可被检测（经探针/健康面），且不模糊 500。
- [ ] `AUTOFIGURE_ENABLED` 生产默认关闭。
- [ ] 不复制 `start.sh`/`stop.sh`/Flask 形态。

## Relevant global invariants

- **零 host 挂载**（ADR 0013）；config 入镜像（grilling §10）。
- **panel-net 私有、无宿主端口**（grilling §7 / spec §7）。
- **凭证只经服务端 env 注入**；生产 fail-fast 配置（config boundary，ADR 0005）。
- **feature flag 默认关闭**（grilling §12 / spec §9）。
- **许可/署名保留**（spec §7）；**无 BullMQ AutoFigure 依赖**；**V1 无删除**。

## Explicitly out of scope for this ticket

- **dev 接线 / 本地 smoke → T10**（已交付）。
- **sidecar 实现本身 → T08**（已交付）；**adapter → T07**（已交付）。
- **前端 → T09**；**最终门控集成验证 → T12**。
- **删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **门控集成接缝（辅助）**：镜像构建 / 健康行为验证可门控（对齐 containers-smoke 门控模式）。
- **config/健康接缝**：flag 开关注入验证健康独立性；不硬编码全局 `/api/health` wiring。

## Completion evidence

- fixed point: `6d19c15`（T10 merge commit，实施基线）
- implementation commit: `d959f10` — `feat: AutoFigure T11 — production packaging and CD wiring`（5 文件，+184/−23）
  - `deploy/docker-compose.deploy.yml`：生产 compose 第 4 服务 autofigure（仅 panel-net、无 ports、零 host 挂载 ADR 0013、mem_limit 2g T10/T11 judgement call、`/health` 容器 healthcheck、`restart: unless-stopped`、内部 URL `http://autofigure:8080`、`AUTOFIGURE_JOB_TIMEOUT_MS` 显式 1800000）+ server env 三键（`AUTOFIGURE_ENABLED:-false` 生产默认关 / `AUTOFIGURE_SIDECAR_URL` / `AUTOFIGURE_JOB_TIMEOUT_MS`）+ `depends_on` 仅 `service_started`（server 启动/health 不依赖 sidecar 就绪）
  - `.github/workflows/cd.yml`：第 4 镜像管线——normalize step 加 `AUTOFIGURE_IMAGE`；autofigure build&push step（context `deploy/autofigure-sidecar`，**vendored T08 源不 fetch mutable upstream**，tag `:latest`+`:head_sha`，cache scope=autofigure，对齐既有 server/frontend/openclaw 模式）；Stage .env 渲染加 `PANEL_AUTOFIGURE_IMAGE` + `AUTOFIGURE_LLM_KEY`（可选 secret，flag 关空串安全、缺失不导致部署失败）
  - `deploy/DEPLOY.md` / `README.md` / `.env.example`：四服务架构图、四镜像清单、secrets 清单加 `AUTOFIGURE_LLM_KEY`（可选）、AutoFigure 生产接线与运维段（flag 开关精确语义、部署面 pull/up vs 应用健康面 /api/health 区分、回滚 `PANEL_AUTOFIGURE_IMAGE`）
- first code review（双轴，对 `6d19c15`）:
  - Standards: **2 hard findings（均在 commit 前修复）**——①文件头「三服务」stale count → 四服务；②新增敏感值注释块与旧块重复 → 删旧块。1 judgement（「sidecar 缺失/未起」措辞过强：CD `pull`/`up` 仍部署 autofigure，与 flag 无关）→ 文档精确化（`/api/health` 应用健康不依赖 sidecar 运行状态；部署面与 flag 无关）；1 minor（cd.yml 文件头 secrets 清单漏 `AUTOFIGURE_LLM_KEY`）→ 补齐
  - Spec: **0 blocking**；sidecar 不可用检测保持用户批准的运维面（`docker compose health`/`unhealthy` + T07 信封码，**不扩 /api/health**）；accepted 实现选择：`depends_on: service_started`（用户硬约束 2 批准，非 service_healthy）与 `mem_limit: 2g`（T10/T11 judgement call，用户硬约束 5 批准）
- fixes（review 后、commit 前）: 上述 4 处文档修复，均无行为变化
- second code review: 无（T11 仅一轮 /code-review；修复均为文档级，未引入行为变化）
- validation（静态）:
  - `git diff --check` PASS
  - `docker compose -f deploy/docker-compose.deploy.yml config` + 10 项不变量断言 PASS（flag 默认 false / depends_on 非 service_healthy / sidecar 无 ports/volumes / `AUTOFIGURE_LLM_KEY` 空串安全 / 内部 DNS `autofigure:8080` / `JOB_TIMEOUT_MS` 1800000 / panel-net / restart / mem_limit / healthcheck）
  - cd.yml YAML 结构校验 PASS（四 build&push step、tags/cache/context、normalize `AUTOFIGURE_IMAGE`、.env 渲染 `PANEL_AUTOFIGURE_IMAGE` + `AUTOFIGURE_LLM_KEY`）
  - server 回归：**N/A**——T11 零 server 源码/测试变更（diff 仅 `deploy/` 与 `.github/`）
- Docker image build（autofigure）: **NOT EXECUTED** —— 本机 Docker daemon 不可用
- GHCR push: **NOT EXECUTED** —— 同上
- production runtime smoke: **NOT EXECUTED** —— 同上
- reason: 本机 Docker daemon 不可用（`/var/run/docker.sock` 指向缺失 socket）。以上三项属 **CI-owned / 后续运行时验证**，**不声称本地通过**——镜像构建/推送与运行时健康行为由 CD 管线首次部署时验证
- T12: 明确 out of scope，未进入
- commit: `d959f10`（implementation commit）+ `6176851`（completion-evidence commit：docs: record T11 completion evidence）
