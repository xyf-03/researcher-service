# DDD 就绪度盘点（server + frontend 现状）

> 来源：arch-scout Explore agent 实读代码产出（2026-08-13），经 wayfinder map #634 的 research 票 #635 采信（用户拍板：直接采信，不重跑）。本文档是「bounded context 划分」「Prisma/Repository 边界」等决策的事实基线。
> 仓库根 = `$R`（盘点时点为 worktree `robust-gathering-hamming`，master @ aaa40d4）。

## 1. 模块清单（域逻辑 vs 基础设施混杂度）

### containers/ —— 最肥的域（CQRS 雏形 + 完整 Port 集）
- `runtime.ts` — **Port 定义**：`ContainerRuntime` 接口（`$R/server/src/containers/runtime.ts:66-94`）+ 纯值/纯函数（ContainerSpec/ContainerInfo/containerName/namedVolumesFor/volumeOrder）。无 IO。
- `dockerRuntime.ts` — **Adapter**：dockerode 实现（`runtime.ts:58` 起的 DockerRuntime），`buildRunOptions` 是纯逻辑 seam（`dockerRuntime.ts:73`），其余方法经 docker client。域逻辑与基础设施**分离良好**（构造参数 clientFactory 可注入 mock）。
- `command.ts`（605 行）— **写侧状态机核心**：FleetCommand 混了全部创建/删除流程——进程内租约、取消注册表 CancelRegistry（`command.ts:54-65`）、reserveRow 事务预占、createComplete provisioning（mkdir+cp+render+create+writeConfig+startById+检查点）、finalizeFailedCreate 补偿收尾、stopAndRemove chown 前置、delete 代系绑定。**域逻辑与基础设施调用混在同一类同一函数**（deps 已把 IO 全部打到 Port，但流程编排本身是 600 行单类）。
- `readModel.ts` — 读侧聚合 FleetReadModel：DB 记账 + runtime 实况 + health 探测聚合、reconcileCreating/reconcileRemoving 读路径 lazy 对账（`readModel.ts:100-170`）。
- `orchestrator.ts` — 薄 facade 组合根：cmd + read 委托 + 共享 `getInstanceForUser` 归属前置（`orchestrator.ts:74-91`，唯一单点归属门）。
- `deps.ts` — **单一装配点** FleetDeps：打包 runtime/config/provisioner/allocator/archive/lock/queue/serializer/crypto/dirRemover/portInUse/health/onEvict/quotaSerializer，全部可单点替换（`deps.ts:59-110`）。
- `ports.ts` — PortAllocator 纯逻辑端口池（无 IO）。
- `provisioner.ts` — HomeProvisioner（cp 模板，防无限递归校验）。
- `lifecycleQueue.ts` — LifecycleQueue **Port** + InlineLifecycleQueue（测试）+ NameSerializer 按 name 串行器。
- `bullmqQueue.ts` — BullMqLifecycleQueue **Adapter**（Redis/BullMQ，stalled 重跑 + submit 超时 + 两表注册表）。
- `leaseMap.ts` — NameLeaseMap 进程内互斥。`configRenderer.ts` — ConfigRenderer 渲染 + 安全不变量强制（见 §4）。`values.ts`/`constants.ts`/`errors.ts` — 纯值/常量/异常族（ContainerDomainError 携带信封码）。

### wiki/ —— 教科书级 Port/Adapter + 纯逻辑
- `fsPort.ts` — WikiFileSystem **Port**（`fsPort.ts:58-65`）。
- `dockerFs.ts` — DockerWikiFileSystem **Adapter**（`dockerFs.ts:81`，Docker getArchive/putArchive/exec rm；读侧自实现、写侧委托 FileArchive root='wiki'、managed 黑名单前置）。
- `service.ts` — WikiService 组合根（构造注入 fs + parser + extractor）；CRUD 直接委托 Port，buildGraph/listCategories 聚合纯逻辑。
- `logic.ts` — 纯逻辑协作者（FrontmatterParser/CategoryMarkerExtractor/WikilinkResolver/cmp/decodeUtf8Strict/h1Title，全部无 IO）。
- `routes.ts` — 5 路由 7 方法（serviceFor 工厂注入，`routes.ts:45-46`）。
- `paths.ts`/`values.ts`/`errors.ts` — 请求层校验/常量/异常族。
- `compile.ts` — CompileTrigger **小 Port**（DockerCompileExecutor/DebouncedCompileTrigger/noopCompile/makeDockerCompile，`compile.ts:8-56`）。
- 注：CLAUDE.md 与 `fsPort.ts:2` 注释仍写「nodeFs.ts」，实际该文件已退役删除（`logic.ts:162` 注释「自 nodeFs.ts 搬入：Node 适配器退役后由 Docker 适配器复用」）——文档/注释过时点。

### files/ —— 干净的 Port/Adapter
- `fsPort.ts` — FileArchive **Port**（read/write/create/delete + writeConfig/readConfig，`fsPort.ts:42-60`）。
- `dockerArchive.ts` — DockerFileArchive **Adapter**（流式 probe 防大文件、NUL 嗅探判二进制、幂等 start、tar 打包）。
- `tar.ts` — 极简 tar 解析/打包纯函数（ustar+GNU+PAX）。
- `routes.ts`/`paths.ts`/`values.ts`/`errors.ts` — 4 路由 4 方法 + 请求层校验（放宽 wiki 的 .md 限制）+ 常量（FILE_ROOTS/WALK_LIMIT/MAX_FILE_READ_BYTES）+ 异常族。

### models/ —— 工程化 CRUD + 事务加固
- `service.ts`（311 行）— ModelProviderService：**直接依赖具体 PrismaClient**（构造注入 prisma，非 Port），三写操作共用 $transaction + rewrite + needsReconcile + reconcile 骨架（`service.ts:133-222`），模块级 per-container 串行锁（`service.ts:87-97`），事务内状态谓词 assertWritable（`service.ts:251-256`，跨域读 container 行）。
- `configWriter.ts` — ModelConfigWriter **Port** + TemplateModelConfigWriter **Adapter**（惰性 renderer + readConfig 旧代探测 + writeConfig 落盘）。
- `configBuilder.ts` — ProviderConfigBuilder 纯合并逻辑（无 IO/无 Prisma）。
- `routes.ts`/`values.ts` — 5 路由 + wire↔DB 枚举映射（API_CHOICES 等常量被 validation/schemas.ts 反向引用）。

### chat/ —— 隧道（ADR 0006）+ 审计观察者内嵌
- `tunnel.ts`（463 行）— createTunnelServer：JWT subprotocol 握手、归属门、4401/4402/4403/4404 close 语义、背压/名额/并发上限、周期复查 revalidateTunnelUsers。**关键发现：非纯透传**——转发路径内嵌 traceLogs 提取（`tunnel.ts:289-290` extractChatSend、`tunnel.ts:400-437` extractChatSendAck/Final/Error → recordTextTrace 写 Prisma TextTraceLog）。这是 traceLogs 域的审计观察者混在透传管道里（chat 域自身域逻辑已随 ADR 0006 移除，配对/会话投影归官方包+前端）。
- `gatewayConnector.ts` — GatewayConnector/GatewaySocket **传输 Port**（生产 makeWsGatewayConnector，测试 fake）。
- `subprotocol.ts`/`values.ts` — 纯函数解析/常量。
- `tunnelAssembly.ts` — 装配接缝（可测 origin 透传）。

### auth/ —— CRUD + 函数级 seam
- `authenticate.ts` — authenticate（REST/WS 共用验签）+ toAuthUser 投影。
- `tokens.ts` — JWT 签发/验签 + refresh 散列 + revokeAllUserRefresh（`Pick<PrismaClient,...>` 函数接缝）。
- `userService.ts`/`bootstrap.ts`/`password.ts`/`quota.ts` — createUser、B1 惰性首启、bcrypt(12)、配额纯校验（零依赖防循环）。

### traceLogs/（CLAUDE.md 模块表未列的域）
- `service.ts` — 帧提取纯函数（extractChatSend/SendAck/Final/Error）+ recordTextTrace/listTextTraceLogs（直 Prisma）。
- `routes/traceLogs.ts` — admin-only 查询端点。

### 横切件
见 §6。`routes/` 还有 health.ts（公开探针）。

## 2. 现有接缝（Port → Adapter → 注入方式）一览

| Port 接口 | 位置 | 生产 Adapter | 注入方式 |
|---|---|---|---|
| `ContainerRuntime` | containers/runtime.ts:66 | DockerRuntime（dockerRuntime.ts:58） | FleetDeps 构造必填（deps.ts:74） |
| `LifecycleQueue` | containers/lifecycleQueue.ts:14 | BullMqLifecycleQueue / InlineLifecycleQueue | FleetDeps.queue（deps.ts:86） |
| `CryptoPort` | crypto.ts:61 | AesGcmCrypto（crypto.ts:66） | FleetDeps.crypto（deps.ts:89） |
| `FileArchive` | files/fsPort.ts:42 | DockerFileArchive（dockerArchive.ts:60） | FleetDeps.archive（deps.ts:82）+ app.ts AppDeps.files → createFilesRouter |
| `WikiFileSystem` | wiki/fsPort.ts:58 | DockerWikiFileSystem（dockerFs.ts:81） | createWikiRouter deps.serviceFor 工厂（wiki/routes.ts:45-46） |
| `ModelConfigWriter` | models/configWriter.ts:21 | TemplateModelConfigWriter（configWriter.ts:35） | app.ts AppDeps.models.configWriter（app.ts:26-33） |
| `CompileTrigger` | wiki/compile.ts:8 | DebouncedCompileTrigger(DockerCompileExecutor) | app.ts AppDeps.wiki.compile（app.ts:23） |
| `GatewayConnector`/`GatewaySocket` | chat/gatewayConnector.ts:30/21 | makeWsGatewayConnector（gatewayConnector.ts:44） | TunnelDeps.connectGateway（tunnel.ts:53） |
| PrismaClient | prisma.ts 工厂 | — | createApp 构造参数 + `req.prisma`（app.ts:48-51）；测试 createPrismaClient(testUrl) |
| 附加可注入替身 | FleetDepsOverrides | dirRemover/portInUse/health/lock/queue/serializer/onEvict/crypto/quotaSerializer/archive（deps.ts:59-71） | FleetDeps 构造覆盖 |

**chat 域域逻辑确认**：chat 域已无 chat 业务逻辑（ADR 0006 后协议机/会话投影/配对状态机全在浏览器官方包 + 前端 chat/），server chat 域只剩握手+归属+透传+上述内嵌的 traceLogs 审计提取。**但 tunnel.ts 里的审计提取是唯一「域逻辑混在基础设施管道」的实例**。

## 3. Prisma 数据模型与读写方

schema.prisma 共 6 model（+4 enum）：User / RefreshToken / TextTraceLog / Container / Pairing / ModelProvider。关系：User 1—N Container/RefreshToken/TextTraceLog；Container 1—1 Pairing、1—N ModelProvider。

各 model 读写方与跨模块直读：
- **User**：写 auth/userService.ts、auth/bootstrap.ts、routes/users.ts（PATCH/reset）；读 auth/authenticate.ts、routes/auth.ts（login）、routes/users.ts、middleware/auth.ts（经 authenticate）、chat/tunnel.ts:123-126（revalidateTunnelUsers 直查）、traceLogs/service.ts:165-179（写 trace 时投影 userId/username）。**跨模块直读 User 的域：chat、traceLogs、users**。
- **RefreshToken**：仅 auth/tokens.ts + routes/auth.ts。
- **TextTraceLog**：写 traceLogs/service.ts:162（recordTextTrace，由 chat/tunnel.ts 调用）；读 routes/traceLogs.ts。
- **Container**：写 containers/command.ts（reserveRow/create/update status/delete）+ readModel.ts（reconcile 落盘）；读 readModel.ts、orchestrator.ts:79（getInstanceForUser）、routes/containers.ts:75-78（pairing join 用 id）、**models/service.ts:252（assertWritable 事务内跨域读 container.status）**。
- **Pairing**：**全部在路由层裸操作**——routes/containers.ts:75-77（list 预取 findMany）+ routes/containers.ts:187-191（approve 端点 upsert pending→paired）。**无配对域服务**。
- **ModelProvider**：仅 models/service.ts。

跨模块直读结论：Pairing 无域层；models→containers 状态谓词是正当的跨域依赖（生命周期状态）；chat/tunnel 直读 User + 写 TextTraceLog（审计耦合点）；routes/containers.ts 路由层直接 req.prisma.pairing（路由层越权拿 DB）。

## 4. 不变式与状态机

### 5 态机（creating→running⇄stopped→removing(终)+error）
- 迁移规则**分散在三个文件**：
  - 写侧：command.ts:9-10（注释=状态机规格）、reserveRow 落 creating（command.ts:164-177）、createComplete 成功后 update running（command.ts:295-298）、deleteReserve 标 removing（command.ts:503）、markError 标 error（command.ts:444-448）、delete 终态删行（command.ts:592）。
  - 读侧推导：readModel.ts:4（「running/stopped 由 runtime 实况动态推导，DB 只持久化 creating/removing/error」）、buildItem（readModel.ts:73-96）、reconcileCreating/reconcileRemoving lazy 对账（readModel.ts:100-170）。
  - 路由层额外判状态：routes/containers.ts:139（bootstrap-token 非 running 拒）、routes/containers.ts:175（approve 非 running 拒）、models/routes.ts:77-86（resolveWrite 拒 creating/removing 20043）。
- 调用方：routes/containers.ts POST/DELETE → Orchestrator facade → FleetCommand。
- **无聚合根封装状态迁移**：Container 是 Prisma 生成类型被各处直接 update，迁移规则无单一宿主（DDD 视角最显著缺口）。

### 配对 A3 状态机
**不在 server**。320 spec G 节明确「无 Redis 快照、无 A3 状态机——配对记账落 Prisma Pairing 表」（320-implementation-spec.md:261）；AGENTS.md 的「A3 双层状态机」描述已过时。现状：server 只做 approve 编排（routes/containers.ts:157-193：容器内 execSync `openclaw devices approve <requestId>` → Pairing 行 pending→paired upsert + 幂等前置 + 非 running 20046）；真实状态机在容器内 gateway + 前端官方协议机 deviceAuth lifecycle（frontend/src/chat/deviceAuth.ts:1-10：buildPlan/acceptHello/clearStoredToken）。

### 其余业务不变式
- **端口池**：PortAllocator 取最小空闲（ports.ts:25-34）；已用集四来源 = DB 记账 ∪ daemon fleet label ∪ daemon 宿主发布端口 ∪ 宿主 bind 实测（command.ts:195-216）；DB `port @unique` 仲裁并发（command.ts:179-183）；bind 冲突就地换端口重试（command.ts:301-353）；配额 check-then-act 按 owner 串行（command.ts:111-119）。
- **config 渲染安全不变量**：ConfigRenderer.renderDict 强制 port/bind/token 占位 ${GATEWAY_TOKEN}/auth.mode='token'/allowInsecureAuth=false/allowedOrigins 含面板 origin（configRenderer.ts:80-97）；ProviderConfigBuilder 断言 secrets.providers.default 存在且 source='env'、apiKey 恒 SecretRef 不落明文（configBuilder.ts:44-57、renderProvider 92-104）。
- **GATEWAY_TOKEN 加密**：AesGcmCrypto（crypto.ts:66-106，v1:iv:ct||tag 格式、密钥轮换遍历解密）；DB 存密文（command.ts:150）、docker env 注入明文（command.ts:263）；bootstrap-token 端点用时解密（routes/containers.ts:142-144）。
- **代系绑定（#360）**：instances/<id>/home、named volumes 按 id 派生、delete expectedId 校验（command.ts:534-537）、list pairing join 按 containerId（routes/containers.ts:74）。
- **取消标志**：CancelRegistry（command.ts:54-65）+ provisioning 三检查点（command.ts:235/254/283）。
- **models 盘-DB 一致**：事务内 rewrite + ConfigWriteError 回滚 + 选择性 reconcile（service.ts:264-286）。
- **R1 refresh 旋转**：条件撤销 + 旋转链 + 重放族灭（routes/auth.ts:54-108）。
- **防探测同码**：getInstanceForUser 20040（orchestrator.ts:74-91）+ users 10041 + wiki 30040 + models 40040 + files 60040。

## 5. 依赖方向（模块级 import 图）

```
app.ts（组合根）装配全部 router；server.ts 生产装配（fleet/tunnel/wiki compile/models writer/files）
routes/*（每域路由）→ middleware/*、validation/schemas、envelope、codes、containers/orchestrator(getInstanceForUser)、auth/*（users/auth 路由）、crypto+config（仅 containers 路由）
containers → files（deps.ts:11-12 → dockerArchive/fsPort；用于 writeConfig + 编排注入 archive）
files → containers/runtime(containerName, dockerArchive.ts:13) + containers/constants(HOME_BIND, files/values.ts:5)
wiki → files（dockerFs.ts:30-34 读 tar/写委托 FileArchive）+ containers/runtime（containerName）
models → containers（configRenderer/errors）+ files（fsPort/errors）
chat → auth/authenticate + containers/orchestrator（getInstanceForUser）+ traceLogs/service（审计提取）
middleware → auth/authenticate（auth.ts）、containers/errors（errorHandler.ts）
validation/schemas → models/values（API_CHOICES 等枚举）
traceLogs → config + prisma
```

**依赖反向/循环迹象**：
1. **containers ⇄ files 包级双向**：containers/deps.ts→files；files/dockerArchive.ts→containers/runtime.ts、files/values.ts→containers/constants.ts。模块级无环（files 只依赖 containers 的纯常量/纯函数 containerName），但域目录层面是双向的——DDD 视角应把 files 的依赖点（容器名前缀、HOME_BIND）下沉为共享内核或反转让 files 自持。
2. **validation/schemas.ts（横切件）→ models/values.ts（域常量）**：方向倒置的小点——校验层反向依赖域枚举（PROVIDER_ID_REGEX/API_CHOICES/MODEL_INPUT_MODALITIES 定义在 models/values.ts:16-46）。
3. **chat → traceLogs**：隧道管道内嵌审计提取（非依赖方向问题，是观察者混入管道的混杂问题）。
4. **routes/containers.ts → crypto + config**：路由层直接读 config.fleet.encryptionKeys + new AesGcmCrypto 解密 bootstrap token（routes/containers.ts:142-144），绕过 orchestrator/deps 装配——装配泄漏进路由层。
5. **routes 层普遍直连 req.prisma**：pairing findMany/upsert（containers 路由）、users CRUD、auth 事务——PrismaClient 作为「全局连接对象」穿透所有层（req.prisma 注入，types.ts:16-19），Port 只包了 IO 设备（docker/redis/fs），未包持久化仓储。

## 6. 横切件

- **validation/schemas.ts**：zod 全量（loginSchema/passwordChangeSchema/userCreateSchema/userPatchSchema/containerCreateSchema/modelProviderWriteSchema + CONTAINER_NAME_REGEX/USERNAME_REGEX/72 字节密码上限）；validateBody 中间件（middleware/validate.ts:9-20）转 90002+fieldErrors，errorCode 可覆盖（10042）。
- **envelope.ts**：EnvelopeError/fail/ok（envelope.ts:18-38）；**errorHandler.ts 唯一错误面**（errorHandler.ts:7-27：EnvelopeError→信封、ContainerDomainError→码、SyntaxError/entity.parse.failed/entity.too.large→90002、其余→90000）；notFound→90005（errorHandler.ts:30-32）。wiki/models/files 路由各自另有页级域错误映射函数（assertPageOpError/assertFileOpError/service.rethrowKnown）——域异常→信封码的翻译在路由层而不是唯一错误面。
- **codes.ts**：五位码表 CODE + DEFAULT_MESSAGE（codes.ts:7-79）；实际码段已从 spec 的 5 段演化（5xxxx chat 段已作废——chat 只剩 WS close 码在 chat/values.ts；6xxxx files 为新增段）。
- **middleware/**：auth.ts（requireAuth 幂等短路 + requireAdmin）、mustChangePasswordGate.ts（10005 + 白名单 /me /logout /password/change）、validate.ts、errorHandler.ts。
- **config.ts**：env 唯一读取点（CONTEXT.md「配置边界」词条），生产 fail-fast 家族（JWT_SECRET≥32、BCRYPT_COST=12 硬锁、OPENCLAW_TEMPLATE_DIR 绝对/存在、端口池交叉校验、PANEL_PUBLIC_ORIGIN、OPENCLAW_NAMED_VOLUMES、CREDENTIAL_ENCRYPTION_KEYS）；fleet 子配置一次性求值（config.ts:219-256）。

## 7. 测试接缝 1–5（官方定义在 320 spec §Testing Decisions）

`$R/docs/research/320-implementation-spec.md:322-336`（已与用户对齐，5 后端 + 1 前端，与 5 后端域一一对应）：
1. **WikiFileSystem Port** — 纯逻辑对 fake FS 直测（注入 5 类坑：symlink/非 regular/不可读/SKIP/降级）。落地：test/wikiService.test.ts、wikiLogic.test.ts、wikiDockerFs.test.ts。
2. **Envelope REST 契约**（app.inject 风格）— 注入假身份打路由，断言 HTTP 200+信封码+归属前置。落地：test/setup.ts:12「接缝 #2 测试基座：每测试文件独立临时 SQLite」+ 各 *-auth.test.ts/files.test.ts/models.test.ts。
3. **WS 桥**（wss 事件发射器）— upgrade/JWT/4401/subprotocol 回显。落地：test/tunnel.test.ts、tunnelProtocol.test.ts、chatSubprotocol.test.ts（注释标「测试接缝 3 WS 桥」）。
4. **GatewayClient.hostDeps / 配对编排** — 后端：注入假 runtime docker exec 测 approve 端点（Prior art: test/pairingApprove.test.ts）；前端：gatewayChat 模块边界注入假 createSocket+假 tokenStore（Prior art: frontend/src/chat/gatewayChat.test.ts）。
5. **编排器 Port** — 注入假 docker + 假 BullMQ（inline），断言 5 态机/取消标志/端口分配/补偿。落地：test/fleetTestUtils.ts:1「编排器测试装配（接缝 #5）：tmp fleet root + 最小模板 + fake runtime + inline queue」+ orchestrator.test.ts、containers.test.ts；集成 smoke 门控（containers-smoke.test.ts、pairingSmoke.test.ts 需真 docker daemon）。
6. **前端接缝** — chatStore + useChatConnection 假 ws。

**注意**：代码注释内部另有一套编号体系（setup.ts:12「接缝 #2」=prisma DI 测试基座、fleetTestUtils.ts:1「接缝 #5」=编排器），与 320 spec 编号一致；但另有 ticket 号接缝（#589 FileArchive 新接缝、#591 config 写读接缝、clientFactory 注入接缝）与 spec 五接缝并存的命名债。CLAUDE.md 的「接缝 1–5：wiki Port / 信封 REST / WS 桥 / hostDeps / 编排器 Port」即 spec 五接缝的缩写。

## 8. 领域模型文档摘录

- **docs/agents/domain.md**（$R/docs/agents/domain.md）：消费指引——读 CONTEXT.md/CONTEXT-MAP.md + ADR、输出用 glossary 词汇不漂移同义词、与 ADR 冲突须显式 flag。**CONTEXT.md 存在**（$R/CONTEXT.md），术语表含：OpenClaw 容器/镜像谱系/接触路径（四条）/防腐层 ACL/wire 概念（标识符保留、语义类翻译）/配置边界（env 唯一读取点=config.ts）/隧道（不解析不翻译不注入凭证，区别于旧胖中介）。
- **320 spec 架构结论**（$R/docs/research/320-implementation-spec.md）：同进程单端口 Express+ws（:166-168）；Prisma 7+SQLite（:169）；BullMQ+Redis 只做调度/易失态，持久态在 SQLite（:170-171）；B-直连隧道三件薄事=认证隧道+approve 编排+bootstrap 发放（:255-257）；wiki 分层平移 WikiService 纯逻辑与 WikiFileSystem Port（:275）；「好测试标准：只测外部可观察行为，模块边界本身就是最高接缝」（:320）。
- **ADR 0002 防腐层**（$R/docs/adr/0002-openclaw-anti-corruption-layer.md）：对 OpenClaw 四条接触路径各建 Port+Adapter（Hexagonal），strangler 落地；否决单一 Facade、vendor-neutral、标识符激进翻译；ORM 列名保留 OpenClaw 原生命名=「外部 schema 的持久化缓存」。域边界约束：OpenClaw wire 概念不得污染控制面 domain，隔离面=可测性+演进隔离。
- **ADR 0012 文件查询经 Docker 原语**（$R/docs/adr/0012-file-query-via-docker-archive.md）：统一文件 CRUD 端点按 root 分 wiki/workspace 两树，底层 getArchive/putArchive/exec rm，否决 gateway 插件（暴露面/占位 token 不兼容/CORS/根不可配四理由）；**wiki 的 graph/categories 语义聚合不是裸文件 CRUD、保留不动**。域边界约束：files 域=裸 CRUD 底层，wiki 语义层叠加其上（实现上 wiki 写侧委托 FileArchive root='wiki'，读侧自实现快照）。

## 9. frontend 概览（粗）

- `views/`（11 视图）：按域组织——Login/Containers/Chat/Wiki/Model/AdminUsers/Categories/TraceLogs/NotFound/LegalDocument。
- `stores/`：auth.ts / wiki.ts / chat.ts / categories.ts / fileTabs.ts——按域 Pinia store。
- `api/`：client.ts（信封拦截器 + R1 旋转 + 并发刷新去抖）+ 按域文件 auth/containers/wiki/models/files/users/chat/traceLogs——**与 server 路由域一一对应**。
- `chat/`：官方协议机编排层，域逻辑远比后端 chat 肥——gatewayChat.ts(769 行)/useChatConnection.ts(1266 行)/eventTranslate.ts(554 行)/deviceAuth.ts/tunnelSocket.ts/sessionProjection.ts/outboxStore.ts/protocol.ts/closeCodes.ts/thinking.ts/toolRender/。
- 结论：前端整体跟着 server 域边界走（api 域文件、stores 域 store 对齐），但 chat 域呈「后端瘦前端肥」的倒挂——ADR 0006 把协议机/会话投影/配对生命周期全部推给了浏览器。

## DDD 就绪度小结

**已是清晰 Port/Adapter 雏形的模块**：
- `containers/`：最成熟——ContainerRuntime/LifecycleQueue/CryptoPort/FileArchive 四 Port + FleetDeps 单点装配 + FleetCommand/FleetReadModel CQRS 雏形 + 纯逻辑（PortAllocator/ConfigRenderer/ProviderConfigBuilder）。基础设施已全部打到 Port 背后，可纯内存测试。
- `wiki/`：教科书级——Port+Adapter+纯逻辑协作者分层，service 构造注入。
- `files/`：干净 Port/Adapter + 纯 tar 解析。
- `models/`：configWriter Port 隔离写盘；但 service 直依赖 PrismaClient 具体类（唯一未走 Port 的持久化）。
- `chat/`：GatewayConnector 传输接缝干净；域逻辑已清零（只剩内嵌 traceLogs 审计提取）。

**纯 CRUD / 无域层的模块**：auth、users、traceLogs、Pairing（pairing 记账在 routes/containers.ts 路由层裸 Prisma，无任何域服务）。

**域逻辑最肥（最需要战术模式收容）**：
1. `containers/command.ts`（605 行单类）——创建/删除状态机+补偿+取消+代系绑定全流程；最需要 Aggregate/Factory/生命周期 Saga 拆分。
2. `models/service.ts`（311 行）——事务+reconcile 高度工程化，但事务骨架与并发锁内联在 service，且 PrismaClient 未隔离。
3. `chat/tunnel.ts`（463 行）——握手/归属/背压/名额/审计提取混一管；traceLogs 提取应抽成独立 Observer/中间件链。
4. Pairing 记账散在路由层（list 预取 + approve upsert + bootstrap-token 解密全在 routes/containers.ts）。

**结构性缺口（DDD 视角）**：
- 无 Aggregate/实体封装：5 态机迁移规则散在 command.ts/readModel.ts/routes 层三处（models/routes.ts:77-86 和 routes/containers.ts:139/175 在路由层重复判状态）。
- 无 Repository 抽象：PrismaClient 经 req.prisma 穿透所有层；Port 只隔离了 IO 设备未隔离持久化。
- 依赖方向两个小反向：validation→models/values（横切件依赖域常量）、containers⇄files 包级双向（可接受但需记录）。
- 无领域事件机制：delete 后的 onEvict 是空挂点（deps.ts:56-57「ADR 0006 下池壳被删，留空挂点」），traceLogs 审计靠隧道内嵌提取——未来域联动缺事件总线。
