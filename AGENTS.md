# AGENTS.md

This file provides guidance to Qoder (qoder.com) / Claude Code when working with code in this repository.

## Project overview

多 OpenClaw 容器管理面板。**Vue3(TypeScript) 前端 + TS/Express 控制面**，前后端分离。
控制面经 Docker SDK 直接增/删/查 OpenClaw 容器，每容器内跑一个 `main` agent；面板提供对话、
wiki 编辑、model 配置等管理能力。交接规格见 `docs/research/320`（wayfinder #308 汇编）。

> 旧 Django(DRF + Channels) 后端已退役（#341 M9 收尾），当前为 Express + ws 同进程控制面。

## Layout

```
server/     TS/Express 控制面（Express 5 + ws + Prisma 7 + SQLite + BullMQ/Redis + dockerode）
frontend/   Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus
deploy/     编排契约：单容器 compose 模板 + openclaw.json（配置单一来源）+ 生产 compose
docs/       research/ + prototypes/ + adr/
```

## Commands

```bash
# ---- server（TS/Express 控制面）----
cd server
npm install
npm run prisma:generate                        # 生成 Prisma client（fresh checkout 必须）
npm run db:apply                               # 落表（better-sqlite3 直连 prisma/init.sql）
npm run dev                                    # tsx watch 宿主直跑（仅纯逻辑调试——摸不到 named volume；起服务/真编排走下方容器化 dev 栈）
npm run typecheck                              # tsc --noEmit
npm test                                       # vitest 全量（containers-smoke 需真 docker daemon）
npm run build                                  # tsc + prisma generate 产物拷贝

# ---- frontend（Vue3 + Vite）----
cd frontend
npm install
npm run dev                                    # Vite dev server（proxy /api、/ws → :8001，指向容器化 server）
npm run test                                   # vitest
npm run build                                  # vue-tsc 类型检查 + vite build

# ---- dev 控制面（容器化，与 prod 同形态；issue #594 / ADR 0013）----
# 起服务 / 真编排 OpenClaw 容器（named volume 拓扑）一律走此；纯逻辑迭代仍用上方宿主 npm test/typecheck。
docker compose -f deploy/docker-compose.dev.yml up -d --build   # server+redis，挂 docker.sock，server:8001
# 前置：researcher 克隆到仓库根（build context template=../researcher，或设 RESEARCHER_DIR）；
#       真编排另需派生镜像（docker build deploy/openclaw-image）+ export LLM_API_KEY。详见 deploy/README.md。
```

## 架构总览

```
浏览器 (Vue3 + TS)
    │ HTTP/REST (JWT Bearer)        │ WebSocket (JWT subprotocol)
    ▼                               ▼
Express 控制面 (server/, localhost:8001)
    │ auth / users / containers / wiki / models / chat  (路由按域)
    │ 全局 #312 信封（HTTP 200 + {code,message,data}）+ jose HS256 认证
    ▼
Docker SDK 控制面 (containers)          网关隧道 (chat，浏览器直连网关)
    │ dockerode 挂 docker.sock             │ 隧道只做握手 4401 + 原始帧透传
    ▼                                     ▼
OpenClaw 容器 fleet (openclaw-gw-<name>，每容器独立 home/openclaw.json/宿主端口)
```

## server 模块边界（`server/src/`）

| 域 | 职责 | 关键模块 |
|-----|------|----------|
| `auth/` | 双角色账号 + JWT 签发/刷新（R1 旋转）+ bootstrap B1 + C1 强制改密 | `tokens.ts` `authenticate.ts` `bootstrap.ts` `userService.ts` |
| `containers/` | Docker SDK 编排（增/删/查容器、端口池、config 渲染、5 态机） | `orchestrator.ts` `dockerRuntime.ts` `ports.ts` `configRenderer.ts` `fleetAssembly.ts` |
| `wiki/` | 每容器 `wiki/main` 文件树 + CRUD + graph（`WikiFileSystem` Port + 纯逻辑） | `service.ts` `logic.ts` `nodeFs.ts` `compile.ts` `routes.ts` |
| `models/` | 每容器 model provider CRUD + 静态 config 写盘（putArchive 落容器内，改配置重启生效）+ 写盘回滚 | `configWriter.ts` `routes.ts` |
| `chat/` | 网关隧道（JWT 握手 4401 + 原始帧透传，ADR 0006 浏览器直连） | `tunnelAssembly.ts` `subprotocol.ts` `values.ts` |
| `files/` | 统一文件 CRUD（wiki/workspace 两树，经 Docker getArchive/putArchive/exec rm，ADR 0012） | `fsPort.ts` `dockerArchive.ts` `paths.ts` `tar.ts` `routes.ts` |

配置集中在 `src/config.ts`（env 读取 + 生产 fail-fast）。Prisma schema 在 `prisma/schema.prisma`
（建表 SQL 由 `scripts/apply-schema.mjs` 落库，不经 prisma CLI——规避 Prisma 7 AI 守卫）。

## API / 路由

- `GET /api/health`（公开）。
- `/api/v1/auth/*` — 登录/refresh(R1 旋转)/logout/me/password/change + OIDC `oauth/<p>/login|callback`（未配 provider 时 90001）。
- `/api/v1/users` — admin 账号管理（GET 连带 containerCount / POST / PATCH / reset-password；码段 1xxxx）。
- `/api/v1/containers/*` — 容器列表/新建（同步返 creating 快照）/删除（异步信封）。
- `/api/v1/containers/<name>/pairing/` — 设备配对查询/触发/approve。
- `/api/v1/containers/<name>/wiki/{tree,page,graph,categories}` — wiki 文件树/读写/图谱。
- `/api/v1/containers/<name>/models/providers[/<pid>]` — model provider CRUD。
- `/api/v1/containers/<name>/files?root=<wiki|workspace>&path=&recursive=` — 统一文件 CRUD
  （GET 列目录/读文件 + PUT/POST 覆写/新建 + DELETE 删除；binary/oversized 不返回内容）。
- `/api/v1/containers/<name>/chat/{sessions,approval/resolve,commands}` — chat REST 代理。
- 对话 WS 走 `/ws/chat/` 隧道（JWT subprotocol 握手；先 accept 再 close(4401) 拒未认证）。

全局 #312 信封：所有 REST 一律 HTTP 200，错误信号在 body `{code,message,data}`；「不存在 vs 越权」
同码防探测（20040/30040/40040/60040）。例外：二进制成功路径直发原生字节（`GET /figures/:id/png` 成功
返 `image/png` 字节，不包信封、不 base64-in-JSON；错误面仍走信封）。码段：`0` 成功 · `1xxxx` 通用/鉴权 ·
`2xxxx` 容器 · `3xxxx` wiki ·
`4xxxx` models · `5xxxx` chat/pairing（非信封段，错误经 WS close codes）· `6xxxx` files ·
`7xxxx` figures（AutoFigure，70040 不存在/越权同码防探测（T05 读路径，PNG 复用同一归属门）· 70041 幂等冲突 ·
70042 PNG 未就绪（queued/running）· 70043 PNG 不可用（failed/产物缺失））·
`9xxxx` 系统/校验。

## frontend 结构（`frontend/src/`）

- `router/index.ts` — 路由表 + 导航守卫（未登录重定向 `/login`，`auth.hydrate()` 恢复登录态；
  `meta.requiresAdmin` 守卫 admin users 页）。
- `stores/` — Pinia：`auth.ts`（JWT access token + role/mustChangePassword）、`wiki.ts`、`chatStore.ts`。
- `api/` — REST client 封装（`client.ts` 信封解析 + 401 刷新链 + 并发去抖；`chat/containers/wiki/models/users.ts` 按域）。
- `chat/` — 网关直连协议机（官方 `@openclaw/gateway-client` 浏览器端）：`gatewayChat.ts` /
  `useChatConnection.ts`（composable）/ `eventTranslate.ts`（纯函数翻译）。
- `views/` — 六页：`LoginView` / `ContainersView` / `ChatView` / `WikiView` / `ModelView` / `AdminUsersView`。
- `components/` — `FileTree` / `MdEditor`（Typora 式实时渲染）/ `WikiGraph`（obsidian 风格图谱）/
  ChatView 8 组件（`ChatSidebar`/`ChatHeader`/`ChatStream`/`ChatComposer`/`ChatMessageItem`/`ThinkingCard`/`ToolLine`/`ApprovalCard`）。

## 关键机制与约束

- **配置单一来源**：`deploy/openclaw.json` 是全面板共享模板；`ConfigRenderer` 渲染每容器配置并强制
  安全不变量（port/bind/token 占位）。`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值落盘为 AES 密文。
- **端口池**：宿主侧池 `19000–19999`（容器内统一 18789，靠 Docker 网络命名空间隔离；池避开单容器
  compose 占用的 18789），创建取最小空闲、删除回收（`containers/ports.ts`）。
- **设备配对**：chat/审批/补全/工具事件须先完成 Ed25519 设备配对（签名 challenge → 宿主 approve →
  deviceToken 持久化）。A3 双层状态机 `PAIRING_REQUIRED→APPROVING→PAIRED`（可重试无 FAILED 终态），
  宿主 approve 由控制面在容器内 `openclaw devices approve` 编排（ADR 0006）。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制控制面网络面或改用 rootless / 远程 TLS daemon。
- **输入 0 信任**：所有写操作经 zod schema 强制校验（`validation/schemas.ts`），禁裸读 `req.body`。
- **凭证**：LLM key 全面板共享（`LLM_API_KEY` env 注入容器，不落盘）；`CREDENTIAL_ENCRYPTION_KEYS`
  加密 gateway token 落盘密文。
- **生产部署**：`deploy/docker-compose.deploy.yml`（frontend nginx + server + redis 三服务），
  CD 经 GitHub Actions 构建 `server`/`frontend` 镜像推 GHCR 并部署宝塔宿主（见 `deploy/DEPLOY.md`）。
- **测试**：
  - server：`cd server && npm test`（vitest；接缝 1–5：wiki Port / 信封 REST / WS 桥 / hostDeps /
    编排器 Port）。容器编排集成 smoke 需真 docker daemon（自动探测门控）；BullMQ 用例需真 Redis（门控）。
  - frontend：`cd frontend && npm run test`（vitest）；`npm run build` 跑 vue-tsc 类型检查。

## Issue tracker / triage

Issues 跟踪在 GitHub `ACautomata/researcher-service`（`gh` CLI）。见 `docs/agents/issue-tracker.md`、
`docs/agents/triage-labels.md`（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。
