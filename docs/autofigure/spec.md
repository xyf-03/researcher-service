# AutoFigure 集成 —— 规格（spec / PRD）

> 状态：**规格草案，待发布到 issue tracker**（`ready-for-agent`）。本文档由 `/to-spec` 依据
> [reconnaissance.md](./reconnaissance.md)（事实侦察）与 [grilling-decisions.md](./grilling-decisions.md)
> （已批准决策）综合而成。**集成目标：`ResearAI/AutoFigure`**（非 AutoFigure-Edit）。
> 测试接缝已与用户确认（唯一新接缝 = `AutoFigureGenerationPort` —— 外部 AutoFigure 计算能力 Port；复用既有 REST 信封接缝 + 门控辅助测试）。
> 发布方式：本文件 + `gh` 命令模板由用户手动执行。

---

## Problem Statement

面板用户（研究员）需要一个把文字描述变成可视化图表（text-to-figure）的能力，但目前面板没有任何图形生成功能。`ResearAI/AutoFigure` 已具备该能力，但它是一个独立运行的 Flask 应用：**无认证**（`verify_token` 不校验）、浏览器直连不安全、provider 凭证硬性要求走请求体 `api_key`（`autofigure_routes.py:366`）——这与 researcher-service「认证权威」「凭证只经 env 注入」「浏览器不得直连未认证后端」等既有架构约束直接冲突。

集成必须在 researcher-service 作为宿主的既有架构内完成：复用既有认证体系，不引入第二外部认证系统，保留 AutoFigure 的 Python 生成能力（而非盲目重写算法），凭证服务端化，异步执行（nginx `/api/` 代理 300s 超时事实直接否决同步等待），并遵守适用的许可/署名要求。

## Solution

在 researcher-service 控制面新增 **AutoFigure 域**：

- **公开 REST API**：`POST /figures`（异步提交，HTTP 200 信封 + `status:'queued'`）、`GET /figures`（当前用户历史）、`GET /figures/:id`（详情 + 应用级生成状态）、`GET /figures/:id/png`（仅 owner、仅 succeeded 下载）。全部走全局 #312 信封。
- **轻量 Job Runner**：SQLite/Prisma 为 Job 状态的唯一持久化事实源；`concurrency = 1`；无自动重试；30 分钟超时（自进入 running 起算）；启动时遗留 running reconcile 为 failed。不引入 Redis/BullMQ 依赖。
- **内部 HTTP sidecar**：panel-net 内私有服务，不暴露宿主端口；Python 无状态（每 Job 独立 session）；不收 JWT/userId；只收生成参数 + 服务端注入的 provider 凭证。
- **Vue-native 前端**：新增 `AutoFigureView`（输入 → 预览 → 下载 → 历史），复用既有 auth store / 信封解析 / 轮询 / 下载先例。
- **feature flag**：`AUTOFIGURE_ENABLED` 默认关闭；关闭时路由/worker/sidecar 依赖不装配。
- **新错误码段** `7xxxx`（`70040` 不存在/越权同码锁式）。

## User Stories

**普通用户（面板 user）**

1. 作为面板用户，我想输入一段文字描述并提交生成图片，以便把想法/数据变成可视化图表。
2. 作为面板用户，我想在提交后立即收到确认（含 figureId/jobId/queued 状态），以便知道请求已被接受、不会卡在请求层。
3. 作为面板用户，我想查询自己的生成任务状态（queued/running/succeeded/failed），以便了解进度并决定何时回来查看。
4. 作为面板用户，我想在生成完成后看到 PNG 预览，以便确认结果是否符合预期。
5. 作为面板用户，我想下载已成功生成的 PNG，以便用于论文、报告或幻灯片。
6. 作为面板用户，我想查看我的历史生成列表（以图为单位），以便回看之前的结果。
7. 作为面板用户，我想打开某个历史生成的详情页，以便重看该图的输入与结果。
8. 作为面板用户，我想在没有认证时被要求登录，而不是拿到生成数据。
9. 作为面板用户，我想看到失败的非敏感错误信息，以便知道是超时、校验失败还是内部错误。
10. 作为面板用户，我想在生成失败后能重新发起生成（新建 Figure + Job），而不是被静默重试。
11. 作为面板用户，我想双击提交只产生一次生成（幂等键去重），以免被重复计费。
12. 作为面板用户，我想在并发受限（concurrency=1）时任务排队等待，以便系统不会过载。
13. 作为面板用户，我想在未完成任务时尝试下载 PNG 得到明确的应用级提示，而不是模糊的 500。
14. 作为面板用户，我想知道该功能是否可用（flag 关闭时看到明确提示），而不是裸 404。

**管理员（面板 admin）**

15. 作为管理员，我想看到所有用户的生成（跨用户可见），以便监督与管理。
16. 作为管理员，我想通过 feature flag 控制功能启停，以便分阶段发布、必要时快速关闭。
17. 作为管理员，我想让系统级共享 LLM 凭证由服务端配置注入，以便用户无需（也无法）自行配置 key。

**运维**

18. 作为运维，我想确认 provider 凭证不落入请求体、不落 Job payload、不落盘，以便满足安全审计要求。
19. 作为运维，我想通过 sidecar 健康检查与面板 `/api/health` 监控 AutoFigure 域可用性。
20. 作为运维，我想确认 AutoFigure 不新增对 Redis/BullMQ 的依赖，以便保持既有部署面。
21. 作为运维，我想在服务重启后看到遗留 running 任务被 reconcile 为 failed，以便状态机不卡死。

## Implementation Decisions

### 1. 领域模型与持久化（grilling §2 / §6）

- **Figure = 用户面对的唯一聚合**，用户可见、可拥有、可历史查询。属性含输入 prompt、归属（ownerId）、生成状态、产物（XML + PNG + evaluation/metadata）、时间线。
- **Job（Generation）= 一次后台执行记录**，不承载 Figure 生命周期。
- **Cardinality：`Figure 1:1 Job`** —— 一张 Figure 恰好对应一个 GenerationJob。分两张表的理由为职责分离：Figure 承载领域资源语义，Job 承载执行状态关注；**不是**为未来 1:N 预留，V1 不承诺扩展为 1:N。
- **Prisma 命名**：`Figure`→`figures`、`GenerationJob`→`generation_jobs`（PascalCase 单数 + `@@map` snake_case 复数）；`@@index([ownerId])` 归属索引。
- 产物存储：PNG 存 SQLite **BLOB** 列，XML 存**文本**列。面板无对象存储、V1 不引入；未来可迁移（预留扩展点，不建抽象层）。
- **产物提交时机**：XML/PNG 仅在 Job **提交 succeeded 终态时**一并持久化；running/failed 不落成功产物。Job 已进入 failed 后 Python 迟到的成功产物**不得**回写为 Figure 成功产物（丢弃，状态不变）。
- **删除不在 V1**：owner 与 admin 均无 Figure 删除 API；无硬删、无级联删除公开行为（见 Out of Scope）。

### 2. 状态机（grilling §5）

```
queued ──▶ running ──▶ succeeded
             │
             ▼
           failed
```

- 状态机为唯一对外状态语义；Public API 只暴露**应用级 job 状态**，不泄露 queue/worker/Python/BullMQ 实现细节。
- 无自动 retry（timeout 或 failed 均不自动重试）；「再次生成」= 用户显式新建 Figure + Job。
- 超时：`AUTOFIGURE_JOB_TIMEOUT_MS`，默认 30 分钟，经既有 config boundary 配置（不散落 hard-code）。
- **超时自进入 running 起算**，不含 queued 等待时间；超时 → 确定性 failed，不停留 running。
- 崩溃恢复：succeeded/failed 保留；queued 不因重启丢失；遗留 running 启动时 reconcile → failed（携带稳定的中断/reconcile 原因）。
- **合法转换仅限**：queued→running、running→succeeded、running→failed；**明确拒绝** failed→succeeded、failed→running、succeeded→running、succeeded→failed（succeeded/failed 为终态；唯一 reconcile 例外 = 启动时遗留 running→failed，见上）。
- **迟到结果围栏（关键不变量）**：Job 已进入 failed（超时/中断/reconcile）后，Python 迟到的成功 XML/PNG **不得**把终态 failed 转回 succeeded，也**不得**把迟到产物发布为成功 Figure；迟到结果一律丢弃、状态不变。
- 超时**不删除** Figure（Figure 独立于 Job 终态持续存在）、**不自动重试**。

### 3. 公开 API 契约（grilling §9）

- **`POST /figures`**：校验认证 + 输入 → **原子持久化 Figure + queued Job**（两者必须一起成功；持久化失败 → 请求返回失败信封，绝不返回成功 queued 结果）→ **HTTP 200 信封**（遵循全局信封不变量），`data` 含 `{figureId, jobId, status:'queued'}`。语义等价 202 Accepted，**不引入 HTTP 202 特例**。
- **幂等契约（V1 已批准，完整条目见 grilling §17）**：
  - POST /figures **必带 `Idempotency-Key` 请求头**（缺失 → 校验错误）。
  - 幂等键**按认证用户作用域**：`(userId, idempotencyKey)` 唯一；userId **只由认证上下文派生**，客户端不得随幂等身份发送 userId；不同用户可用同一 key（互相独立作用域）。
  - 幂等关联**持久化于 SQLite/Prisma**，survive researcher-service 重启；**不得**用进程内存 map 实现。
  - 首次有效 POST：校验认证 → 校验 prompt → **同一逻辑原子创建边界**内持久化 Figure + 其 1:1 queued Job + 幂等关联。
  - 同用户 + 同 key + **语义相同输入**重放：**不**再建 Figure/Job，以 HTTP 200 信封返回已创建的 Figure/Job 及当前应用级状态（原始 Job 无论 queued/running/succeeded/failed 均正确）。
  - 同用户 + 同 key + **不同输入**：拒绝，返回稳定 Figures 域**幂等冲突**错误（按「41 冲突」锁式落 7xxxx 段）；**不得**静默返回旧资源、不得覆盖/改写原 Figure 或 prompt、不得建第二个 Figure/Job。
  - V1 比较输入 = 规范化 text-to-figure 创建载荷（**至少**含用户可见 prompt 及影响生成结果的其他 V1 请求字段）；**不含** userId（已在作用域内）、provider 凭证、时间戳、内部 Job 字段、服务端生成 ID。
  - 实现可持久化规范化请求字段**或**确定性 fingerprint/hash；规格要求**确定性比较语义**，不强制特定哈希算法（除非仓库约定要求）。
  - 幂等键**仅 POST /figures 必填**；**不**引入平台级通用幂等框架。
  - V1 **无**自动过期/TTL：幂等关联随对应 Figure 存续；未来保留/删除需求另行定义。Figure 删除后的幂等键复用语义 **V1 不定义**。
  - **成本保护不变量**：同 key 的多次投递/重试/双击 ⇒ **至多一个 Figure、至多一个初始 GenerationJob**。
- **`GET /figures`**：当前认证用户自己的 Figure 历史（以 Figure 为单位，非 Job；admin 返回所有用户，见 US15 / grilling §3）。
- **`GET /figures/:id`**：Figure metadata + 应用级生成状态。
- **`GET /figures/:id/png`**：仅 owner、仅 succeeded 可下载；未完成/失败给明确应用级响应，不返回模糊 500。
- 失败保留**非敏感**错误信息（前端稳定失败态），不暴露 provider secret / raw stack trace / Python internals。读路径仅透出 runner 写侧**白名单稳定原因**（超时/中断/执行异常，见 T04），白名单外内容一律归为通用非敏感原因（纵深防御；T07 适配器须把新原因显式映射进白名单）。
- **归属与防探测**：`ownerId` **只由认证的 researcher-service 身份派生**（JWT），永不来自客户端提交的 userId；`GET /figures` 只返回当前认证用户的 Figure（admin 例外：返回所有用户，见 US15 / grilling §3）；`GET /figures/:id` 与 `GET /figures/:id/png` 对「不存在 vs 他人资源」复用既有 `getInstanceForUser` 同款模式**同码防探测**（70040）。

### 4. 错误码（grilling §9，已核实 `codes.ts`）

- 新段 **`7xxxx`**。既有 REST 信封码段为 0/1/2/3/4/6/9；`5xxxx` 并非信封段（chat 错误经 WS close codes 4401–4404/1011/1008 表达）；`7xxxx` 空闲可用。
- 锁式对齐既有各域：`70040` = 不存在/越权同码；冲突/重复类按「41 冲突」惯例。确切码值/常量名由实现对照 `codes.ts` 定准。
- 凭证缺失类可复用系统段「未配置」锁式（对齐 LLM_NOT_CONFIGURED 语义），不新造段。
- 校验失败复用系统段 `90002`；未知错误兜底 `90000`；均不新造段。

### 5. 异步执行 / Job Runner（grilling §5）

- 执行必须异步于 HTTP 请求生命周期：POST 快速返回，不等 AutoFigure 完整生成结束。
- **SQLite/Prisma 是 Job application state 的唯一持久化事实源**；不以进程内存队列为事实源。
- **concurrency = 1**；V1 明确不支持 Python 并发执行。
- worker 从持久化的 queued jobs 领取工作；**queued→running 领取须原子**，一个 GenerationJob 从 queued 被成功领取**至多一次**（不出现两个执行体同时认领同一 Job；concurrency=1 + 持久化事实源下以原子状态迁移保证，不强制特定 SQL 实现）；**不建设通用 queue abstraction/framework**；runner 局部化到 AutoFigure 执行边界（可替换，未来可整体换 BullMQ 而 Public Figure API 不变）。
- **AutoFigure 不新增 Redis/BullMQ 依赖**（Redis 已存在于部署栈，为容器生命周期队列所用；本决策是「AutoFigure 不新增依赖」，非「面板无 Redis」）。

### 6. 凭证（grilling §4）

- **系统级共享凭证**：provider key 经服务端 config/env 注入，**不经请求体、不入 Job payload、不落盘**；凭证**永不出现于**浏览器请求/响应、Figure 记录、Job payload、日志、追踪、公开错误。
- **新配置域 `AUTOFIGURE_*`**（如 `AUTOFIGURE_LLM_KEY`），**不复用 `LLM_API_KEY`**（其语义为「注入 OpenClaw 容器的 key」）。
- v1 允许 provider：openrouter + gemini（README 默认）；bianxie 可选。
- **v1 无图片生成凭证**（无 enhancement）。
- 凭证由 worker 从服务端配置获取，Python 不管理、不持有、不暴露。

### 7. Python 边界（grilling §7）

- **形态**：内部 HTTP sidecar 容器，panel-net 内，**不暴露宿主端口**（私有/内部）。
- **Python 无状态**：每个 Job = 独立 AutoFigure session（创建→跑完→销毁），不持久化。
- **Python 不接收 researcher-service JWT、不接收 userId**；只收生成参数 + 服务端注入的 provider 凭证。
- **Python 不拥有 public Job 状态**；researcher-service 拥有对外生命周期/状态。
- 服务间信任：网络隔离（panel-net 私有）；凭证由 researcher-service 注入而非 Python 自主获取。
- 保留/复用 AutoFigure Python 生成能力而非盲目重写算法；适用许可/署名要求保留。
- 仅桥接 **V1 最小生成契约**（text-to-figure 单次生成）到 sidecar；AutoFigure 独立 Flask API 的其余端点**不接入**、不整体暴露。

### 8. 前端（grilling §8）

- **Vue-native**（既有 Vue3 + Element Plus）；不引入 React/Next iframe 或 sub-app。
- 新增 `AutoFigureView`（输入 → 预览 → 下载 → 历史），复用既有 auth store / 信封解析 / 轮询 / 下载卡先例。
- v1 UX 状态序列：输入 prompt → 提交 → **queued → running → succeeded | failed**（REST 轮询，粒度 = Job 状态）；历史列表 → 详情/重开 → PNG 预览/下载；**无假百分比进度**。
- **无 draw.io**、无手动画布；v1 的「预览」= 生成 PNG 渲染。
- 不复制 AutoFigure 前端壳（Next 页面结构、Tailwind/Radix、localStorage config 传递）。

### 9. 配置与 feature flag（grilling §12 + §16 已验证命名）

- **`AUTOFIGURE_ENABLED`** 布尔，默认关闭；装配点对齐既有条件挂载先例（flag 关闭时 AutoFigure 路由/worker/sidecar 依赖不装配）。
- flag 关闭时行为：公开 Figure 路由不装配（直接访问经既有 notFound 信封 90005）；前端不提供 AutoFigure 导航入口，直达访问映射为明确「功能未启用」提示（非裸 404）；Job runner 不启动；sidecar 依赖/装配不激活。
- 新增配置走 `config.ts` 唯一 env 读取模式：`AUTOFIGURE_*` env 归入 config 对象新子域（对齐 `fleet:` 子域先例）；超时经 `AUTOFIGURE_JOB_TIMEOUT_MS`。
- 路由组织遵循 researcher-service 的 Express 域/信封/防探测约定，**不**沿用 AutoFigure Flask 的 `autofigure_routes.py` 路由组织。

### 10. 部署（grilling §10）

- 新增第 4 镜像：`autofigure`（Python + Playwright chromium 构建期安装 + 依赖），走既有 GHCR 镜像管线。
- compose 增加 sidecar 服务（panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`）。
- **零 host 挂载**（ADR 0013）；config 入镜像。
- 不复制 AutoFigure 的 `start.sh`/`stop.sh`/Flask app 形态。

## Testing Decisions

**好测试的标准**：只测外部可观察行为，不测实现细节；一次断言一个行为面；生产实现可被测试替身替换而断言不变。

**测试接缝（已与用户确认）**：

- **主接缝（新增，唯一新接缝）：`AutoFigureGenerationPort`** —— 只代表外部 AutoFigure **计算能力**（text → generation → normalized result）：生产 = HTTP 调 sidecar；测试 = 内存 fake。经依赖注入（AppDeps 模式）供给 Job Runner，覆盖：状态机转换、领取原子性（至多一次）、30min 超时、启动 reconcile、幂等去重、错误→信封码映射；全程不依赖真 sidecar。**该 Port 不拥有** Job 生命周期/状态机/持久化/幂等/领取/reconcile/超时策略/归属/REST 信封（均属 researcher-service 应用/执行层）。**不为 Job 状态机另设第二架构 Port**；状态转换的聚焦纯函数测试允许，但不为测试发明通用 JobStateMachine 架构。
- **复用既有接缝：REST 信封接缝**（`setupTestApp` + `seedUser`/`seedAdmin` + `bearer` + 信封断言）——测公开 API：认证、归属门（越权同码）、信封形状、状态暴露、仅 owner+succeeded 可下载 PNG。
- **Python sidecar HTTP 契约（辅助，非新接缝）**：给定输入 → 断言响应 JSON 形状（schema 校验）；集成测试 mock 或真起 sidecar；**不补 AutoFigure 内部单测**。
- **E2E 门控 smoke（辅助）**：需真 sidecar + 真 key，自动探测门控（对齐 containers-smoke 门控模式）。
- **常规测试套件不需真实 provider 凭证**（fake Port + 门控契约覆盖）；超时测试经 config 注入短超时，**绝不等待真实 30 分钟**。
- **幂等验收测试**（grilling §17）：缺失 Idempotency-Key · 首次创建成功 · 同用户+同 key+同输入返回同 Figure · queued/running/succeeded/failed 各状态重放返回同 Figure · 同用户+同 key+不同输入 → 幂等冲突 · 不同用户+同 key 独立 · 幂等 survive 重启 · 重放绝不产生第二个 GenerationJob。

**被测模块与先例**：

| 被测模块 | 接缝 | 代码库先例 |
|---|---|---|
| Job Runner（状态机/超时/reconcile/幂等） | `AutoFigureGenerationPort` fake | wiki Port / 编排器 Port / `FileArchive` fake 范式 |
| 公开 Figure API（信封/归属/幂等/下载） | REST 信封接缝 | `setupTestApp` + seedUser 认证 HTTP 测试 |
| Python 契约 | sidecar HTTP schema | 既有契约测试 / 门控 smoke（containers-smoke） |
| config（flag/超时/凭证） | config 单测 | `config.test.ts` 校验 fail-fast 模式 |

**不测**：AutoFigure 内部 Python 单测；queue/worker/Python/BullMQ 实现细节；前端逐像素渲染。

## Out of Scope（V1 明确不做，grilling §13）

- 手动 draw.io 编辑 / 画布
- continue / refine（文本反馈迭代）
- finalize 独立操作（v1 只有 initial generation）
- enhancement / beautification
- paper / PDF 输入
- FigureProject（多图分组）
- FigureRevision（版本）
- 通用 operationType 抽象
- 每用户凭证 / 凭证管理 UI
- 共享（跨用户访问）
- **Figure / 生成记录删除**（V1 无删除 API；owner 与 admin 均无；无硬删/级联删除公开行为）
- 用量配额
- 对象存储 / 分布式产物存储
- SSE / WS 进度（v1 仅 REST 轮询，粒度 = Job 状态，无中间百分比）
- 自动重试
- Python 并发（concurrency > 1）
- 通用 Job 管理 UI

## Further Notes

- **事实依据**：异步必需由 nginx `/api/` 代理 300s 超时事实决定（`frontend/nginx.conf:49-50`）；凭证服务端化由 AutoFigure 硬性请求体 `api_key` 事实决定（`autofigure_routes.py:366`）；两者均在 reconnaissance.md 核实。
- **约束来源**：本规格所有条目均来自 grilling-decisions.md 已批准内容；§16 已核实的命名约定（config 声明 / feature flag / Prisma 命名 / 路由组织）直接引用。
- **发布**：本文档拟发布为 GitHub issue（issue tracker），加 `ready-for-agent` triage 标签；发布由用户手动执行（`gh` 未在当前环境安装）。
- **基线**：researcher-service `e1234eb`（宿主演进中）、AutoFigure `454ee86`、skills `8b78b53`；详见 reconnaissance.md。
