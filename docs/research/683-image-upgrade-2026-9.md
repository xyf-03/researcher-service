# 镜像升级 2026.7.1 → 2026.9.x 影响面研究（#683）
> **来源**：wayfinder 研究票 [#683](https://github.com/ACautomata/researcher-service/issues/683) · 地图 [#682](https://github.com/ACautomata/researcher-service/issues/682) · 2026-09-12 · 基准 openclaw@2026.9.4（本机 npm 包 docs/dist + ghcr registry 实测）

> 研究方法：先读本仓库现状（精确到文件:行号），再对照本地 2026.9.4 npm 包（`/opt/homebrew/lib/node_modules/openclaw/`，`docs/gateway/protocol/` 权威文档 + `dist/` 实测 schema）与 ghcr registry 实测。无法静态验证的项标「待人工验证」。

## TL;DR

- **`2026.9.4-browser` 存在**（ghcr 实测），协议仍为 **v4**，握手 shape 与 7.1 一致，SDK 可不升级（但建议同步到 2026.9.4）。
- 面板现用 RPC（`chat.send`/`chat.history`/`sessions.list`/`sessions.create`/`sessions.delete`/`commands.list`/`exec.approval.*`）在 9.4 schema 中**全部健在**，我们发送的参数子集完全合法；变化均为**增量**（新增字段/新 RPC），唯一行为级变化是 `chat.history` 的 display-normalization。
- **派生镜像叠加层可原样通过**：9.4-browser 仍是 `node:24-bookworm-slim` 基座、`USER node`、`/home/node/.openclaw` 预建（node:node 700）。
- **最大风险在存量 fleet 迁移**：7.1→9.4 跨「session SQLite 迁移」（单向），且 legacy 会话导入**必须显式跑 `openclaw doctor --fix`**——9.4 gateway 发现 legacy session store 会**拒绝 ready**；而面板的「删容器即删卷」（每代系独立卷）使「删除重建」丢数据，面板今天**没有原地升级路径**。
- 凭证（deviceToken / GATEWAY_TOKEN / AES 密文）预期全部存续，deviceToken 复用需冒烟；即使失效也有 #377 自动配对自愈兜底。

---

## Q1 可用版本：ghcr 9.x browser tag 清单

**事实**（ghcr.io registry API 实测，2026-09-12，分页拉全 1840 个 tag）：

- 9.x 稳定线共 4 个版本，**全部有 `-browser` 变体**（含 amd64/arm64 子架构 tag）：
  `2026.9.1-browser` / `2026.9.2-browser` / `2026.9.3-browser` / **`2026.9.4-browser`**
- 浮动 tag：`latest-browser` 实测指向 **2026.9.4**（manifest config `OPENCLAW_DOCKER_BUILD_VERSION=2026.9.4`）；另有 `extended-stable-browser`（滚动稳定线，具体指向未验证）。
- 9.x 变体族：`<ver>`（默认）/ `-browser` / `-slim` 三档，与 7.x 相同。
- 参照：当前基线 `2026.7.1-browser` 在列；7.x 还有 `2026.7.1-1`/`2026.7.1-2` patch tag。

**建议**：钉 `2026.9.4-browser`（精确版本），勿用 `latest-browser` 浮动 tag（CD 构建可复现性）。

**结论：最新稳定 = 2026.9.4，有 browser 变体。无「待人工验证」项。**

## Q2 SDK 兼容性：`@openclaw/gateway-client@2026.7.2-beta.6` vs 9.x 网关

**事实 1 — 协议版本未变**：9.4 `docs/gateway/protocol/versioning.md:42-44`：`PROTOCOL_VERSION=4`、`MIN_CLIENT_PROTOCOL_VERSION=4`——与 7.x SDK 常量完全一致（我们 `docs/research/openclaw-gateway-client.md:30-37` 记载 7.x 同值）。**无 protocol bump。**

**事实 2 — 握手 shape 一致**：9.4 `docs/gateway/protocol/handshake.md:32-92` 的 `connect` 帧（minProtocol/maxProtocol + client{id,version,platform,mode} + role/scopes/caps + auth + device 签名块）与 `hello-ok`（server/features/snapshot/auth/policy）和 7.x 逐字段同形。deviceToken 仍在 `hello-ok.auth.deviceToken` 下发（handshake.md:97-98, 163-173）。`connect.challenge`（nonce+ts）不变（handshake.md:16-30）。

**事实 3 — 我们的 client 身份仍被 9.4 接受**：面板伪装 `client.id='openclaw-control-ui', mode='webchat'`（`frontend/src/chat/gatewayChat.ts:192`）；9.4 `dist/client-info-5hij-UZJ.mjs` 实测 `GATEWAY_CLIENT_IDS.CONTROL_UI='openclaw-control-ui'` 且 `BROWSER_DEVICE_CLIENT_IDS = new Set(['openclaw-control-ui','webchat-ui'])`——**浏览器设备配对路径完整保留**。

**事实 4 — SDK 用法是纯透传，兼容风险低**：前端经 `@openclaw/gateway-client/browser` 的 `GatewayProtocolClient`（`frontend/src/chat/tunnelSocket.ts`）+ `client.request(method, params)` 通用 JSON-RPC 封装（全部 RPC 调用点见 `frontend/src/chat/gatewayChat.ts:643-770`）+ `onEvent` 原始事件回调。**高层语义不封装在 SDK 里**（`docs/research/openclaw-gateway-client.md:65` 结论「高层语义走通用 request + onEvent」），所以「SDK 认不认识某个 method/字段」不构成约束——SDK 只负责握手/重连/帧状态机，这部分协议 v4 未变。server 侧隧道是**零解析透传**（`server/src/chat/tunnel.ts:1-13` 注释 + 实现：仅 `extractChatSend` 做 trace 日志观测），server 升级风险≈0。

**事实 5 — npm 已发正式版**：registry 实测 `@openclaw/gateway-client` 现有 `2026.7.2-beta.7`、`2026.8.1`、`2026.8.2`、`2026.9.1`~`2026.9.4`，**`dist-tags.latest = 2026.9.4`**（不再是占位 `0.0.0`——7.x 时代须锁 beta 的状况已结束，见 `docs/research/openclaw-gateway-client.md:18-19`）。

**判断**：

- **SDK 不必须升级**（协议 v4 + 握手同形 + 纯透传用法）。升级动机是①版本字符串对齐（`CLIENT_INFO.version` 硬编码 `'2026.7.2-beta.6'`，`gatewayChat.ts:193` 注释「升级官方包时须同步 bump」；7.1 实测网关不校验该字段仅记录，9.4 无证据变为强校验——待人工验证）；②9.x SDK 可能内置 session 投影/重连策略修复。
- 若升级：前后端同步 bump `2026.7.2-beta.6 → 2026.9.4`（`frontend/package.json:23`、`server/package.json:35`）+ `CLIENT_INFO.version`。

## Q3 现有 RPC 回归面（7.x 研究记载 vs 9.4 文档/dist 逐项）

面板实际调用面（`frontend/src/chat/gatewayChat.ts` 实测枚举）：`sessions.list`(:643)、`sessions.create`(:666)、`sessions.delete`(:681)、`chat.history`(:685)、`chat.send`(:716)、`commands.list`(:725)、`{exec,plugin}.approval.resolve`(:747)、`exec.approval.list`(:756)；事件消费 `chat`/`agent`(tool-events)/`exec.approval.requested|resolved`/`sessions.changed`。

| RPC | 9.4 状态 | 我们发送的参数 | 差异评估 |
|---|---|---|---|
| `chat.send` | 健在（`docs/gateway/protocol/rpc-session-control.md:39`；dist `ChatSendParamsSchema` 实测） | `{sessionKey, message, idempotencyKey, attachments?}` | **参数子集完全合法**。schema 为 7.1 超集：新增 `queueMode`/`expectedLeafEntryId`（string\|null，CAS 分支切换防竞争）/`expectedPermissionMode` 等。ack `{runId, status:"started"}` 不变；新增可选 `messageSeq`/`runStarted`（admission 与 transcript 持久化解耦，rpc-session-control.md:41）——**增量**。`sessions.steer` 已废弃为 `chat.send` 别名 |
| `chat.history` | 健在（rpc-session-control.md:35-36；dist `ChatHistoryParamsSchema` 实测） | `{sessionKey, limit?, offset?(number 光标), messageId?(string 光标)}`（#678 cursor 类型分发） | schema 实测保留 `offset`/`messageId`/`limit` ✓。**行为变化**：结果 display-normalized（剥 inline 指令 tag、剥 tool-call XML、剔纯 NO_REPLY 行、超长行占位符）；新增 `deltaCursor` 追帧机制（增量，不用则无感） |
| `chat.abort` | 健在（rpc-session-control.md:35；dist `ChatAbortParamsSchema`：`{sessionKey*, agentId?, runId?, preserveSideRuns?}`） | 面板无主动 abort UI（grep 全仓无调用；仅网关侧 stuck-session recovery） | 无回归面。`sessions.abort` 新增 `clearQueued`（默认保旧语义） |
| `sessions.list` | 健在（rpc-session-control.md:16） | `{includeDerivedTitles: true}`——9.4 dist 实测 `includeDerivedTitles: Type.Optional(Type.Boolean())` 存在 ✓ | 读的字段 `key/sessionKey/derivedTitle/updatedAt` 保留；行投影大量增量（`hasActiveRun`/`activeRunIds`/placement/owner/participants）。**增量** |
| `sessions.create` | 健在（rpc-session-control.md:23） | `{key, label?}` | 仍全可选；新增 `contextWindow`/`thinkingLevel`（7.x r13 文档的「待实测」项**已落地为正式字段**）/`category`/`worktree`/`displayName`/`titleSource`。初始 `chat.send` 被拒时返 `runStarted:false + runError`（新增语义，我们未消费）——**增量** |
| `sessions.delete` | 健在（dist `sessions-delete-u2YrjrAR.mjs` handler 实测） | `{key}`（不带 `archivedOnly`，需 `operator.admin`——`gatewayChat.ts:163-180`） | **守卫语义变化**：9.4 实测 guard 为「main session 不可删」「model-selection locked 不可删」「archivedOnly 语义不变」「session-changed fencing（`expectedSessionId`/`expectedLifecycleRevision` 可选）」；7.1 的「webchat clients cannot delete sessions」文案在 9.4 dist 中未觅得（可能随 control-ui 豁免重构）——我们本来就是 control-ui 身份，两侧均安全。**待人工验证**：删除自定义 key 会话冒烟 |
| `commands.list` | 健在（rpc-devices-nodes-and-approvals.md:84「Skills and tools: `commands.list`, skills.*, tools.catalog…」） | `{}` | 无变化迹象 |
| `exec.approval.list` / `.request` / `.resolve` | 健在（rpc-devices-nodes-and-approvals.md:67-68「protocol-boundary adapters over the same durable approval registry」） | list `{}`；resolve `{id, decision}`（kind 在 method 名） | 响应形状：我们 0 信任解析 `items[]\|approvals[]`（`gatewayChat.ts:749-770`），容差足够。新增：`approval.history/get/resolve`（kind 无关持久审批）、`exec.approval.waitDecision`、`exec.approvals.get/set`——**增量**。事件 `exec.approval.requested/resolved` 仍在事件族清单（rpc-bootstrap-and-events.md:109） |
| 设备配对 bootstrap | 不变（handshake.md 全节；`device.pair.*` RPC 族 rpc-devices-nodes-and-approvals.md:14-22） | challenge → connect(device 签名块 + auth.token) → hello-ok.auth.deviceToken | `connect-error-details`（`PAIRING_REQUIRED` 嵌套码）仍在协议包。**server 侧 `openclaw devices approve <requestId>` CLI 在 9.4 文档健在**（`docs/cli/devices.md:40-49`）——`server/src/routes/containers.ts:157` 的宿主 approve 编排不受影响。注意 9.4 移除的是 **node** pairing 的 `node.pair.request/verify`（2026.7 起，rpc-devices-nodes-and-approvals.md:46），与我们 device 配对无关 |

**事件面**：`chat` 事件 delta/final/aborted/error 四态 + `deltaText`/`message` 累积快照/`replace=true` 整段替换语义在 9.4 文档**逐字保留**（rpc-bootstrap-and-events.md:49-53，与 `docs/research/r13-ws-protocol.md:104-118`、`openclaw-gateway-client.md:110-118` 记载一致）；`errorDetail` 结构化失败详情为**增量字段**（rpc-bootstrap-and-events.md:53-63）。`tool-events` cap 仍存在（handshake.md:252）。

**配对/scope 一致性**：我们请求 `operator.read/write/approvals/admin`（`gatewayChat.ts:177`）——四个 scope 名在 9.4 完整 scope 集（handshake.md:314-321）中全部健在 ✓。

**新增能力（本次升级的目标，均需 9.4 网关）**：`sessions.rewind`（`operator.admin`）、`sessions.fork`（`operator.write`）、`sessions.branches.list`（`operator.read`）/`sessions.branches.switch`（`operator.admin`）——dist 实测四个 method 名存在；行为描述见 `docs/web/control-ui/chat.md:97`。我们的 `OPERATOR_SCOPES` 已含 admin/write/read，**无需改 scope 即可调用**。注意：混合舰队（部分容器仍 7.1）时前端不得盲发新 RPC——可经 `hello-ok.features.methods` 探测（rpc-methods.md:16-22）。

## Q4 派生镜像叠加层在 9.x 基线上的通过性

**事实**（2026.9.4-browser amd64 manifest config 实测，ghcr blob 直读）：

- 基座：`node:24-bookworm-slim`（digest 钉定，LABEL `org.opencontainers.image.base.name`）——**仍是 bookworm**，我们 `apt-get install poppler-utils` 的源可用。
- `User: node`、`WorkingDir: /app`、Entrypoint `tini -s --`、Cmd `node openclaw.mjs gateway`。
- 构建历史实测（layer history）：`install -d -m 0700 -o node -g node /home/node/.openclaw /home/node/.openclaw/workspace /home/node/.config/openclaw` + `stat` 断言——**`/home/node/.openclaw` 路径与属主不变**。
- Node 24.19.0（运行时大版本跨级，对我们无感：容器内只跑 openclaw 自身）。
- 9.4 官方 Dockerfile 暴露 `OPENCLAW_IMAGE_APT_PACKAGES`/`OPENCLAW_IMAGE_PIP_PACKAGES` build-args（history 实测）——**可选优化**：pdftotext 可改走官方 arg，不必自维护 root apt 层（非必须）。

**逐条对照我们的叠加层**（`deploy/openclaw-image/Dockerfile`）：

| 叠加 | 9.4 基线上 | 依据 |
|---|---|---|
| `FROM …:2026.7.1-browser` → 改 `2026.9.4-browser` | ✓ 单行改动 | Q1 |
| `USER root` + apt poppler-utils + `command -v`/`pdftotext -v` 断言 | ✓ bookworm 源在、安装路径不变 | 基座 bookworm |
| `COPY skeleton/.openclaw/ /home/node/.openclaw/` + `chown -R node:node` | ✓ 目标目录预建且属主 node:node；COPY 后 chown 语义不变 | history `install -d -o node -g node` |
| 12 个 `test -f` 骨架断言 | ✓ 只依赖我们 COPY 的文件（与 `server/test/openclawImage.test.ts` SKELETON_FILES 对齐），与基线无关 | Dockerfile:40-52 |
| `USER node` 收尾 | ✓ | config `User: node` |

**运行时注意**：我们容器创建用 `User: '0:0'`（root，`server/src/containers/dockerRuntime.ts:96`）+ CapAdd——镜像层 `USER node` 实际被覆盖，与 7.1 行为一致，无变化。不覆盖 Entrypoint/Cmd（buildRunOptions 无该字段），9.4 默认 Cmd 仍是起 gateway ✓。

**结论：Dockerfile 原样换 FROM 行即可通过构建断言；`/home/node/.openclaw` 假设成立。** 唯一建议冒烟：构建后起一容器实测 `pdftotext` 与骨架初始化。

## Q5 存量 fleet 迁移（最重的一节）

**事实 1 — 镜像升级不触达存量容器**：容器创建时钉定镜像（`Image: spec.image`，`dockerRuntime.ts:92`；`ensureImage` 仅本地缺失时 pull，`dockerRuntime.ts:143-145`）。CD 推新 `:latest` 后（`.github/workflows/cd.yml:132-137`），**只有新创建的容器**用新镜像；存量容器 restart 不换镜像。「滚动重建」面板今天做不到——见事实 4。

**事实 2 — 7.1→9.4 跨单向 schema 迁移**：9.4 `docs/reference/database-schemas/integrity-and-recovery.md:67`：**「Every release through v2026.7.1 used agent schema 1 and state schema 1. The 2026.7.2 release train (starting with v2026.7.2-beta.1) migrates your databases forward on first start. That migration is one-way…installing an older OpenClaw afterwards does not undo it.」** 即我们的 2026.7.1 恰好是旧格式的最后版本；9.4 = agent schema 9 + state schema ≥6（`agent-schema-history.md:13-19`，schema 4 = 「Sessions and transcripts moved into SQLite」，首发 v2026.7.2-beta.1）。**降级不可逆。**

**事实 3 — legacy 会话导入必须显式 doctor，gateway 首启会拒绝 ready**：9.4 `docs/gateway/doctor/state-and-sessions.md:18,23`：「Session rows and transcripts: import legacy `sessions.json` and JSONL history from `~/.openclaw/sessions/` … into `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`」；「**Legacy session-file import and repair belong to explicit Doctor runs.** Gateway and local CLI startup use SQLite; they do not import…**When startup finds a legacy session store, it refuses readiness** and prints the Doctor command…Stop the Gateway, back up its state, and run `openclaw doctor --fix` before restarting it」。**这是升级存量容器的硬性步骤**：不跑 doctor，9.4 网关不 ready，面板表现为容器 running 但 chat 永远连不上。

**事实 4 — 面板删除 = 连卷删，且卷按代系唯一**：`namedVolumesFor(instanceId)` 按代系 id 派生三卷（`server/src/containers/runtime.ts:22-30`，注释「删容器连卷删、同名 recreate 用新卷组，防代系串读」）；删除路径 `dockerRuntime.remove` 对容器 `remove({v:true})` + 三卷逐一 `volume rm`（`dockerRuntime.ts:238-253`）。**推论：面板「删除同名重建」= 数据全丢，不能当升级手段；反之，卷不随 restart/stop 消失，手工绕过面板重建容器（复用旧卷名）可保数据。**

**事实 5 — openclaw.json schema 无新增必填项的证据**：token auth 模式 9.4 不变（handshake/auth 文档）；我们模板的关键键在 9.4 dist 仍存在（`contextEngine` ✓、`qmd` ✓ dist grep 实测）。9.4 新增 `OPENCLAW_CONFIG_READONLY=1` env（CHANGELOG「Externally managed configuration」）——默认关，与我们 putArchive 写 config 的模型兼容。**待人工验证**：起一个 9.4 容器挂现模板，观察启动日志有无 config 警告/拒启（`meta.lastTouchedVersion: 2026.4.21` 较老，gateway 可能重写 bump）。

**存量 fleet 三条路径**（产品决策输入）：

1. **共存（零风险，推荐先做）**：升级派生镜像后，存量容器继续跑 7.1 至自然消亡；新建容器直接 9.4。镜像按 create 钉定，混跑无冲突。前端不要对 7.1 容器发 9.4-only RPC（或按 `hello-ok.features.methods` 探测）。
2. **手工原地升级（可控，运维操作）**：对每容器——`docker stop` → 以**同名**重建容器但**复用旧三卷** + 原 env/config（绕过面板，面板 DB 行需同步 image 字段或接受 list 显示漂移）→ `docker exec … openclaw doctor --fix`（导入 legacy 会话）→ 启动。升级前备份 home 卷（schema 单向）。
3. **面板内建「升级」能力（长期解）**：stop → 以同代系卷组 recreate（需给 orchestrator 加「保留卷的 recreate」语义，与现有防串读设计的相悖处需显式开关）→ exec doctor --fix → start。工程量不小，建议单独立票。

## Q6 凭证存续

| 凭证 | 存储位置 | 升级后判断 | 证据 |
|---|---|---|---|
| 配对 deviceToken | 前端 localStorage tokenStore + server Prisma `Pairing` 行；网关侧配对注册表在 `~/.openclaw`（home 卷，跨重建持久） | **预期有效**。9.4 对 legacy 签名设备身份有**启动时自动导入**：`state-and-sessions.md:21`「Signed device identity: from `~/.openclaw/identity/device.json` into … `device_identities` … **Gateway startup also performs this verified import** for valid legacy identities」 | 待人工验证：升级后已有 deviceToken 直连冒烟。**兜底**：若失效 → `PAIRING_REQUIRED` → #377 前端自动配对（`gatewayChat.ts:267` 起）+ 宿主 approve 自动重配，无需用户干预 |
| GATEWAY_TOKEN | env 注入容器（`dockerRuntime.ts:77-79`，`GATEWAY_TOKEN`+`OPENCLAW_GATEWAY_TOKEN` 双写）+ 面板 DB 密文存值；`openclaw.json` 渲染 `${GATEWAY_TOKEN}` 占位（`deploy/openclaw.json:24-27`） | **有效**。token auth 模式 9.4 不变；重建容器由面板用 DB 存值重新注入，值不变 | `server/src/config.ts:316-319` |
| 每容器 AES 密文 | 面板侧（`CREDENTIAL_ENCRYPTION_KEYS`，server DB） | **不受影响**——纯控制面资产，与容器镜像零耦合 | `server/src/config.ts:334-335` |
| LLM_API_KEY | env 注入，不落盘 | 不受影响 | `dockerRuntime.ts:80` |

## 升级步骤草案

1. **改 FROM**：`deploy/openclaw-image/Dockerfile:14` → `FROM ghcr.io/openclaw/openclaw:2026.9.4-browser`（钉精确版本）。
2. **本地构建 + 单容器冒烟**：`docker build deploy/openclaw-image` → 起 test 容器验证：构建断言过、`pdftotext -v`、12 骨架文件落卷、gateway ready、面板配对 + `chat.send`/`chat.history` 分页/审批卡/`sessions.delete`。
3. **配置冒烟**（可并入 2）：挂现网 `deploy/openclaw.json` 模板起 9.4 容器，看启动日志 config 警告（Q5 事实 5）。
4. **CD 发布**：合入后 CD 构建推 `:latest` + 版本 tag（`cd.yml:132-137`）；部署环境 `docker pull` 新 `:latest`（`cd.yml:232`）。
5. **存量 fleet 决策**：默认共存（Q5 路径 1）；需保数据的容器走手工原地升级（Q5 路径 2，**含 `openclaw doctor --fix` + 升级前备份 home 卷**）。
6. **（跟进票）SDK 升级**：`@openclaw/gateway-client` 2026.7.2-beta.6 → 2026.9.4（前后端 + `CLIENT_INFO.version`，Q2）；随后立 `sessions.rewind/fork/branches` 面板功能票（scope 已满足，注意混合舰队按 `hello-ok.features.methods` 探测）。

## 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 9.4 首启遇 legacy session store **拒绝 ready**，容器假活（running 但不可用） | **高**（存量容器必踩） | 升级存量容器必须 `openclaw doctor --fix`（Q5 事实 3）；新容器（空卷）无此问题 |
| R2 | 面板无原地升级路径；删除重建丢全部会话/wiki 数据（代系卷设计） | **高**（若误用删除重建当升级） | 共存策略起步；原地升级走 Q5 路径 2/3；升级前备份 home 卷 |
| R3 | schema 迁移**单向**，升级后无法回退旧镜像（`newer schema version` 拒启） | 中 | 升级前 WAL-aware 备份 home 卷（9.4 updating.md 要求）；共存期可随时回退未迁移容器 |
| R4 | `chat.history` display-normalization 改变历史渲染细节（tool XML 剥除、NO_REPLY 行消失、超长行占位） | 低 | 方向上与我们前端渲染假设一致（我们本就按 display-normalized 消费，`gatewayChat.ts:701` 注释）；冒烟核对分页 |
| R5 | deviceToken 升级后失效（待人工验证） | 低 | #377 自动配对全自愈兜底 |
| R6 | `sessions.delete` webchat 守卫语义在 9.4 重构（7.1 文案未觅得） | 低 | 我们是 control-ui 身份；冒烟删除自定义会话 |
| R7 | 混合舰队下新 RPC 打到 7.1 容器报错 | 低 | 前端按 `hello-ok.features.methods` 特性探测后再发 `sessions.rewind/fork/branches` |
| R8 | openclaw.json 模板在 9.4 的校验/重写行为 | 低 | 冒烟观察（Q5 事实 5）；`OPENCLAW_CONFIG_READONLY=1` 可作「面板独家管配置」的加固选项 |
| R9 | `CLIENT_INFO.version` 字符串未 bump，9.4 若开始强校验版本则连接被拒（`CLIENT_VERSION_MISMATCH` 码存在于协议） | 低 | 7.1 实测仅记录不校验；SDK 升级票一并 bump |

## 无法静态验证、留待冒烟的项（汇总）

- `latest-browser`/`extended-stable-browser` 的持续指向（建议直接钉 2026.9.4 规避）
- 9.4 是否强校验 `client.version`（R9）
- 存量 deviceToken 跨升级直连成功率（R5）
- 现 openclaw.json 模板在 9.4 的启动警告面（R8）
- `sessions.delete` 对自定义 key 会话的实际行为（R6）

