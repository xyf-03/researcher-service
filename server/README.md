# server — TS/Express 控制面（M0–M5 全域 + M9 生产部署）

Wayfinder map **#308** · 交接规格 **#331** · 切片 **#333（M0+M1）/ #334（M2）/ #335（M3 wiki）/
#336（M4 models）/ #337（M5 对话隧道）/ #341（M9 生产部署 + Django 退役）**。

Express+ws 同进程控制面（替代已退役的 Django 后端）。已交付：
- **M0 骨架 + M1 认证与账号**（#333）：双角色 login / R1 refresh 旋转 + 重放检测 / logout / me /
  password-change / bootstrap B1 + C1 强制改密 / OAuth2 O1 骨架 / admin 账号管理 4 端点。
- **M2 容器生命周期**（#334）：容器按用户隔离的完整生命周期——编排器 Port + BullMQ(Redis) 后台队列
  + 端口池 + 5 态机 + 异步 delete + 取消标志。`GET /containers/`（user 自己 / admin 全部 + pairing
  预取）、`POST /containers/`（同步返 creating 快照、端口入队前分配）、`DELETE /containers/<name>`
  （异步信封、置取消标志）。
- **M3 WIKI**（#335）：5 路由 7 方法逐字节平移——`WikiFileSystem` Port + 纯逻辑
  （`FrontmatterParser`/`CategoryMarkerExtractor`/`WikilinkResolver`）+ compile 去抖 5s（docker exec，best-effort）
  + FS 安全（symlink 不跟随 / SKIP 集合 / path 双保险）。
- **M4 Models**（#336）：provider CRUD + `provider_id` 唯一 40041 + openclaw.json 热加载（config 目录
  ro bind + `OPENCLAW_CONFIG_PATH`）+ key 零落盘 + 写盘回滚 90003。
- **M5 对话桥接**（#337/#369/#371/#378/#385）：**ADR 0006 浏览器直连**——`/ws/chat/` 隧道只做 JWT
  握手 4401 + 归属门 + 原始帧透传（协议机在浏览器官方 `@openclaw/gateway-client`）；配对走
  approve 端点（docker exec）+ bootstrap-token 端点；`PANEL_PUBLIC_ORIGIN` 生产 Origin 接线。

生产部署（#341）：`deploy/docker-compose.deploy.yml`（frontend nginx + server + redis 三服务）+
CD 构建 `server` 镜像推 GHCR；Django 后端已退役删除。见下方「生产部署」。

## 技术栈（规格 §A 锁定）

Express 5 + `ws` 8（noServer，upgrade 钩子 M4 接）+ `jose` 5（HS256，显式 `algorithms:['HS256']`）
+ Prisma 7 + SQLite（driver adapter `@prisma/adapter-better-sqlite3`）+ `bcryptjs`(cost=12) + `zod`
+ **BullMQ 6 + ioredis**（#313 容器后台 provisioning 队列，Redis-backed）+ **dockerode**（docker.sock
容器编排）。JWT 平移 simplejwt 默认（HS256、access 5min、refresh 7d）。

## 目录

```
src/
  app.ts                 createApp({prisma, orchestrator?}) 工厂（DI，测试注入 test DB + 假编排）
  server.ts              createServer(app) + server.on('upgrade') 隧道分流 + bootstrap + assembleFleet + listen
  config.ts              env 读取（JWT_SECRET/access/refresh TTL/bcrypt cost/fleet/redis/...，生产 fail-fast）
  prisma.ts              PrismaClient 工厂 + 单例（driver adapter 注入）
  codes.ts               五位分层码常量表（#312 + #319 转译 + 各切片新增）
  envelope.ts            唯一错误面：EnvelopeError + ok()/fail()
  auth/                  tokens / authenticate / bootstrap / password / userService / quota
  middleware/            auth(→10001/10004) / mustChangePasswordGate(→10005) / validate(→90002) / errorHandler
  routes/                health / auth / users / containers
  validation/schemas.ts  zod schema（login/passwordChange/userCreate/userPatch/containerCreate）
  wiki/                  #335 WIKI：routes / service（纯逻辑）/ nodeFs（WikiFileSystem Port 实现）/
                         compile（docker exec 去抖）
  models/                #336 Models：routes / configWriter（openclaw.json 重渲染写盘）
  chat/                  #337 M5：tunnelAssembly（/ws/chat/ 隧道）+ subprotocol + values（close 码常量）
  containers/            #334 编排域：
    constants.ts         纯常量（18789/openclaw-gw- 前缀/label/bind 路径/占位）
    errors.ts            领域错误族（携带信封码；errorHandler 统一转译）
    runtime.ts           ContainerRuntime Port（docker 接触面）+ ContainerSpec/ContainerInfo
    dockerRuntime.ts     DockerRuntime（dockerode，真 daemon 接触面）
    ports.ts             PortAllocator（最小空闲端口）
    values.ts            FleetConfig + HEALTH_* 枚举
    imageRef.ts          镜像引用钉版判定（isFloatingImageRef / imageTag 纯知识；#695）
    configRenderer.ts    openclaw.json 渲染（强制 port/bind/token 占位安全不变量）
    provisioner.ts       HomeProvisioner（cp -a 模板预填充 home）
    leaseMap.ts          NameLeaseMap 进程内互斥（不依赖 Redis，防双创建/双删除）
    lifecycleQueue.ts    LifecycleQueue Port + InlineLifecycleQueue + NameSerializer（按 name 串行）
    bullmqQueue.ts       BullMqLifecycleQueue（Redis-backed，worker 并发默认 2，stalled 重跑）
    deps.ts              FleetDeps 组合根（单点装配 + 测试替换）
    command.ts           FleetCommand 写侧（create_reserve/create_complete/delete + 取消标志 + 补偿）
    readModel.ts         FleetReadModel 读侧（list 聚合 + creating 对账 + ContainerSummary）
    orchestrator.ts      Orchestrator 薄 facade + getInstanceForUser 归属前置
    fleetAssembly.ts     生产装配（DockerRuntime + BullMQ + FleetDeps + Orchestrator）
test/                    接缝 #1–#5（wiki Port / 信封 REST / WS 桥 / hostDeps / 编排器 Port）+ 集成 smoke
prisma/                  schema.prisma + init.sql（migrate diff 产出的建表 SQL）
scripts/apply-schema.mjs 把 init.sql 落到 dev DB（不经 prisma CLI，规避 AI 守卫）
Dockerfile               生产镜像（多阶段；entrypoint 幂等落表 + node dist/server.js，见「生产部署」）
```

## 开发

```bash
npm install
npm run prisma:generate        # 生成 client 到 src/generated/prisma
npm run db:apply               # 把 prisma/init.sql 落到 file:./prisma/panel.db（建表）
cp .env.example .env           # 按需改 JWT_SECRET 等
npm run dev                    # tsx watch，http://localhost:8001；首启 log 输出 admin 临时密码一次
```

> M2 起 `npm run dev` 会装配真编排（DockerRuntime 挂 docker.sock + BullMQ 连 REDIS_URL）。
> 本地需 docker daemon 与 Redis 可达才能 create/delete 容器；REST 认证/账号端点不依赖它们。

### schema 变更

Prisma 7 的 `db push` / `migrate dev` 带 AI 破坏性操作守卫（交互式 consent）。本仓库改用
**`migrate diff` 产出 SQL + better-sqlite3 直连落表**，规避守卫且更快：

```bash
# 1) 改 prisma/schema.prisma
# 2) 重生成建表 SQL：
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/init.sql
npm run prisma:generate
# 3) 落到 dev DB（清库重建）：
rm -f prisma/panel.db && npm run db:apply
```

测试库不经 CLI：`test/setup.ts` 用 better-sqlite3 直读 `prisma/init.sql` 建临时库，每文件独立。

## 测试 / 校验

```bash
npm run typecheck              # tsc --noEmit（含测试）
npm test                       # vitest run（49 文件 / ~497 用例，接缝 #1–#5）
npm run prisma:validate        # schema 合法性
```

接缝（spec Testing Decisions）：
- **#1 WikiFileSystem Port**：纯逻辑对 fake FS 直测（symlink / 非 regular / 不可读 / SKIP 集合 / 降级）。
- **#2 信封 REST 契约**：注入假身份（admin/user）打路由，断 HTTP 200 + 信封码 + 归属前置。
  防探测用例逐字节断言「不存在 vs 越权」同码（10041 / 20040）；凭证零落盘贯穿断言。
- **#3 WS 桥**：面板↔浏览器腿——upgrade/JWT/4401/subprotocol 回显 + 出站帧翻译。
- **#4 hostDeps / 配对**：注入假 GatewayClient，断多租户池壳 + A3 双层状态机 + 宿主 approve 编排。
- **#5 编排器 Port**：注入假 docker（FakeRuntime）+ 内存假队列（InlineLifecycleQueue），断
  5 态机 + 取消标志 + 端口入队前分配 + 补偿（bind 换端口重试 / REMOVING 可重试 / 端口耗尽 / 残留目录）。
- **集成 smoke**（`containers-smoke.test.ts` / `bullmqQueue.test.ts`）：真 docker daemon / 真 Redis
  **默认 skip 自动探测门控**（daemon/Redis 不可达 → skip），可达 → 真跑端到端。

## 关键约定

- **统一信封**：所有 REST HTTP 200；成功 `{code:0,data}`，失败 `{code,message,data}`。码表见 `src/codes.ts`。
- **refresh cookie**：`HttpOnly; Secure(prod); SameSite=Lax; Path=/api/v1/auth`；R1 旋转 + 重放族灭。
- **C1 强制改密**：服务端拦截（`mustChangePasswordGate`），放行 me/logout/password-change，余者 mustChange=true → `10005`。
- **防探测**：`/users` 非 admin、目标不存在 → 同码 `10041` 同体；容器「不存在 vs 越权」→ 同码 `20040` 同体，区分仅进服务端日志。
- **凭证零落盘**：响应体不含 passwordHash / refresh 明文 / 容器 token / private_key / device_token。
- **凭证加密（Codex C1）**：gateway token 落盘为 AES-256-GCM 密文（`CREDENTIAL_ENCRYPTION_KEYS`，
  逗号分隔 base64(32 字节)，首个 = active 加密、余者仅解密支持轮换）。**生产必填**（缺失启动
  fail-fast），生成示例 `openssl rand -base64 32`；dev/test 未设置时回退到固定密钥（勿用于生产）。
- **容器隔离（#312）**：user 仅自己容器、admin 跨用户全部；归属前置 `getInstanceForUser` 单点（admin 全放行 / user 仅本人）。
- **容器并发（#313）**：进程内 `NameLeaseMap` 互斥（不依赖 Redis）防双创建/双删除；create/delete 按 name 串行入队；端口入队前分配（SQLite 唯一约束仲裁、四来源已用集）；delete 异步 + 取消标志（provisioning 检查点检出统一回滚）；BullMQ(Redis) worker 并发默认 2 + stalled-job 崩溃重跑。
- **容器补偿**：ERROR 行保留 / bind 端口冲突就地换端口重试（预算=池大小）/ 清理失败标 REMOVING 可重试（20045）/ 端口池耗尽 90004。
- **config 目录方案（#366）**：openclaw.json 落 `instances/<id>/config/`（目录 ro bind + `OPENCLAW_CONFIG_PATH`
  指其内文件）——宿主 rename 换 inode 容器内可见（热加载保留）+ 容器内进程不可写（恢复只读边界）。
  **升级要求**：由「单文件 bind」时代（config 落 `instances/<id>/openclaw.json`、无 `OPENCLAW_CONFIG_PATH`）
  升上来的既有容器没有 `instances/<id>/config` 目录——provider 写盘落新路径不在容器 mount 内 → 热加载
  断链但 API 报成功。写盘已 fail-fast（缺目录 → 90003 + 提示重建，见 `models/configWriter.ts`）；
  **升级后须重建旧容器**（删除重建走新 mount）才能配置模型。
- **共享 key 所有权边界（#336 codex 四轮 P1，已知风险接受）**：`LLM_API_KEY` 值仅管理员部署级配置
  （env/启动配置注入），用户仅配置自己容器的 model provider 条目（含 `base_url`）引用之。**多租户不可信
  场景下**，恶意用户可把自家 provider 的 `base_url` 指向自己端点，诱使容器把共享 key 作为凭证发往该处
  → key 外泄、越配额/影响全体租户。这是 spec §5.2「全面板共享一个 key」决策的既定姿态（Django 前身同
  设计；与 docker.sock §5.4 同理，本地/可信部署可接受）。根治需 per-user 凭证或 admin 白名单 base_url，
  均超出 #336 范围，未实现——多租户部署前需另行决策。

## 生产部署（#341 M9）

生产镜像 `server/Dockerfile`（多阶段：build 全量 npm ci + prisma generate + tsc → runtime `npm ci
--omit=dev` + dist + prisma/scripts）。入口 `docker-entrypoint.sh`：先幂等落表（`scripts/apply-schema.mjs`
+ SQLite `user_version` 标记；init.sql 非幂等，重启跳过）再 `exec node dist/server.js`。

生产 compose：`deploy/docker-compose.deploy.yml` 三服务（frontend nginx → server:8001 → redis）。
**必填 env**（`NODE_ENV=production` 下 fail-fast）：`JWT_SECRET`（≥32 字符）· `PANEL_PUBLIC_ORIGIN`
（面板对外 origin）· `CREDENTIAL_ENCRYPTION_KEYS` · `OPENCLAW_TEMPLATE_DIR`（绝对存在可读）·
`DATABASE_URL`（显式绝对路径，如 `file:/app/db/db.sqlite3`）· `OPENCLAW_FLEET_ROOT`（compose pin
`/fleet` 并挂载宿主 fleet 根）。LLM_API_KEY create 时 90003 前置校验。`OPENCLAW_IMAGE` 有缺省值
（= 派生镜像钉版本 tag）故不在上列，但**生产禁浮动 tag**：无 tag 或 `:latest` 启动即 fail-fast
（#695，准据见 `server/src/config.ts` 的 `readFleetImage`）。部署全流程（CD、secrets、回滚、排障）
见 `deploy/DEPLOY.md`。

> 坑：`node:lts-slim`（Debian/glibc）——better-sqlite3 原生模块不兼容 alpine/musl；runtime 阶段
> 需 build-essential + python3（postinstall 编译工具链，Dockerfile 已含）。

## 下游衔接

- WIKI（#335）与 Models（#336）已交付：复用 `createApp`、`authenticate()`、信封中间件、
  `getInstanceForUser` 归属前置（containers/wiki/models/chat/pairing 全域单点）。
- 配对（#378/#385）：`Pairing` 表经 `onDelete: Cascade` 级联；list 的 pairing 预取；宿主 approve
  经 `runtime` docker exec 通道（`POST /containers/<name>/pairing/approve/<requestId>`）。
- 对话桥接（#337，ADR 0006）：`/ws/chat/` 隧道 JWT 握手 4401 + 归属门 + 原始帧透传；浏览器跑官方
  `@openclaw/gateway-client` 协议机；`PANEL_PUBLIC_ORIGIN` 强制进容器 allowedOrigins。
- 前端（#340/M5/M8）：信封解析 + `me.role` + R1 双 token 旋转 + 异步 delete 轮询 + ChatView 拆分
  （8 组件）+ admin users 页。
- 生产（#341）：`deploy/docker-compose.deploy.yml` + CD 构建 `server` 镜像；Django 后端已退役。
