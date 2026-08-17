# deploy —— OpenClaw 容器编排契约与配置单一来源

本目录承载多 OpenClaw 容器面板的**编排契约**：

- `openclaw.json` —— **全面板共享的配置单一来源 / 模板**。Express 控制面 `ConfigRenderer`
  （`server/src/containers/config_renderer.ts`）以它为底渲染每容器配置，compose 栈也单独 bind-mount 它。
- `docker-compose.yml` —— **单容器联调 / 模板栈**。用于本地手动起一个 OpenClaw 网关做协议联调；
  多容器 fleet 由控制面经 Docker SDK 直接编排（不走本 compose），但镜像、env、挂载契约与此保持一致。
- `.env.example` —— 网关环境变量模板（`GATEWAY_TOKEN` / `LLM_API_KEY` 等）。

镜像默认 `ghcr.io/acautomata/researcher-service/openclaw:latest`（**自建派生镜像**，issue #588：`FROM`
官方 `ghcr.io/openclaw/openclaw:2026.7.1-browser` 叠加 `pdftotext` 与 wiki/workspace 骨架，ADR 0011/0013；
源在 `deploy/openclaw-image/`，经 `OPENCLAW_IMAGE` 可覆盖回官方基线），把 [ACautomata/researcher](https://github.com/ACautomata/researcher)
仓库作为容器 `~/.openclaw` 配置卷挂载。researcher 仓库**不动**（其 workspace/、wiki/、skills/ 仍照常挂载）。

## 在新架构中的位置

```
Express 控制面 (server/src/containers)
    │ 1. 以 deploy/openclaw.json 为底渲染每容器 openclaw.json（强制 port/bind/token 占位），
    │    putArchive 落容器内 ~/.openclaw/openclaw.json（静态 config，#591，零宿主路径）
    │ 2. Docker SDK 挂 /var/run/docker.sock 建/删容器 openclaw-gw-<name>
    │ 3. named volume 拓扑（ADR 0011，#590/#592）：openclaw-wiki/workspace/home-<id> 三卷，
    │    空卷首挂由镜像内 ~/.openclaw 骨架自动初始化；home 模板（researcher 克隆）生产经
    │    server 镜像构建期入镜像（ADR 0013，#593），不再挂载宿主
    ▼
OpenClaw 容器 fleet（容器内统一 18789，宿主端口池 19000–19999 取最小空闲）
```

- **配置单一来源在本目录**：`deploy/openclaw.json` 是精简版配置。每容器渲染产物经 putArchive 落
  容器内 `~/.openclaw/openclaw.json`（named volume / bind home 内，零宿主路径）；`GATEWAY_TOKEN`
  每容器独立生成、经 env 注入，JSON 内仅 `${GATEWAY_TOKEN}` 占位。**凭证边界（ADR 0006 决定 7
  修订）**：真值仍不落服务端盘/日志，但 bootstrap token / deviceToken **可下发给容器属主的浏览器
  设备**（B-直连下浏览器经隧道直连网关所必需，有效安全级≈面板 JWT；网关藏隧道后凭证离了隧道无从使用）。
- **端口池**：宿主侧池 `19000–19999`（避开被本单容器 compose 占用的 18789），创建取最小空闲、
  删除容器即回收。容器内统一 18789，靠 Docker 网络命名空间隔离。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制网络面或改用 rootless / 远程 TLS daemon。

## 设备配对（B-直连，浏览器侧）

OpenClaw 的 operator scope **不在 WS connect 握手声明授予**，而来自**设备配对记录**（Ed25519 签名
challenge → 宿主 approve → deviceToken，spec §8.1 / issue #36 已证）。B-直连下配对发生在**浏览器**
（官方 `@openclaw/gateway-client` 协议机，设备身份/tokenStore 存 localStorage），后端只做三件薄事：

- **bootstrap 发放**：`POST /api/v1/containers/<name>/bootstrap-token`（所有权门控，非 running → `20046`）。
- **approve 编排**：浏览器首连遇 `PAIRING_REQUIRED{requestId}` → 自动
  `POST /api/v1/containers/<name>/pairing/approve/<requestId>` → 后端容器内 docker exec
  `openclaw devices approve <requestId>`（浏览器永不接触容器 exec 通道，ADR 事实 3 物理约束）。
- **进度记账**：`Pairing` 表 status（unpaired/pending/paired）+ pairingRequestId 落库，容器列表
  `GET /api/v1/containers/` 的 pairing 快照随行展示（容器页可确认配对进度）。

配对闭环真网关实测见 `server/test/pairingSmoke.test.ts`（#378，门控 smoke）。

## 凭证加密与密钥轮换

后端将 `Instance.token`、`Pairing.private_key_pem` 和 `Pairing.device_token` 以 AES-256-GCM 密文持久化。生产环境必须通过环境变量注入密钥，绝不能将密钥提交到 `.env.example`、镜像或日志中：

```bash
export CREDENTIAL_ENCRYPTION_KEYS="<current-base64url-key>,<previous-base64url-key>"
```

每个 key 必须是 32 字节的 base64url 编码值；第一个是当前写入 key，后续 key 仅用于读取历史密文。使用部署平台的 secret store 或受控环境注入该变量。

轮换步骤：

1. 备份数据库，并记录当前 key ring。
2. 生成新 32 字节 key；将它放在 `CREDENTIAL_ENCRYPTION_KEYS` 的第一个位置，旧 key 保留在后面。
3. 重启控制面使新配置生效（Express 控制面仅读 env，无独立旋转命令；写入用新 key、旧 key 继续读历史密文）。
4. 验证应用可读取既有实例和配对记录，并完成数据库备份校验。
5. 从环境变量移除旧 key，再次重启；此时旧 key 可以安全下线。

> 注：`deviceToken`/`privateKeyPem` 真值不下发服务端（B-直连，存浏览器 localStorage），服务端 Pairing 行
> 的对应列为密文占位；轮换影响的明文列主要是 `Container.token`（GATEWAY_TOKEN 密文）与历史遗留行。

若怀疑 key 泄露：立即限制密钥访问权限，按以上流程生成并启用新 key、执行重加密、移除泄露 key；同时撤销并重新配对受影响设备、轮换网关 token，并审计部署平台与数据库访问日志。

## 前置

- Docker + compose plugin
- 控制面经容器宿主映射端口（池 `19000–19999`）+ 每容器 `GATEWAY_TOKEN` 访问网关；本单容器栈默认
  收敛到 `127.0.0.1:18789`。

## 单容器联调步骤

```bash
# 1. 克隆 researcher 配置仓库（本仓库根下；或设 RESEARCHER_DIR 指向它）
#    提供 workspace/ + wiki/ + skills/；其 openclaw.json 会被本目录的覆盖，无需手改
git clone https://github.com/ACautomata/researcher ./researcher

# 2. 配置环境
cp deploy/.env.example deploy/.env
#    填入 GATEWAY_TOKEN（强随机）与 LLM_API_KEY

# 3. 启动单容器网关（联调用）
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d

# 4. 验证
docker logs -f openclaw-gateway
curl http://127.0.0.1:18789/health
```

## 配置精简（不接任何消息 channel）

`deploy/openclaw.json` 已是精简好的版本，相对 researcher 原始配置的精简点（依据
`docs/research/r8-channels-plugins.md`）：

- **删** `channels`（整个块）与 `bindings`：留 `feishu.enabled=true` 会因缺 `FEISHU_*` secret 启动失败。
- **改** `plugins.slots.contextEngine`: `"lossless-claw"` → `"legacy"`；删 `plugins.entries.lossless-claw` / `plugins.installs.lossless-claw`。
- **留** 顶层 `browser` + `plugins.entries.browser`、`plugins.entries.memory-core`、`plugins.entries.minimax`、`plugins.entries.memory-wiki`（enabled:true）。
- **改** `gateway.bind` → `lan`：跨容器/宿主经 18789 访问网关必需（`loopback` 时 Docker 端口映射不到容器内 loopback）。sync 全关后 env 覆盖不可靠，故直接写进 JSON。
- **改** `gateway.controlUi.allowInsecureAuth` → `false`：token 认证始终强制，关掉 Control UI 的 insecure-auth 降级路径。
- **WS 注意**：本部署走 WebSocket（见 #13），HTTP `responses.enabled` 非必需。

## 关键点（来自 R6/R7/R8）

- 挂载：`${RESEARCHER_DIR:-../researcher}` → `/home/node/.openclaw`（读写）；`deploy/openclaw.json` →
  `/home/node/.openclaw/openclaw.json`（覆盖）。gateway 读 `/home/node/.openclaw/openclaw.json`。
  **相对路径解析基准 = 本目录（deploy/）**，故仓库根的 researcher 默认写作 `../researcher`；若默认写成
  `./researcher` 会解析成 `deploy/researcher`（不存在时 compose 自建空目录，导致 workspace/wiki/skills 全缺失）。
- 4 个 sync flag 全关，init.sh 不覆写挂载的 openclaw.json、不明文写凭证。
- `LLM_API_KEY` 经 env 注入、SecretRef 运行时读，勿写盘。
- **token 认证始终强制**：WS 握手 `connect.params.auth.token` 必须带 `GATEWAY_TOKEN`。容器不设
  `ALLOW_INSECURE_AUTH` env，且 `deploy/openclaw.json` 已把 `controlUi.allowInsecureAuth` 置 `false`，
  彻底关闭 insecure-auth 降级路径。端口收敛到 `127.0.0.1`。
- wiki 在 `/home/node/.openclaw/wiki/main`（memory-wiki 插件），宿主侧即 `./researcher/wiki/main`。
- 运行时 `state/`、`logs/` 用匿名卷，避免污染宿主 researcher git 树。

## 与控制面的衔接

- 控制面配置走环境变量（`server/src/config.ts`）：`OPENCLAW_TEMPLATE_JSON` 默认指向
  本目录 `deploy/openclaw.json`，`OPENCLAW_FLEET_ROOT` 为 `instances/<id>/` 落盘根（生产须绝对路径，
  fail-fast），镜像/端口池见 `server/.env.example`。
- model provider 的 CRUD 经控制面 `models` 域重渲染每容器 `openclaw.json` 生效（热加载，无需重启，
  spec §7 / issue #47）。

## 面板 dev 栈（容器化控制面，issue #594 / ADR 0013）

dev 不再 `npm run dev` 宿主直跑控制面，改 `docker-compose.dev.yml` 起 server+redis 容器、挂
docker.sock，与 prod（`docker-compose.deploy.yml`）**同形态**——消除「宿主直跑摸不到 named
volume（卷物理路径在 Docker VM 内）→ dev/prod 寻址/路径分叉」（ADR 0012）。

```bash
# 1. 克隆 researcher（build additional_contexts template= 默认 ../researcher；或设 RESEARCHER_DIR）
git clone --depth 1 https://github.com/ACautomata/researcher ./researcher

# 2.（仅真编排需）备派生镜像 + LLM key；仅起控制面/登录可跳过
docker build -t ghcr.io/acautomata/researcher-service/openclaw:latest deploy/openclaw-image
export LLM_API_KEY=...

# 3. 起 dev 控制面（server:8001，挂 docker.sock + panel-dev-db 卷）
docker compose -f deploy/docker-compose.dev.yml up -d --build

# 4. 前端仍宿主 vite dev（proxy /api、/ws → 127.0.0.1:8001）
cd frontend && npm run dev

# 改 server 代码 → 重建镜像
docker compose -f deploy/docker-compose.dev.yml up -d --build server
```

- **与 prod 对齐**：寻址（`host.docker.internal` + `0.0.0.0` 发布 + host-gateway）、模板/config
  镜像内路径、`REDIS_URL`、`DATABASE_URL`、`OPENCLAW_FLEET_ROOT` 逐键一致；仅
  `NODE_ENV=development`（走 config.ts dev 分支）与「server 暴露 8001 给宿主 vite」为 dev 特有。
- **双轨工作流**：纯逻辑快速迭代仍走宿主 `cd server && npm test` / `npm run typecheck`（不起服务、
  不摸卷）；凡要起服务 / 真编排 OpenClaw 容器（named volume 拓扑），一律走本容器化 dev 栈。

## AutoFigure 接线（T10，docs/autofigure/tickets/T10-dev-sidecar-smoke.md）

dev 栈额外起 **autofigure**（T08 sidecar）服务：仅挂 `panel-dev-net`、**无宿主端口暴露、零 host 挂载**
（ADR 0013），`/health` 容器 healthcheck；`mem_limit: 2g` 为 T10 judgement call（真实生成 = Playwright
渲染 + LLM 调用的内存上限，T11 生产 compose 复用同值，见下）。server 经 env 注入 `AUTOFIGURE_ENABLED`
（默认关）`AUTOFIGURE_LLM_KEY` `AUTOFIGURE_SIDECAR_URL`（默认 `http://autofigure:8080`）
`AUTOFIGURE_JOB_TIMEOUT_MS`（默认 1800000）；凭证仅经 env 插值、由 server 经 `X-Autofigure-Api-Key`
header 注入 sidecar，不落盘/不入日志/不 commit 假值。

**flag 默认关**：`AUTOFIGURE_ENABLED=false` 时 server 不装配 AutoFigure runtime（queued 不迁移），
sidecar 不参与面板启动/health 依赖（`depends_on` 仅 `service_started`，dev 栈不因 sidecar 卡死）——
生产/公开 API 契约不变。

### 门控真实生成 smoke（宿主 vitest + 真 sidecar 容器）

```bash
# 1. 构建 sidecar 镜像（T08 交付；dev 镜像非 registry，smoke 绝不 pull）
docker compose -f deploy/docker-compose.dev.yml build autofigure
#    或 docker build deploy/autofigure-sidecar -t autofigure-sidecar:dev

# 2. 设真 key + 打开 smoke（三条件门控：docker 可用 + AUTOFIGURE_SMOKE=1 + key 非空，缺一自动跳过）
cd server
AUTOFIGURE_SMOKE=1 AUTOFIGURE_LLM_KEY=sk-... npm test -- figuresSmoke
```

- **sidecar 可达**（对齐 containers-smoke 模式）：测试经 dockerode 自建 sidecar 容器到默认 bridge，
  **无 `-p` 端口发布**（AC2「sidecar 无宿主端口暴露」保持），经容器 bridge IP 访问内部 8080；
  显式设 `AUTOFIGURE_SIDECAR_URL`（指向任一可达 sidecar）可跳过编排复用既有实例（灵活路径，非默认）。
- **走真实公开 API 全链**：`bootstrap B1`（日志临时密码）→ `login` → `password/change`（C1）→
  二次 `login` → `POST /api/v1/figures`（Idempotency-Key）→ 轮询 `GET /:id` → succeeded →
  `GET /:id/png` 原生 PNG 字节。直接调 `/v1/generate` **不算** T10 smoke。
- **超时**：应用执行超时 `AUTOFIGURE_SMOKE_TIMEOUT_MS`（默认 600000，T10 实施选择，nginx 300s×2
  余量；非法/空串回退默认），生产唯一执行超时仍为 `AUTOFIGURE_JOB_TIMEOUT_MS`（默认 1800000）——
  smoke 不等待真实 30min；轮询截止独立（应用超时 + 60s），二者不引入第二 timeout 契约。
- **sidecar 容器清理**：测试 `afterAll` 强制移除（含半途失败）；异常退出（SIGKILL）残留时手动
  `docker rm -f autofigure-smoke-*`。

## AutoFigure 生产打包（T11，docs/autofigure/tickets/T11-production-packaging-cd.md）

生产 compose（`docker-compose.deploy.yml`）经 CD 起 **panel-autofigure** 第 4 镜像
`ghcr.io/acautomata/researcher-service/autofigure`（CD 既有管线构建推送，vendored T08 源**不 fetch
mutable upstream**；许可/署名文件构建期入镜像 + Dockerfile 构建期断言）。接线与 dev 同构：仅挂
`panel-net`、**无宿主端口、零 host 挂载**（ADR 0013）、`/health` 容器 healthcheck、`mem_limit: 2g`
（T10/T11 judgement call）、`restart: unless-stopped`、内部 URL `http://autofigure:8080`、
`AUTOFIGURE_JOB_TIMEOUT_MS` 生产显式 1800000（生产唯一 AutoFigure timeout 契约，不引入第二 timeout）。
镜像覆盖位 `PANEL_AUTOFIGURE_IMAGE`（`:latest` / `:<sha>` 回滚）对齐 `PANEL_*_IMAGE` 先例。

**flag 生产默认关**：compose 显式 `AUTOFIGURE_ENABLED: ${AUTOFIGURE_ENABLED:-false}`，须宿主 `.env`
显式设 `true` 才开启。flag 关 → server **不装配** AutoFigure runtime（不启动 runner、不要求
key/sidecar 可达，figures 路由 90005）、`/api/health`（面板应用健康）**不依赖 sidecar 运行状态**
（sidecar 容器 unhealthy/未就绪不影响 panel 健康门）。部署面：autofigure 是栈内声明服务，CD 的
`docker compose pull`/`up` 仍会部署它——sidecar 镜像不可拉/容器 start 失败 → CD/up 变红，与 flag
无关（flag 关并不豁免该服务被部署）。**sidecar 容器仍随 `up -d` 启动但未被使用**（compose 无
profile/条件服务机制，如实文档化——不声称「flag 关 sidecar 不运行」）。flag 开 → sidecar 不可用经
既有部署面探针检测（`docker compose ps` 显示 `unhealthy`），生成失败走 T07 规范化信封码，**不模糊
500、不扩 `/api/health`**。

**凭证**：`AUTOFIGURE_LLM_KEY` 经 CD 渲染 `.env` → `env_file` 注入 server（可选 secret，flag 关空串
安全、缺失不导致部署失败——config 只在 enabled && production 下 fail-fast），由 server 经
`X-Autofigure-Api-Key` header 注入 sidecar，不落盘/不入日志/不 commit。运维/健康面见
`deploy/DEPLOY.md`「AutoFigure 生产接线与运维」。
