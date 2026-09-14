# OpenClaw Fleet 面板

多 OpenClaw 容器管理面板。TS/Express 控制面（server/，替代已退役的 Django 后端，#341 M9）经四条接触路径与每个 OpenClaw 容器交互；Vue3 前端经 REST + WS 消费控制面。本 glossary 只收录**本项目特有**的领域术语，通用编程概念（Port / Adapter / Translator / Protocol 等设计模式词汇）不在此列。

## Language

**OpenClaw 容器 (OpenClaw container)**:
面板编排的单位。每个容器内跑一个 `main` agent、一个 gateway（WS，容器内 18789）、以及独立的 home / wiki / openclaw.json。它是本系统唯一的外部 bounded context。
_Avoid_: 实例——"实例"指面板侧的 `Instance` 数据模型，是 OpenClaw 容器在控制面的投影，二者不等同。

**一次性临时容器 (one-shot container)**:
由运行时原语 `runOnce` 以指定镜像 + 指定命令跑完即弃的容器（升级编排在「真容器尚未启动」的窗口里执行备份与 `openclaw doctor --fix` 的通道——stopped 容器不可 exec，新镜像网关遇 legacy 存储又拒绝就绪）。**它不是 OpenClaw 容器**：不写 fleet 三标签（`app` / `openclaw.instance` / `openclaw.port`）、不发布宿主端口，故对 fleet 列表与端口对账不可见；退出码非 0 即失败（`RunOnceError` 携带退出码与输出），容器由原语在成功/失败/异常三路强制回收（卷不删）。
_Avoid_: 临时实例——易与面板侧 `Instance` 模型混淆；影子容器——掩盖它由面板显式创建、必须回收的事实。

**面板 bounded context (panel bounded context)**:
面板内部的六个 bounded context（2026-08-13 划分，wayfinder #637）：containers（核心）/ 身份与访问 / wiki / models（支撑）/ files / traceLogs 审计（通用）。跨 context 契约：**行为协作一律经领域消息**（异步）；无 IO 纯函数/常量/渲染机制下沉**共享内核**；容器归属门 `getInstanceForUser` 是共享中间件**唯一单点**（tenant 引入时只替换此门）。隧道、前端 chat 协议机、health 探针**不是 context**（基础设施 / 接触路径 (4) 客户端侧 ACL）。
_Avoid_: 跨 context 直接 import 域服务（渲染、状态查询）——行为协作走领域消息；在 context 内复制共享内核纯知识（容器命名规则 `containerName`、配置安全不变量）——必须单一实现。

**镜像谱系 (image lineage)**:
承载 OpenClaw 容器的镜像决定容器的能力边界与挂载契约。有两个互不兼容的**现成**变体，另可自建第三条：
- **cn-im fork**（`acautomata/openclaw-docker-cn-im`）：历史部署镜像，启动时自带配置同步与权限降权（init 脚本），预装中国 IM 渠道插件，**不含 browser 运行时**（researcher 配置的 browser 插件在此镜像上无效）。
- **官方原版**（`ghcr.io/openclaw/openclaw`，分 `-browser`/`-slim` 变体）：OpenClaw 官方镜像，不自带配置同步逻辑；`-browser` 变体预装 Playwright，browser 能力可用（ADR 0003 选定 browser 变体为部署基线；当前基线版本 `2026.9.4-browser`）。
- **自建派生 (derived image)**：`FROM ghcr.io/openclaw/openclaw:2026.9.4-browser`（保 browser 能力，ADR 0003 基线）之上叠加本面板专属内容：`pdftotext`（poppler，PDF 文本提取 CLI，供 agent `tools.exec` 调用）+ wiki/workspace 骨架（COPY 进 `~/.openclaw`，供 named volume 首挂自动初始化，见「named volume 拓扑」）。经 `OPENCLAW_IMAGE` 注入。派生镜像**不新开谱系**，只在其基镜像谱系（官方）上加层；基镜像的 browser 能力、token 占位、SecretRef 等已校准性质原样继承。
_Avoid_: 「OpenClaw 镜像」——掩盖谱系在 browser 能力、挂载契约依赖、启动方式上的本质差异；讨论迁移/换镜像/重新打包时必须指明谱系（含派生镜像的**基镜像**谱系）。

**目标镜像与版本 tag (target image / version tag)**:
面板 fleet 的**目标镜像** = `config.fleet.image`（env `OPENCLAW_IMAGE`）：新建容器时写进容器记录，容器升级编排（#682）的检测判定即「容器记录镜像 ≠ 当前目标」。**版本 tag** = 派生镜像的 `:<基线 tag>`（基线 = `deploy/openclaw-image/Dockerfile` 的 `FROM` 行），**一经发布不可移动**；bump = 改 FROM 单源 + 四处**运行期**明文（config 默认值 / 模板栈 compose / dev driver / 测试常量）随之同步，由 `openclawImage.test.ts` 交叉断言锁死。**浮动 tag (floating tag)** = 无 tag（Docker 默认解析 `:latest`）或显式 `:latest`：内容随上游移动、使「当前目标」不可复现 → **生产启动即 fail-fast**（准据 `isFloatingImageRef`；dev/test 放行）；滚动 tag（`latest-browser` 等）不由代码拦截，靠 review 拦。
_Avoid_: 用「镜像版本」泛指——须区分**基线版本**（官方镜像 tag）与**派生镜像版本 tag**（发布后冻结）；也不要把「最新」当目标（浮动 = 不可复现）。

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

**轮次 (turn)**:
用户一次发送触发的完整 agent loop——一条 user 消息 + 一条 assistant 回复（含轨迹与正文），消息流上恰对应一条 assistant 消息。轮次是折叠、计时与异常判定的天然单位。
_Avoid_: 回合——暗示多方轮流对局，此处只有 user→agent 一拍。

**轨迹 (trace)**:
assistant 回复中的中间产物——思考（thinking）与工具调用（tools）。正文与附件不属于轨迹；中间文本与最终正文合并为一条正文存储、不可拆分，故同样不在轨迹之列（折叠收轨迹、正文整段留外的既成边界）。
_Avoid_: 过程/日志——笼统，掩盖「思考+工具 vs 正文」这条折叠边界。

**折叠条 (trace fold)**:
轮次**正常完成**后把轨迹收进的单个折叠块，正文与附件恒在折叠外。条面显示执行时长；历史轮无时长数据则显示步骤计数（如「执行过程 · 思考 · 3 次工具调用」）。展开只露一层——内部条目保持自身默认折叠态、可单独点开，折叠层内不再嵌套分组聚合。异常结束（报错/打断/断线宽限收尾）的轮次不折叠、保持展开，便于看原因。
_Avoid_: 二级聚合——折叠条展开后是平铺的思考卡与逐行工具行；无轨迹的轮次不渲染折叠条。

**执行时长 (turn duration)**:
用户点「发送」→ 本轮正常完成的墙钟时间，含建连排队与人工审批等待——用户感知的真实等待。流式进行中不显示，随折叠完成一并出现；<60s 显示「已执行 42s」，≥60s 显示「已执行 1 分 12 秒」。
_Avoid_: 响应耗时——暗示起算于首个响应帧、排除排队/审批，与本术语语义相反。

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

**消息锚点导航 (message anchor nav)**:
chat 页消息流右缘的垂直刻度轨，每个刻度锚定一条已加载的用户输入消息，支持点击定位与当前位置指示；刻度按消息在滚动文档中的位置比例分布。
_Avoid_: 对话索引、进度条——「索引」未指明只锚定用户输入；「进度条」暗示播放进度语义，实为导航目录。

**面板三态 (panel tri-state)**:
固定宽侧栏面板在本项目的三种呈现态：inline（常驻文档流可拖宽）/ collapsed（边缘窄条）/ popped（贴边全高非模态浮层）；转换链 inline → collapsed → popped → inline，窄屏 (<720px) 下整体禁用。
_Avoid_: 侧边窗口——不区分 inline/popped 两种形态；抽屉/弹窗——模态语义错误（popped 无遮罩、不因点外关闭）。

**转录条目 id (transcript entry id)**:
网关对话转录（transcript）DAG 里**单条消息**的持久化身份（`chat.history` 每条消息的 `__openclaw.id`，官方 Control UI 亦取此值）。它是回退 / fork / 分支切换的定位参数：指向「某条已落库的用户消息」。**只有已持久化消息有值**——面板本地乐观回显创建时没有，在 ack（网关已受理落库）后回读最新一页历史补齐：该轮的**发送键**（`chat.send` 的 idempotencyKey，网关侧称 clientRunId）是前缀，落库用户条目的 `__openclaw.idempotencyKey` 为 `${发送键}:user`，按此精确匹配后把 `__openclaw.id` 回填本地消息。补齐是 best-effort 且 fail-closed：未命中 / 回读失败 / 期间切走 → 保持缺省（等下次历史加载自然补上），入口照旧不渲染。流式占位全程没有。无值即不显示任何消息级操作入口。与分页锚点（`nextOffset`，数值 offset | 字符串 messageId 两态）是**不同字段**，禁止混用。
_Avoid_: 消息 id / messageId——「消息 id」在本项目已指分页锚点的字符串形态；`seq`——转录内序号，非持久化身份。

**对话回退 (conversation rewind)**:
把某条已持久化用户消息之后的历史从**当前活跃路径**剪除，被剪的首条用户消息文本与图片附件回填 composer 供编辑重发（面板的「消息编辑」形态——官方无原地改写）。回退不改写旧数据：旧路径留在网关 append-only 存储里，改动方式是**追加一个叶子事件把活跃路径重定向**，随后转录换新代；面板侧对应「放弃在途 run + 全量重拉历史」的重建（分页态随之重置）。成功路径两件随附事（Codex #703 review）：**作废本会话 outbox 待发残留**——残留条目属于被剪的旧代，不清则下次重连 resendOutbox 会把它重发到回退后的分支（消息复活 + 意外触发 agent run）；**重拉会话列表**——回退改写该会话权威元数据（`updated_at` 可能前移、派生标题可能随被剪首条改变），刷新侧栏日期分组与头部标题（多标签页列表陈旧仍是已知可接受瑕疵，本端自己发起的 mutation 后立即刷新不是订阅）。同族的 fork / 分支切换 / 分支 CAS 复用同一套 entryId 与重建语义。确认文案须说明后果（同「会话删除」的破坏性确认原则）。
_Avoid_: 删除消息 / 撤销——回退既不删旧数据也不是还原（是剪出一条新活跃路径）；「重新生成」——那是重发当前轮，不动历史。

**回退在途 (rewind in flight)**:
回退 RPC 已发出、重建管线未落地的窗口（一次 RPC + 一次全量重拉，编排层单飞——两次在途会在网关侧竞争同一活跃路径、落地序由网络决定，可能回填的不是最后一次意图）。窗口内消息投影仍是回退前的旧代：**发送被禁止**（composer 发送键置灰 + `send()` 守卫——此刻落下的 send 会被随后的放弃在途 run 吞掉：服务器端竞速下 run 被弃、乐观投影被重建冲掉，agent 却在服务端继续跑，用户消息与回复双双丢失）；**回退入口隐藏**（重入仍由编排层静默忽略，UI 门是双重防线）。输入框与附件编辑**不受限**——草稿指纹守卫保证窗口内的编辑在回填时原地保留（官方「your newer draft and attachments stay in place」）。落地后门项立即恢复。回退与 fork **在途互斥**（双向：两入口门均要求对方 busy 为假——两者同动 transcript，同时进行即网关侧乐观并发冲突）。
_Avoid_: 把窗口期入口做成「渲染可点、点到被吞」——静默吞破坏性动作的点击没有反馈；把 composer 整体置灰——窗口内继续打字是明确支持的交互。

**对话 fork (conversation fork)**:
从某条已持久化用户消息（entryId，切点语义与回退同源 `resolveMessageCut`——**该消息之前**的活跃路径前缀）创建**新会话**并原地切入：占位行置顶进列表（幂等）→ 标准会话切换（`resetForSession` + 全量重拉，跨会话切换连带清文件 tab = 手动切换语义）→ 新会话铺底后被点消息的文本与图片附件播种 composer。**与回退的关键差异**：免确认（源会话完整保留，非破坏性）；源会话**零动**——不作废 outbox 待发残留、不弃在途 run（网关侧 fork 不清源队列、不换源代，残留仍属合法旧代，重连 resendOutbox 照常重发）；无草稿指纹守卫（在途期间用户草稿属源会话，切换时按既有 draftKey 机制存回源 key，新会话草稿为空，播种不覆盖任何东西——指纹比对在 fork 场景是死代码）。失败分层：RPC 失败零状态变更（不 prepend / 不切换 / 草稿不动，走动作类错误通道）；RPC 成功即「网关已发生不可回滚」——新会话历史拉取失败不回切（走既有 loadHistory 失败路径），续体 stale 静默放弃播种不弹假错误。entryId / 重建语义与回退共用同一套基础设施（条目提取、能力探测、editor 载荷 0 信任校准、播种回填通道）。
_Avoid_: 复制 / 克隆会话——fork 只带切点前缀，被点消息去播种 composer 不在新 transcript 里；把 fork 做成「带确认的破坏性动作」——源会话不动，无破坏面可确认。

**分叉在途 (fork in flight)**:
fork RPC 已发出、导航 + 播种未落地的窗口（`forkBusy`）。门项照抄「回退在途」三件套（发送禁止 + 发送键置灰 + 入口隐藏）并与回退在途互斥；差异：**resendOutbox 不设栅栏**——fork 不剪源会话，待发残留重连照常重发（回退在途的栅栏针对「断线恰落在回退在途」的旧代残留竞态，fork 无此旧代）。落地后（含播种与 fail-soft 会话列表重拉）解锁，`transcriptSynced` 由新会话的权威 loadHistory 铺底自动置真。
_Avoid_: 给 fork 复制回退的 outbox 作废——源会话残留合法，作废即丢用户消息；给 resendOutbox 加 forkBusy 栅栏——重发本应照常进行。

**投影权威 (projection authority)**:
「当前消息投影 = 网关权威转录」的判定（`transcriptSynced`）：回退 / fork 这类**按历史条目定位**的动作只许在投影权威时可用。重连握手后、会话/历史同步（`syncSessions`）落地前恒**非**权威（fail-closed）——断线期间网关真实转录可能已前进，陈旧条目上的回退会剪除用户未见的轮次；任何一次权威 `loadHistory` 成功铺底（含中途失败降级部分铺底，最新页在列）恢复权威，同步全程失败保持非权威，由下次重连 / 切会话的自愈路径再置真。首连无此窗口（投影本空，无可点条目）；断线在途 run 的 resume 续帧路径不重建投影，不触碰本判定（流式门已挡住入口）。fork 成功切入新会话后的权威铺底同样置真（入口在新会话上恢复可用）。
_Avoid_: 用「能力已握手」替代投影权威——能力只回答「网关会不会受理」，不回答「用户看到的是不是最新转录」。

**会话控制能力 (session control capability)**:
对端网关是否支持回退 / fork / 分支这族 RPC 的判定：握手快照 `hello-ok.features.methods` 含全部四个方法名才算**可用**，否则面板整体隐藏这些入口（过渡期存量旧镜像容器混部时防呆——不出现点了必然报错的按钮）。能力随每次握手刷新（重连到旧网关即如实撤销）。**能力只是入口门的必要项之一**：入口渲染门 = 能力 ∧ 投影权威 ∧ 非三态忙碌（流式 / 连接中 / 已断线）∧ 非回退在途 ∧ 非分叉在途（#703 Codex P1 修订——原「不新增状态、复用三态」的决议在回退在途与重连同步两个窗口被证伪；#697 fork 增补 forkBusy 同款门项，见「回退在途」「分叉在途」「投影权威」词条）。
_Avoid_: 网关版本探测——判定依据是能力清单快照，不是版本号比较；把 capability 当「入口可点」的同义词——可点性还受投影权威与在途门约束。

**对话分支 (conversation branch)**:
同一会话在网关转录 DAG 里的多条活跃路径候选（由回退后重说 / 从历史点 fork 产生）。面板的分支菜单（聊天头部）只在**分支数 > 1** 时渲染（单分支 / 拉取失败 / 能力缺失统一不渲染——空列表即降级语义）；每项 = 最新消息摘要（网关 `headline`，空 →「未命名分支」）+「N 条消息」+ 时间（可选槽位缺失不渲染）。active 项打勾且 disabled——网关把 no-op 切换定为 typed error，UI 从不发起；active 判定唯一权威 = 网关标记（与分支 CAS 的 leaf 基准同源，不由本地 transcript 推导）。分支数据随会话切换 / 历史加载**并行预拉**（懒拉会让按钮出现被慢历史拖累），失败静默降级；`branchesGen` 请求代丢弃乱序旧响应。切换 = 同族「破坏性 RPC + 重建管线」：outbox 代际作废（被切走分支的待发不得重发进新分支）+ 放弃在途 run + 全量重拉历史与分支列表；busy 复用「回退在途」单一 ref。0 信任校准在协议层：`leafEntryId`（switch 定位参数）缺失才砍整项，纯展示字段异形只降级自己的槽位。
_Avoid_: 懒拉分支列表——按钮需要提前知道分支数；前端自提摘要——非活跃分支的 transcript 本地不存在；把 active 项做成可点再吞错误——防线的正确位置是从不发起。
