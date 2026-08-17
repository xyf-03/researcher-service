# OpenClaw Fleet 面板

多 OpenClaw 容器管理面板。TS/Express 控制面（server/，替代已退役的 Django 后端，#341 M9）经四条接触路径与每个 OpenClaw 容器交互；Vue3 前端经 REST + WS 消费控制面。本 glossary 只收录**本项目特有**的领域术语，通用编程概念（Port / Adapter / Translator / Protocol 等设计模式词汇）不在此列。

## Language

**OpenClaw 容器 (OpenClaw container)**:
面板编排的单位。每个容器内跑一个 `main` agent、一个 gateway（WS，容器内 18789）、以及独立的 home / wiki / openclaw.json。它是本系统唯一的外部 bounded context。
_Avoid_: 实例——"实例"指面板侧的 `Instance` 数据模型，是 OpenClaw 容器在控制面的投影，二者不等同。

**面板 bounded context (panel bounded context)**:
面板内部的六个 bounded context（2026-08-13 划分，wayfinder #637）：containers（核心）/ 身份与访问 / wiki / models（支撑）/ files / traceLogs 审计（通用）。跨 context 契约：**行为协作一律经领域消息**（异步）；无 IO 纯函数/常量/渲染机制下沉**共享内核**；容器归属门 `getInstanceForUser` 是共享中间件**唯一单点**（tenant 引入时只替换此门）。隧道、前端 chat 协议机、health 探针**不是 context**（基础设施 / 接触路径 (4) 客户端侧 ACL）。
_Avoid_: 跨 context 直接 import 域服务（渲染、状态查询）——行为协作走领域消息；在 context 内复制共享内核纯知识（容器命名规则 `containerName`、配置安全不变量）——必须单一实现。

**镜像谱系 (image lineage)**:
承载 OpenClaw 容器的镜像决定容器的能力边界与挂载契约。有两个互不兼容的**现成**变体，另可自建第三条：
- **cn-im fork**（`acautomata/openclaw-docker-cn-im`）：历史部署镜像，启动时自带配置同步与权限降权（init 脚本），预装中国 IM 渠道插件，**不含 browser 运行时**（researcher 配置的 browser 插件在此镜像上无效）。
- **官方原版**（`ghcr.io/openclaw/openclaw`，分 `-browser`/`-slim` 变体）：OpenClaw 官方镜像，不自带配置同步逻辑；`-browser` 变体预装 Playwright，browser 能力可用（ADR 0003 选定 `2026.7.1-browser` 为部署基线）。
- **自建派生 (derived image)**：`FROM ghcr.io/openclaw/openclaw:2026.7.1-browser`（保 browser 能力，ADR 0003 基线）之上叠加本面板专属内容：`pdftotext`（poppler，PDF 文本提取 CLI，供 agent `tools.exec` 调用）+ wiki/workspace 骨架（COPY 进 `~/.openclaw`，供 named volume 首挂自动初始化，见「named volume 拓扑」）。经 `OPENCLAW_IMAGE` 注入。派生镜像**不新开谱系**，只在其基镜像谱系（官方）上加层；基镜像的 browser 能力、token 占位、SecretRef 等已校准性质原样继承。
_Avoid_: 「OpenClaw 镜像」——掩盖谱系在 browser 能力、挂载契约依赖、启动方式上的本质差异；讨论迁移/换镜像/重新打包时必须指明谱系（含派生镜像的**基镜像**谱系）。

**接触路径 (contact path)**:
控制面与 OpenClaw 容器交互的四条通道：(1) Docker SDK 编排（增删查容器）、(2) 宿主文件 bind-mount 直读写（wiki / openclaw.json）、(3) HTTP `/health` 探测、(4) WebSocket（协议 v4 + 设备配对 + 事件流，见「隧道」）。
_Avoid_: 集成点——过于笼统，无法区分这四条性质不同的通道。

**防腐层 (Anti-Corruption Layer, ACL)**:
`server/src/chat/` 与 `wiki/` 的 Port + Adapter + Translator 结构（Django 时代为 `backend/integration/openclaw/` 包，已随后端退役）。用 Port + Adapter + Translator 隔离 OpenClaw 的 wire 模型，防止其原生概念污染控制面 domain。**明确不追求 vendor-neutral**——保留 OpenClaw 原生命名作为事实，只在语义不一致处翻译。
_Avoid_: 网关层、适配器层（单数）——本系统是多个 Port 的集合，不是单一门面；单一门面因 chat 的双向流式回调不可行。

**wire 概念 (wire concept)**:
OpenClaw WS 协议 v4 的原生命名——事件族（`exec.approval.requested` / `plugin.approval.requested` / `agent.tool.start` / `agent.tool.result` / `chat` 的 `state`）、字段名（`deltaText` / `errorMessage` / `systemRunPlan.rawCommand`）、标识符（`runId` / `sessionKey` / `deviceToken` / `deviceId` / `operator.*` scopes）。
处置分两类：
- **标识符**：纯 id，domain 无二义 → 保留原样、集中管理、不翻译。
- **语义类**：命名或结构与 domain 不一致 → 经 Translator 翻译（如 `exec.approval.requested` → `approval`，`deltaText` → `delta`）。
_Avoid_: 协议字段——笼统，掩盖了"标识符 vs 语义类"这一关键区分。

**OpenClawWire**:
接触路径 (4) 的 Port（ADR 0004，**已于 #231 收敛落地**）：**配对后长连接**（chat.send + 事件流按 runId 路由 + 连接级审批 fan-out + 只读/会话 RPC）。配对本身不在本 Port：由 `PairingHandshake` / `PairingService`（独立 seam）完成 challenge→connect→approve→持久化 deviceToken 后，pool 构造本 Port 的实现并发起无参 `connect()`。ADR 0004 据此修订了 0002 的"配对+长连合并"原意——两套 `connect` 帧的重复已由 `ConnectFrameBuilder` 偿清（与一 Port/两 Port 无关），而配对的有状态多步流程与长连事件流 shape 本质不同，故分立。**（历史注：#341 M9 后此实现随 Django 退役；协议机由官方 `@openclaw/gateway-client` 接管、走浏览器直连隧道（ADR 0006），本条目保留为决策历史。）**
_Avoid_: ChatClient——历史实现名（收敛后 `chat.chat_client.OpenClawChatClient` 是 `OpenClawWireClient` 的同对象 alias，strangler 过渡保留，alias 清理列 deferred；见 ADR 0004）。

**OpenClawWireClient 内部协作者 (wire-client collaborators)**:
**（历史注：随 #341 M9 Django 退役，下述 Python 协作者结构不再存在于代码库；协议机职责由官方包 + 浏览器端 `eventTranslate.ts` 纯函数翻译承担，保留本条目为词汇历史。）**
`OpenClawWireClient` 拆分后落 `integration/openclaw/wire/` 子包（包名 `wire` 无下划线，符合「包名禁下划线」约定，呼应 `OpenClawWire` Port；2026-08 自 1120 行单类拆分，issue #271）；`wire_client.py` 退为薄壳做 identity re-export（`OpenClawWireClient`/`OnEvent`/`HISTORY_RUN_ID`/`_ConnectFrameBuilder`/`_AGENT_ID` 原 import 路径不变）。拆分**不动** Port 形态与配对边界（ADR 0004），`OpenClawWireClient` 退为**门面**——保留全部 Port 方法签名与恢复面方法（`record_active_session`/`resume_active_session`/`unregister_active_session`/`recovery_sessions`），内部委托协作者；跨桶接缝由门面编排、协作者回返值对象（`AckOutcome`/`RouteDecision`），单向依赖 门面→协作者：
- **ConnectionCore** — ws 连接生命周期（connect 握手/challenge/看门狗/dead 判定/aclose）。
- **RequestRouter** — 请求-回执路由（`_pending_acks`/`_pending_resolves`/`_rpc`/session 与 commands RPC/`resolve_approval`）。
- **RunEventRouter** — runId 事件路由 + 翻译 + 终态清理（`_routes`/`_translator`）。
- **RecoveryCoordinator** — 断线重连恢复协调（session 记忆 `_active_session_keys`/`_session_callbacks`、恢复路由 `_recovery_routes`、双缓冲回放 `_connect_buffered`/`_recovery_buffered`）。由原 `_RecoveryCoordinator` 正名（去下划线）。
- **ApprovalFanout** — 连接级审批订阅 fan-out（`_approval_subscribers`）。
_Avoid_: `_RecoveryCoordinator`（下划线私有类名，拆分后已正名）；helper/manager——非泛工具容器，每个协作者是一个领域职责。

**配置边界 (config boundary)**:
环境变量读取的唯一位置是 `server/src/config.ts`。runtime 域（`auth` / `containers` / `chat` / `wiki` / `models` / `users`）不直接读 `process.env`，一律经 `config` 导出取配置——config.ts 即面板配置的唯一声明处与单一来源。敏感值（secret）只经环境注入（compose/K8s `environment`，dev 可用 gitignored `.env`），**不经 CLI argv 传参**（argv 泄露 `ps` / shell history）。
_Avoid_: 在模块里散读 env、新建独立「env 注册包」——前者绕过声明、后者是多余层。

**配置边界豁免 (config boundary exemptions)**:
测试 harness / fixture（如 `test/` 里测 config 解析的用例）读 env 不属于 runtime。边界是架构约定（code review 维护），非零容忍 grep。

**必填 secret 的 fail-fast (required-secret fail-fast)**:
生产（`NODE_ENV=production` 下 `server/src/config.ts` 的 read* 校验）对必填 secret 缺失即拒启动（`JWT_SECRET` ≥32 字符硬校验、`OPENCLAW_TEMPLATE_DIR` / `PANEL_PUBLIC_ORIGIN` / `CREDENTIAL_ENCRYPTION_KEYS` 缺失 fail-fast），杜绝「生产漏设 → 静默空值」的错配（`LLM_API_KEY` 旧为 `os.environ.get(...,'')`，漏设会把空 key 静默注入容器，与 issue #195「卡 creating」同类）。**dev / test 宽容不加 fail-fast**。

**隧道 (tunnel)**:
ADR 0006 引入的接触路径 (4) 新形态：浏览器↔控制面的一条 WebSocket，握手做 JWT 验签 + 归属门（user 只能开到**自己容器**的隧道），建立后**原样透传**浏览器与容器网关之间的 OpenClaw 协议 v4 原始帧——控制面**不解析、不翻译、不注入凭证、不做 method 级授权**。隧道是 B-直连的承载：浏览器跑官方 `@openclaw/gateway-client` 的 `./browser` 协议机，把「隧道 socket」注入其 `createSocket` 当 transport，经隧道直连藏在控制面后面的容器网关。
_Avoid_: 转发 / 代理——笼统，掩盖了「纯透传原始帧（隧道）vs 懂协议的胖中介（旧 #331 G 节桥接）」这一本质区分；旧桥接做翻译/池壳/授权，隧道一概不做。

**浏览器设备 (browser device)**:
ADR 0006 的配对单位：每个浏览器 profile（Chrome / 隐身 / 另一台电脑）生成独立 Ed25519 设备身份（存 localStorage，同 profile 多 tab 共享），独立配对、独立 approve，并为其访问的**每个容器**各持一份 deviceToken（按 `(clientId, deviceId, role)` 存）。对齐官方 webchat-ui / control-ui 的「设备即浏览器 profile」模型。
_Avoid_: 设备——脱离了「每浏览器 profile 一设备」就没意义；旧模型是「面板后端单设备、每容器一份」，新模型是「每浏览器设备 × 每容器」。

**bootstrap token**:
容器网关的共享认证秘密（旧称 `GATEWAY_TOKEN`，容器创建时生成、env 注入容器、DB 加密存值）。ADR 0006 修订 spec §5.2 后，它**可经所有权门控 REST（`POST /containers/<name>/bootstrap-token`）下发给容器属主的浏览器**做首次连接认证（bootstrap auth 对首连是强制的，官方文档）。每个容器一个共享 bootstrap token，该容器所有属主浏览器首连共用。
_Avoid_: 真值不落盘/不外泄（旧 §5.2 字面）——已修订为「可下发属主浏览器，真值仍不落前端以外的盘、不经日志」。

**会话删除 (session delete)**:
从网关删除整个会话、历史不可恢复的面板操作。与「归档 (archive)」严格区分——归档是**未来功能**（保留数据、移出列表），未实现，届时再定义；当前所有删除一律是会话删除。UI 确认文案必须明示「不可恢复」，不得出现「先归档（可恢复）再删除」的误导表述。
_Avoid_: 删除会话/移除会话——与归档混为一谈；术语必须指明「删=不可恢复」。

**附件 (attachment)**:
`chat.send` 携带的多模态内容块（wire 字段 `attachments`：`{type, mimeType, fileName, content, width, height}`），经隧道**内联**发送。用户经浏览器采集（粘贴/拖拽/选择）上传，图片发送前**前端压缩**；content 是自由形状（0 信任），渲染端须按块类型分派。
_Avoid_: 文件/图片消息——掩盖「内联于 chat.send 帧、多类型块数组」的协议形态。

**审批卡 (approval card)**:
OpenClaw agent 执行 elevated 命令前的权限门。网关经**连接级**事件（`exec.approval.requested` / `plugin.approval.requested`，不挂 runId）下发 `{id, kind, command, sessionKey, agentId}`；用户批准/拒绝后经 `*.approval.resolved` 广播落定（first-answer-wins，网关权威 decision，可能与他端不同）。生命周期：`pending`（待处理）→ `resolving`（已点击等回执）→ `resolved`（终态）；断线复位 `resolving → pending` 可重试，网关侧失效 `→ expired`（终态不可回覆）。**终态不留痕**（[ADR 0014](./docs/adr/0014-resolved-approval-no-trace.md)，supersede #547 / [ADR 0009](./docs/adr/0009-chat-timeline-merge.md) 的留痕条目）：resolved/expired 卡从界面消失，不在对话转录中留存任何记录；未决卡（pending/resolving）留在 composer 上方待办区，落定即撤。subagent 发起的卡（agentId 即来源语义）唯一可见于 main 会话。
_Avoid_: 「审批消息」——审批卡是连接级权限事件，不挂 runId、不进 messages 转录、独立追踪；「操作记录 / 留痕」（resolved 卡留在时间线作审计回看）语义已随 ADR 0014 退役。

**文件查询通道 (file query channel)**:
控制面读取 OpenClaw 容器内 wiki / workspace 文件的机制。**经 Docker 自带原语，不经 gateway 插件 API**：列目录与读文件用 dockerode `getArchive`（以容器为视角打 tar 流拉出，穿过 named volume 挂载点读卷数据），写文件用 `putArchive`，删文件用容器内 `exec rm`。以**容器存在（running/stopped）为前提**——容器删除时其数据卷一并删除，故「卷还在但容器没了」的情形不出现。不引入第三方 gateway 插件（曾评估 `openclaw-better-gateway`：捆绑 IDE/终端/写删、CORS 全开、自实现 token 校验与本项目 `${GATEWAY_TOKEN}` 占位不兼容，为一个只读查询暴露面过大，否决）。
_Avoid_: 走 gateway 插件/RPC 读文件——OpenClaw 官方无文件 RPC，第三方插件暴露面与认证均不可接受。

**named volume 拓扑 (named-volume topology)**:
OpenClaw 容器持久化**全用 Docker named volume，宿主零数据 bind-mount**（整洁动机：数据不散落宿主 instances 树、卷可定位）。每容器（按代系 id）：`openclaw-wiki-<id>` → `~/.openclaw/wiki/main`、`openclaw-workspace-<id>` → `~/.openclaw/workspace`、`openclaw-home-<id>` → `~/.openclaw`（承载 state/logs/extensions/skills，前两者在子路径遮蔽它，属正常叠加）。空卷首次挂载由 Docker 用镜像内 `~/.openclaw` 骨架**自动初始化**（wiki/workspace 骨架烤进自建镜像，免去独立模板 clone 与手工预填充）。删容器时 `docker volume rm` 连卷删除（`remove({v:true})` 只删匿名卷，named volume 须显式删）。
_Avoid_: bind-mount home——它要求「server 与宿主 docker daemon 解析同一宿主路径」（`/fleet` 坑，2026-08-01 生产实测），与「零 host 数据挂载」目标根本冲突。

**禁止挂 host (no host mounts)**:
生产部署除 `/var/run/docker.sock`（编排 OpenClaw 的唯一通道，无 volume 替代，spec §5.4 已接受等价 root 风险）外**零 host 挂载**。由此：模板与 `openclaw.json` 单一来源**构建期 COPY 进 server 镜像**（不再运行时挂载 `/srv/openclaw/template`、`./openclaw.json`）；`openclaw.json` 写读**不经文件 bind**——写用 `putArchive` 打进容器、读用 `getArchive` 拉出；`/fleet:/fleet` bind 随 homeDir bind 一并消失。dev 控制面也容器化（与 prod 同形态）。
**静态 config 后果**：`openclaw.json` 改经 `putArchive` 写后，#366 的「宿主 rename 换 inode + 目录 ro bind」热加载机制**放弃**——配置改为**静态**，改配置须重启容器生效（不复用 gateway watch 热加载）。这是 #366 决策的一次明确回退。
_Avoid_: 把 `docker.sock` 也当可删的 host 挂载——删它即失去编排能力；混用「运行时挂载模板」——违背配置入镜像的单一来源；假设配置仍可热加载——已改静态。
