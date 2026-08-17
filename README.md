# 多 OpenClaw 容器管理面板

Vue3(TypeScript) 前端 + TS/Express 控制面的**多 OpenClaw 容器管理面板**。
控制面经 Docker SDK 直接增/删/查 OpenClaw 容器，每容器内跑一个 `main` agent，面板提供对话、
wiki 编辑、model 配置等管理能力。交接规格见 `docs/research/320`（wayfinder #308 汇编）。

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

- **控制面**：`server/` —— TS/Express（Express 5 + ws 同进程 + Prisma 7 + SQLite + BullMQ/Redis +
  dockerode）。详见 `server/README.md`。
- **前端**：`frontend/` —— Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus。详见 `frontend/README.md`。
- **编排契约**：`deploy/` —— 单容器 compose 模板 + `deploy/openclaw.json`（全面板共享的配置单一来源）+ 生产 compose。详见 `deploy/README.md`。

## 页面（六页）

| 页面 | 功能 |
|------|------|
| 登录 | 本地账号 + R1 refresh 旋转（HttpOnly cookie）+ C1 首登强制改密 + OIDC 骨架（未配置时 90001） |
| 容器管理 | OpenClaw 容器增 / 删 / 状态查看，端口池自动分配 |
| 对话 | 与容器内 main agent 流式对话：权限审批、斜杠命令补全、思考链折叠、工具执行只显标题 |
| wiki 编辑 | 每容器 `wiki/main` 文件树 + Typora 式实时渲染 md 编辑器 + obsidian 风格图谱 |
| Model 配置 | 每容器 OpenClaw model provider 的 CRUD（openai-compatible + anthropic） |
| 账号管理（admin） | admin users 表（配额 used/limit、启停、改密、重置密码），admin-only 路由 |

> 全局 token 拦截：除授权白名单接口外，所有 REST/WS 请求须带 JWT；所有 REST 一律 HTTP 200 +
> 标准信封（`{code,message,data}`）。

## 本地开发

### 前置

- Node（`server/` + `frontend/`）、Docker daemon + compose plugin。
- Docker daemon：控制面经 `/var/run/docker.sock` 直连（⚠ 等价 root，本地/可信部署可接受）。
- Redis（可选，容器生命周期后台队列 BullMQ 需要；REST 认证/账号端点不依赖）。
- researcher 模板：容器预填充源 `OPENCLAW_TEMPLATE_DIR`，需 `git clone https://github.com/ACautomata/researcher` 后指向它。

### 启动

```bash
# 控制面（terminal 1）
cd server
npm install
npm run prisma:generate && npm run db:apply
npm run dev                              # tsx watch，http://localhost:8001（REST + WS 同端口）

# 前端（terminal 2）
cd frontend
npm install
npm run dev                              # Vite dev server（proxy /api、/ws → :8001）
```

### 测试

```bash
cd server    && npm run typecheck && npm test && npm run build   # tsc + vitest + 构建
cd frontend  && npm run test && npm run build                    # vitest + vue-tsc
```

## 关键机制

- **容器编排**：每容器一个命名 home + 渲染后的 `openclaw.json` + 宿主端口；容器命名
  `openclaw-gw-<name>`，label `app=openclaw-fleet`；删除默认连数据一起删。
- **配置单一来源**：`deploy/openclaw.json` 是全面板共享模板，`ConfigRenderer` 渲染每容器配置并强制
  安全不变量（port/bind/token 占位）；`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值以 AES 密文落盘。
- **端口池**：宿主侧池 `19000–19999`（容器内统一 18789，靠 Docker 网络命名空间隔离；池避开被单容器
  compose 占用的 18789），创建取最小空闲、删除回收。
- **设备配对**：chat/审批/补全/工具事件须先完成 Ed25519 设备配对（签名 challenge → 宿主 approve →
  deviceToken 持久化）；A3 双层状态机 `PAIRING_REQUIRED→APPROVING→PAIRED`（可重试无 FAILED 终态），
  宿主 approve 由控制面在容器内 `openclaw devices approve` 编排（ADR 0006）。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` 等价 root（spec §5.4 明示风险）；本地/可信
  部署可接受，生产应限制控制面网络面或改用 rootless / 远程 TLS daemon。

## 配置

控制面经环境变量读取（见 `server/.env.example` 与 `server/src/config.ts`；生产 fail-fast 校验）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `JWT_SECRET` | dev 不安全默认 | HS256 签名密钥；**生产必填** ≥32 字符（`NODE_ENV=production` 时 fail-fast） |
| `DATABASE_URL` | `file:./prisma/panel.db` | SQLite 连接串（Prisma driver adapter） |
| `PORT` | `8001` | 控制面监听端口（REST + WS 同端口） |
| `OPENCLAW_FLEET_ROOT` | `<cwd>/fleet` | `instances/<name>/` 落盘根（生产显式 pin 绝对路径） |
| `OPENCLAW_TEMPLATE_DIR` | dev: `<repo>/researcher`（生产必设） | 共享只读 researcher 模板（预填充源）；**生产/Docker 部署必填**绝对路径（fail-fast） |
| `OPENCLAW_IMAGE` | `ghcr.io/acautomata/researcher-service/openclaw:latest` | 镜像 tag（派生镜像 issue #588：pdftotext + wiki/workspace 骨架，ADR 0013；可覆盖回官方基线） |
| `LLM_API_KEY` | — | 全面板共享 LLM key（env 注入容器，不落盘） |
| `PANEL_PUBLIC_ORIGIN` | `http://127.0.0.1:18789` | 面板对外 origin（隧道连网关 + 容器 allowedOrigins 强制条目）；**生产必填** |
| `CREDENTIAL_ENCRYPTION_KEYS` | dev 固定密钥 | 凭证加密（gateway token 落盘密文）；**生产必填**逗号分隔 base64(32B) |
| `REDIS_URL` | `redis://localhost:6379/0` | BullMQ 后台队列 |

网关部署侧环境变量见 `deploy/.env.example`（`GATEWAY_TOKEN` / `LLM_API_KEY` 等）。
