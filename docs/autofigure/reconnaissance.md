# AutoFigure 集成侦察 —— 事实发现文档（reconnaissance）

> 状态：**只读侦察的事实记录**。本文件记录观察到的事实与既有约束；文中所有「候选方案 / 设计问题」均为**未获批候选设计**，不代表已决策的架构。
> 产生方式：只读侦察（direct reads + 5 个并行 Explore agent）。本阶段未修改、未创建除本文件外的任何文件，未复制 AutoFigure 代码，未创建 ticket，未写集成规格，未创建 ADR。
> **集成目标：`ResearAI/AutoFigure`。**
> **重要澄清：** `docs/research/autofigure-edit-codebase.md`（issue #348）深读的是**姊妹项目 AutoFigure-Edit**（不同代码库：FastAPI + SSE 子进程 + SAM 五步管线），**不是**本次集成的实现来源。本文件仅以本仓库 `ResearAI/AutoFigure` 为事实源。

## 基线（固定，不可漂移）

| 仓库 | 角色 | HEAD |
|---|---|---|
| researcher-service（`ACautomata/researcher-service`） | 宿主 | `e1234ebfff311cebc48f93ae87e44a3d71a61267` |
| AutoFigure（`ResearAI/AutoFigure`） | 集成目标 | `454ee868b9e253d2dbf990b42c4e964b93e498fd` |
| skills（`mattpocock/skills`） | 工程流程参考 | `8b78b531ab965735c5dc74f6f7a219e1e37326df` |

---

## 1. 观察到的事实（Observed Facts）

> 本节只陈述可核对的事实（含文件路径/符号），不含方案建议。代码路径均为仓库根相对路径；AutoFigure 行号为侦察时读取值，可能随版本漂移。

### 1.1 researcher-service 当前架构（A–H）

**形态**：Vue3(TS) 前端 + TS/Express 5 控制面，前后端分离，同进程 WS。`server/` 与 `frontend/` 为两个独立 npm 包。

**后端分层**（`server/src/app.ts` `createApp` 工厂，依赖经 `AppDeps` 接口注入；`app.ts:38`）：
- 中间件链（`app.ts:42-51`）：wiki/files 5MB carve-out → 全局 256kb json → cookieParser → `req.prisma` 注入。
- 路由挂载（`app.ts:53-76`）：`/api` health、`/api/v1/auth`、`/api/v1/users`、`/api/v1/trace-logs` 无条件；`/api/v1/containers` 按域**条件挂载**（orchestrator/models/files 依赖注入才挂，缺依赖在装配期 fail-fast）。
- 信封（`server/src/envelope.ts`）：所有 REST 一律 HTTP 200，响应体 `{code,message,data}`；错误由 `middleware/errorHandler.ts` 的 `envelopeErrorHandler` 唯一收口。
- 错误码段（`server/src/codes.ts` `CODE`）：`0` 成功 · `1xxxx` 通用/鉴权 · `2xxxx` 容器 · `3xxxx` wiki · `4xxxx` models · `6xxxx` files · `9xxxx` 系统/校验。
- 域划分：auth / users / containers / wiki / models / chat / files / traceLogs。

**外部交互收敛点（关键事实）**：仓库**零** `child_process`/spawn/Python 子进程先例。全部外部交互 = ①dockerode 仅作用于 OpenClaw 容器（生命周期/文件/exec），②BullMQ 内部队列（`container-lifecycle`），③一条纯透传 WS 隧道。**无「起第三方容器」通用先例**。

**认证/JWT 流**（B）：
- 签发 `server/src/auth/tokens.ts:17` `signAccessToken`：jose HS256，claims `{sub, jti, exp(5m), iss, aud}`，**不含 role**。
- 验证 `server/src/auth/authenticate.ts`：验签 → 查 `users.isActive` → 投影 `AuthUser`。
- refresh(R1 旋转)：opaque 32 字节，DB 只存 sha256（`tokens.ts:50`）；`routes/auth.ts` `rotateRefresh` 条件撤销 + 重放检测（族灭）。
- 入口 `middleware/auth.ts:11` `requireAuth` → 各 router `use(requireAuth, mustChangePasswordGate)`。
- **无 JWT 黑名单**；吊销靠 DB 状态（`users.isActive`/refresh 撤销）。

**授权与所有权**（C）：
- 双角色 `Role` enum admin/user（`prisma/schema.prisma`）；admin-only 用 `requireAdmin`（`middleware/auth.ts:31`）。
- **容器归属单点**：`server/src/containers/orchestrator.ts:74-91` `getInstanceForUser(prisma, user, name)` —— 不存在抛 `20040`；`user.role!=='admin' && inst.ownerId!==user.id` 也抛 `20040`（**同码防探测**，不区分「不存在 vs 越权」）。WS 隧道复用同一门（`chat/tunnel.ts`）。
- 同码矩阵：`20040/30040/40040/60040/10041`。
- 配额：`userService.ts` `assertQuotaValid` + `maxContainers`。

**前端**（D）：Vue3 + vue-router + Pinia + Element Plus + Vite。路由守卫 `frontend/src/router/index.ts` `beforeEach` 内 `await auth.hydrate()`（httpOnly refresh cookie 恢复态）；`decideGuard` 判 `meta.requiresAdmin`。会话 token 存内存 Pinia，不落 localStorage。API 层 `frontend/src/api/client.ts`：解信封 + 401 刷新链 + `singleFlightRefresh`（第 62 行并发去抖）。chat 协议机走官方 `@openclaw/gateway-client/browser`。

**后端/API**（E）：无统一注册函数；每域一个 `Router()`/`createXxxRouter(deps)`，handler 内 `ok(res,data)` 或 `throw fail(code)`。新域新增需：zod schema（`validation/schemas.ts`）→ CODE 常量 → `routes/<域>.ts` → `app.ts` 挂载 + 扩展 `AppDeps`。持久化 Prisma 7 + better-sqlite3 driver adapter（`src/prisma.ts`），建表经 `scripts/apply-schema.mjs` 读 `prisma/init.sql`。files（ADR 0012）：`files/fsPort.ts` `FileArchive` Port（`read/write/create/delete/readConfig/writeConfig`），经 dockerode getArchive/putArchive/exec rm（`files/dockerArchive.ts`），被 files/wiki/models 复用；root=`wiki|workspace`（`files/values.ts` `FILE_ROOTS`）。chat（ADR 0006）：`chat/tunnel.ts` `/ws/chat/` JWT subprotocol 握手 + 归属门 + **原样透传原始帧**（零解析/零翻译）；关闭码 4401/4402/4403/4404。队列：`containers/lifecycleQueue.ts` Port + `bullmqQueue.ts`（queueName `container-lifecycle`，concurrency 2）；任务句柄存进程内 Map，崩溃靠读路径 lazy 对账。

**配置边界**（F）：唯一 env 读取处 `server/src/config.ts`；生产 fail-fast（`JWT_SECRET≥32`、`BCRYPT_COST=12`、`OPENCLAW_TEMPLATE_DIR`/`PANEL_PUBLIC_ORIGIN`/`CREDENTIAL_ENCRYPTION_KEYS` 缺失拒启动）。凭证：`LLM_API_KEY` 全面板共享 env 注入 OpenClaw 容器（不落盘）；`CREDENTIAL_ENCRYPTION_KEYS` AES 加密 gateway token 落盘密文。

**部署/网络**（G）：prod `deploy/docker-compose.deploy.yml`（name `panel`）：BaoTa 边缘 TLS → `127.0.0.1:18080` frontend nginx（唯一对外，反代 `/api/` 300s、`/ws/` 3600s+Upgrade）→ `panel-server:8001`；server 挂 `docker.sock`（**唯一宿主挂载**，ADR 0013）+ `panel-db` 卷 + `host.docker.internal` 寻址宿主发布的 fleet 端口 19000-19999；`panel-redis` 仅内部。镜像三件（`.github/workflows/cd.yml` → GHCR `server/frontend/openclaw`）；CD scp compose+.env 到 `/www/panel/` + SSH up + `/api/health` 门。dev `docker-compose.dev.yml`（name `panel-dev`）：server+redis 同形态，暴露 `127.0.0.1:8001` 给宿主 vite。**零 host 挂载（仅 docker.sock）；配置入镜像、静态**；OpenClaw 容器 named volume 拓扑（ADR 0011/0013）。

**测试接缝**（H）：vitest；接缝 1–5（AGENTS.md）：wiki Port / 信封 REST / WS 桥 / hostDeps / 编排器 Port。注入模式：`test/setup.ts` 临时 SQLite；`test/fleetTestUtils.ts` `makeFleetTest` 假 docker + 内存队列；`test/tunnel.test.ts` `FakeGateway`；`AppDeps` 缺省 = 无编排（路由不挂）。门控：containers-smoke 需真 docker daemon、BullMQ 用例需真 Redis。

### 1.2 AutoFigure 当前架构（I–R）

**形态**：Python SDK（`autofigure/`）+ Flask 后端（`backend/`）+ Next.js 前端（`frontend/`）三件套；`start.sh` 本地一键起（backend :8796 + frontend :6002）。

**后端**（I）：`backend/app.py`（Flask）+ `backend/autofigure_routes.py`（73KB，Blueprint `autofigure_bp` url_prefix `/api/autofigure`）。**无鉴权**：`verify_token`（路由 L168）不校验签名，任意/空 token 放行，无 token 记 `'anonymous'`。CORS 白名单仅 localhost。

**前端**（J）：Next.js 16 App Router；`/autofigure`（`AutoFigureStartPage`：输入、topic 下拉 paper/survey/blog/textbook、PDF 上传）+ `/autofigure/canvas`（react-drawio iframe + GenerationOverlay + IterationControlsFloating + BeautificationDialog + EnhancedImageGallery）。状态中枢 `frontend/contexts/autofigure-context.tsx`；config 经 `localStorage['autofigure-pending-config']` 跨页传。画布 baseUrl 默认 `https://embed.diagrams.net`（外部第三方服务），`NEXT_PUBLIC_DRAWIO_BASE_URL` 可覆盖。

**前端 API 依赖图**（K）：`getBackendUrl()` = `NEXT_PUBLIC_AUTOFIGURE_BACKEND_URL || NEXT_PUBLIC_BACKEND_URL || "http://localhost:8796"`。

| 触发 | 请求 | 时机 |
|---|---|---|
| `startGeneration` | POST `/api/autofigure/session/create` → POST `/session/{id}/start` | canvas 挂载后，start **同步阻塞**跑 LLM |
| `continueIteration` | POST `/session/{id}/continue` | 用户点 Continue（带 `current_xml`+反馈） |
| `finalizeLayout` | POST `/session/{id}/finalize` | 点 Polish/Finalize |
| `startEnhancement` | POST `/session/{id}/enhance` | 美化对话框（后台线程） |
| 轮询 | GET `/session/{id}/enhance/status` | 2s 轮询，最多 300 次 |
| `handleGenerateImage` | POST `/api/autofigure/generate-image` | 浮层「生成图片」 |
| PDF | Server Action `convertPdfToMarkdown` | 先远程 `PDF_API_URL`，失败本地 `unpdf` |

**API key 路径**：前端 Settings 输入 `config.apiKey`/`image_gen_api_key` 等**明文进 POST body** → backend 传 Python 核心。backend `reset_autofigure_config()`（路由 L209）每次 start 前清空所有 provider key 防跨 session 串扰。

**后端职责**（L）：session 管理 + 每请求一轮的生成编排 + base64 PNG 回传。端点清单：`/api/autofigure/health, session/create, session/<id>/start|continue|finalize|enhance|enhance/status|(GET/DELETE), generate-image`。**session 为进程内内存 dict（无 DB、无持久化）**，代码自注「in production, use Redis or database」。

**核心 Python 包**（M）：
- `generator.py`：`figure_generator_pipeline`（L1809，SDK 多轮 Review-Refine 闭环，CONFIG `MAX_ITERATIONS=5` / `QUALITY_THRESHOLD=9.0`）；`generate_initial_code`（L638）/`evaluate_code`（L1437）/`improve_code` 全经 `call_unified_llm`（L93）→ `_call_openai_compatible`（L154，openai SDK multimodal，PIL 图 base64）；prompt 模板硬编码 8 套（`get_initial_prompt_template` L266）；PNG 转换 `code_to_png`（L1332）：SVG→cairosvg，mxGraph→`_export_via_playwright`（L1167，每次调用内 launch chromium + 内嵌 `embed.diagrams.net` iframe）。
- `agent.py`：`AutoFigureAgent.generate/generate_from_paper`（SDK 公开 API）；SDK 路径落盘 `./autofigure_output`。
- `enhancer.py` `ImageEnhancer`（L248）：按 provider（openrouter/bianxie/gemini）调图片模型；`convert_code_to_text2image_prompt` 做 code2prompt。
- `extractor.py` `MethodologyExtractor`（L46）：PyMuPDF/pdfplumber 读 PDF → `LLMClient` 抽方法学。
- `judge.py` `VLMJudgeEvaluator`（google.genai，硬编码 `gemini-3.1-pro-preview`）——**不被后端在线链路使用**。
- `config.py` `Config` dataclass（provider 默认 openrouter，bianxie/gemini 可选；`from_env()` 读 `AUTOFIGURE_*` env）。

**生成生命周期**（N）：Web 模式为「每请求一轮、前端循环驱动」：start 同步生成初始 XML（1 轮 eval）→ base64 PNG；continue 传 `current_xml`+`human_feedback`/`human_score`，超 `max_iterations` 400、`score>=quality_threshold` 返回 `status:'quality_threshold_reached'`，否则 `improve_code`；enhance 后台线程 + 2s 轮询。SDK 模式 `figure_generator_pipeline` 完整闭环（best_score≥threshold 或 improvement<MIN_IMPROVEMENT 提前退出）。

**状态/存储/artifact 假设**（O）：Web 模式无业务文件落盘，结果 **base64 PNG 内嵌 JSON** 回传；临时文件 `tempfile.NamedTemporaryFile` 用后 unlink；session 在内存。SDK 模式落盘 `./autofigure_output`。Playwright 无持久实例，每次 launch/close。**无 artifact URL 概念**。

**外部依赖与凭证**（P）：openai/anthropic/google-genai/Pillow/cairosvg/PyMuPDF/pdfplumber/requests/playwright/easyocr/numpy/pandas/python-pptx/Flask/flask-cors。外部服务：openrouter、gemini、bianxie、**embed.diagrams.net**、PDF `PDF_API_URL`。`backend/.env.example` 只有注释无任何 key；key 全由前端 POST body 传入；`judge.py` 读 `GOOGLE_API_KEY` env。**anthropic/easyocr 声明未用**。

**部署/启动假设**（Q）：`start.sh` 杀端口 → pip install → npm install → nohup 起 backend/frontend；**不跑 `playwright install chromium`**。backend 无 Dockerfile；仅 `frontend/Dockerfile`（Next standalone）+ `frontend/docker-compose.yml`（drawio + next）。`next.config.ts` rewrite `/backend/:path*` → `http://127.0.0.1:8796`。

**测试与可观测**（R）：**零测试**（无 `tests/` 目录，pyproject 声明 testpaths 但无代码）。可观测接缝：`/health`、`/api/autofigure/health`、`/enhance/status` 轮询；无 structured 日志协议。

### 1.3 端到端请求流（S–T）

**AutoFigure**（S）：用户输入 + topic + Settings 填 API key → `frontend/app/autofigure/page.tsx` `handleGenerate` → `localStorage['autofigure-pending-config']` → `/autofigure/canvas` → `autofigure-context.tsx` `startGeneration` → POST `session/create` + `session/{id}/start`（同步阻塞）→ backend：`extract_methodology`（paper）/`generate_initial_code` → `code_to_png`（cairosvg | playwright + embed.diagrams.net）→ `evaluate_code` → JSON `{xml, png_base64, evaluation}` → 灌入 react-drawio。用户编辑 → `continue`（传 current_xml+反馈）→ `improve_code` → 新 xml/png；Polish → `finalize`；Beautify → `enhance` + 2s 轮询 → `EnhancedImageGallery` → 下载 PNG。

**researcher-service**（T）：浏览器 → nginx(:18080) → server:8001 → `POST /api/v1/auth/login` → JWT(HS256,5m)+refresh(7d,DB sha256) → 后续请求 `Authorization: Bearer` → `requireAuth` → `authenticate` → `mustChangePasswordGate` → handler → 容器类操作经 `getInstanceForUser`（归属门，同码防探测）→ 信封 `{code:0,data}` → 前端 `apiJson` 解包。WS `/ws/chat/`：subprotocol JWT 握手 → 归属门 → 连接容器网关 → 原样透传原始帧。

---

## 2. 既有架构约束（Existing Architectural Constraints）

> researcher-service 对集成**有约束力**的既有决定。这些是事实（已落盘 ADR/代码），不是本文件新提出的方案。

1. **配置单一来源 / 凭证边界**（ADR 0005）：`server/src/config.ts` 是唯一 env 读取处，生产 fail-fast。LLM key 全面板共享、只经 env 注入、不落盘；敏感值不经浏览器/请求体。
2. **零 host 挂载**（ADR 0013）：仅 `docker.sock` 是唯一宿主挂载豁免；工作数据走 named volume；配置入镜像、静态。
3. **浏览器直连网关是唯一例外**（ADR 0006）：`/ws/chat/` 隧道只对 OpenClaw 网关协议生效（JWT 握手 + 原始帧透传），**非通用代理**；且必须先设备配对。
4. **归属单点**：`getInstanceForUser` 是容器归属唯一入口，同码防探测（20040/30040/40040/60040）。
5. **信封与错误码**：所有 REST 一律 HTTP 200 + `{code,message,data}`；新增能力必须接入该体系（含 5MB carve-out、256kb json 上限）。
6. **域结构**：每域独立 Router + `AppDeps` 注入 + zod schema + CODE 常量；条件挂载。
7. **持久化**：SQLite 单库 + Prisma 7 + `apply-schema.mjs` 增量 upgrade；无文档/对象存储先例（产物现经 FileArchive/dockerode 访问容器内文件）。
8. **所有权模型**：`User`/`Container`（ownerId）是仅有的所有权轴；admin 万能 + user 单容器归属。
9. **审计**：`TextTraceLog` 是既有生成内容溯源机制（含 inputText/outputText/outputHash/ipAddress）。
10. **防腐层取向**（ADR 0002）：Port + Adapter + Translator，标识符保留原样，不追求 vendor-neutral。
11. **CI/CD**：三镜像 GHCR + 宝塔宿主 scp/SSH + `/api/health` 门；buildx 多 context 注入模板/配置。
12. **部署网络**：panel-net 内部网络；server 不对外暴露端口（除 dev loopback）。

---

## 3. 候选集成接缝（Candidate Integration Seams）

> ⚠️ 以下均为**候选**（尚未获批），供后续设计阶段评估，不是决策。

### Z1 新 REST 域路由 + 服务端调用 AutoFigure
- **既有边界**：`app.ts` 路由注册 + `AppDeps` 注入 + zod + codes —— 面板新增能力的既定扩展点（照 models/files 条件挂载模式）。
- **跨接缝内容**：带 JWT 的浏览器请求 → 新路由（如 `POST /api/v1/figures/generate`）→ 适配器 → AutoFigure Python 能力 → 信封响应。
- **候选优点**：复用现有鉴权/授权/信封/校验/错误码；满足认证贯通、归属、信封约束；适配器 Port 可注入 fake，可测试性强（照 tunnel/orchestrator 测试范式）。
- **候选代价/风险**：需新适配器契约；Python 侧为同步阻塞（见 Z4）。

### Z2 Python 作为独立容器/sidecar（panel-net 内部）
- **既有边界**：compose 服务编排 + panel-net 桥接；server 已是控制面。
- **跨接缝内容**：Express 侧经内部 HTTP 调 Python 容器（如 :8796 或新端口）；产物经 base64 回传或经 named volume 交换。
- **候选优点**：满足「浏览器不直连 Python」（约束 #4）；满足 ADR 0013 零 host 挂载；保留 Python 实现（约束 #5）。Playwright chromium 装入 Python 镜像。
- **候选代价/风险**：新增 compose 服务 + 内部 DNS 名；镜像体积大；Python 侧无测试套件需补。

### Z3 复用 FileArchive Port 做产物交换
- **既有边界**：`files/fsPort.ts` `FileArchive`（getArchive/putArchive/exec rm），已跨 files/wiki/models 复用。
- **跨接缝内容**：若 Python 容器内，researcher-service 用 FileArchive 读生成产物/写输入；用户经既有 files 端点取图。
- **候选优点**：一致性、测试接缝现成。
- **候选代价/风险**：AutoFigure 现为 base64 内联，需改 Python 或加适配层落盘到可 getArchive 的容器路径。

### Z4 BullMQ 新队列承载长生成任务
- **既有边界**：`containers/lifecycleQueue.ts` Port + `bullmqQueue.ts`（queueName `container-lifecycle`）。
- **跨接缝内容**：生成任务入队、进度、取消；**需新 queueName**（不复用 `container-lifecycle`）+ 任务状态持久化（既有任务句柄在内存、重启即失，与长任务语义不符）。
- **候选优点**：复用既有队列基建；把同步 start 改造成提交→轮询/进度→取产物。
- **候选代价/风险**：需扩展队列 Port（进度/取消语义），新增 worker + 任务表。

### Z5 前端：Vue 重写 vs 同源 iframe 托管 AutoFigure React
- **Z5a 重写 Vue**：复刻交互模式到 Element Plus；draw.io 走自托管容器。一致性最好、工作量最大。
- **Z5b 同源 iframe**：面板 nginx 增 `/autofigure/*` 静态托管 AutoFigure 构建产物；postMessage 桥做鉴权/进度。工作量最小、双前端壳 + 两套登录态。
- **候选风险**：跨栈长期维护成本、登录态贯通、桥接协议。

### Z6 draw.io 画布：自托管 vs 外部 embed
- **自托管**：面板已能编排容器，可起 `jgraph/drawio` 容器（panel-net 内）+ `NEXT_PUBLIC_DRAWIO_BASE_URL` 指向内网。**隐私受益**（图内容不出内网）。
- **外部 embed**：零运维，但每次画布渲染把图内容发给 diagrams.net。

---

## 4. 风险（Risks）

### 4.1 技术风险
- R1 同步生成（README 自述 ~$0.50/20min/30k tokens per run）占满 HTTP：不任务化会拖垮控制面。
- R2 Playwright 渲染在容器内的稳定性/资源（每调用 launch chromium）。
- R3 mxGraph XML 结构约定（viewBox/placeholder 等模型相关约束）对换模型的脆弱性。
- R4 双栈前端（Vue+React）长期维护成本。
- R5 AutoFigure **零测试**，移植即引入未验证代码。
- R6 内存 session 无并发隔离；多用户时需 per-job 化。

### 4.2 安全风险
- S1 若配置不当，Python 服务被浏览器直连 → 无鉴权 + 任意 API key 注入（约束 #4 违反）。必须仅内网监听 + 服务端侧调用。
- S2 API key 若继续由浏览器传入，任何 XSS/中间层都能窃取；需服务端持有。
- S3 第三方外联（embed.diagrams.net / PDF_API_URL / LLM 服务）会把用户论文/图内容外发；需白名单/自托管策略。
- S4 base64 大响应 + 大模型输出 → 请求体/内存上限需纳入信封体系。
- S5 Python 镜像依赖供应链（Pillow/playwright/openai 等）与镜像审计。

### 4.3 迁移风险
- M1 把同步 Web 流改造成队列任务流，改变 AutoFigure 前端契约（需前后端同步改）。
- M2 产物从 base64 迁移到存储，影响展示链路。
- M3 前端迁移（React → Vue 或 iframe）涉及交互模式重造。
- M4 CD/镜像管线新增 Python 镜像；buildx 多 context 已有先例可复用。
- M5 数据模型新增表与既有 SQLite 增量迁移流程（`apply-schema.mjs`）衔接。

---

## 5. 未决问题（Open Questions）

### 5.1 信息缺口（事实不足，无法定论）
1. **AutoFigure vs AutoFigure-Edit**：集成目标到底是哪个？（本文件按 AutoFigure 分析；若目标是 AutoFigure-Edit，端点/生命周期完全不同。）**待用户确认。**
2. **目标模型/key 情况**：README 推荐 `gemini-3.1-pro-preview` + `gemini-3.1-flash-image-preview`；面板是否已有可用 key/provider？与 `LLM_API_KEY` 的关系未定。
3. **生成能力优先级**：text-to-figure / paper-to-figure / enhancement / draw.io 编辑，先通哪条？
4. **产物形态**：SVG vs mxGraph XML vs PNG；用户从面板如何取走结果（下载/进 wiki/进 workspace）。
5. **多用户并发**：单 Python 实例 vs 每用户隔离；会话生命周期。
6. **draw.io 自托管资源**：`jgraph/drawio` 镜像大小、内存占用。
7. **Python 镜像体积与 CI 时长**：Playwright chromium 下载对 CD 的影响。

### 5.2 需在 /grill-with-docs 澄清的问题
1. 确认参考仓库身份与集成目标能力集。
2. 认证与凭证模型：服务端 key vs 每用户加密 key？provider 白名单哪些进生产？复用 `LLM_API_KEY` 还是新配置域？
3. Python 部署形态：独立容器 vs server 内嵌；端口/网络/命名。
4. 任务模型：同步→异步队列的改造范围；进度通道（REST 轮询 vs WS）；取消语义。
5. 产物所有权：数据模型设计；是否挂 `TextTraceLog` 审计；产物存 SQLite 还是 FileArchive 磁盘。
6. 前端形态：Vue 重写 vs iframe 托管；登录态贯通方式。
7. draw.io 自托管 vs 外部 embed 取舍（隐私/运维）。
8. 授权边界：生成能力对 admin/user 的可见性；是否需配额（仿 `maxContainers`）。
9. 许可/署名落地：`CITATION_AND_ATTRIBUTION.md` / `TRADEMARK.md` 如何在产品中呈现；品牌命名避免「AutoFigure」作主品牌。

---

## 6. 未获批候选设计（Unapproved Candidate Designs）

> ⚠️ 本节内容**均未获批**，仅为候选方向。下面 12 项是从侦察中浮现的**设计问题**（decision questions），每一项都必须经过设计阶段单独裁决，**本文件不预设答案**。

1. **BullMQ vs 其他异步执行模型**：既有 `bullmqQueue.ts` 是候选，但长任务持久化/进度/取消语义需扩展；是否引入替代模型（原生 worker、任务表轮询等）未定。
2. **Python 部署拓扑**：独立容器（panel-net）vs server 内嵌子进程 vs 其他 —— 未定。
3. **是否必须 named volume**：ADR 0013 语境下工作数据的持久化载体 —— 未定。
4. **Figure / FigureJob / Project 聚合设计**：数据模型形态（表结构、归属轴、生命周期状态）—— 未定。
5. **artifact 持久化策略**：SQLite BLOB vs FileArchive 容器内磁盘 vs 其他 —— 未定。
6. **全局服务凭证 vs 每用户加密凭证**：对照 ADR 0005（全局共享 env）与 ADR 0001（`CREDENTIAL_ENCRYPTION_KEYS` 加密落盘）—— 未定。
7. **Vue 原生移植 vs React/iframe 策略**：Z5a vs Z5b —— 未定。
8. **外部 vs 自托管 draw.io**：Z6 两分支 —— 未定。
9. **进度传输**：REST 轮询（仿 ContainersView 3s 轮询）vs WS 通道 vs 其他 —— 未定。
10. **取消语义**：生成/增强中取消是否支持、如何终止 Python 侧工作 —— 未定。
11. **首个 walking skeleton 同步还是异步**：是否第一版就引入任务队列 —— 未定。
12. **TextTraceLog 是否是正确的审计机制**：既有表是否适合生成溯源，或需新审计模型 —— 未定。

### 概念性 walking skeleton（仅示意，**未获批、不得实现**）

> 目标：示意「认证浏览器 → researcher-service 边界 → 集成接缝 → AutoFigure 能力 → 结果」的最小闭环。**本段仅概念，不是已批准的设计，也不包含实现承诺。**

```
浏览器(JWT)
  → POST /api/v1/figures/generate  { topic, description, max_iterations, output_format }   ← zod 校验
  → requireAuth → mustChangePasswordGate → handler
  → FigureAdapter(generate)  [Port；生产 = 调 Python sidecar / 测试 = fake]
     → Python 容器(panel-net 内部)：session/create + start(同步 1 轮)
     → 返回 { xml, png_base64, evaluation }
  → 信封 {code:0, data:{ xml, png_base64, score }}
  → 前端 Vue 预览 + 「重试迭代」按钮
```

**最小跨度示意**：新 REST 域 `figures`（路由 + AppDeps + zod + 新码段）；Python sidecar 容器（compose dev+deploy 加服务，panel-net 内，key 经 env 注入）；`FigureAdapter` Port（生产 HTTP / 测试 fake）；单端点 `POST /generate`（仅 text-to-figure 初始生成，不接队列/增强/编辑）；前端一个预览组件；归属 `Figure.ownerId FK(User)` + trace 记录。

**概念上证明什么**：认证贯通、无浏览器直连、Python 计算保留、显式接缝、归属落库、许可文件入仓。**不覆盖**：队列/进度/增强/画布编辑/前端迁移。

> 上述 12 项 + walking skeleton 均须在后续设计阶段逐项裁决。**本文件不改动生产代码、不改动 ../AutoFigure、不创建 spec/ticket/ADR。**

---

## 附录 A：复用判定（分析，非事实）

> 由侦察推得的方向性分析，用于后续设计讨论；**非已批准决策**。

**可能复用**：Python 核心生成管线（`generator.py` 的 `generate_initial_code`/`evaluate_code`/`improve_code` + `call_unified_llm` 三层分发 + prompt 模板）；`config.py` `Config` dataclass 与 provider 默认值表；`extractor.py` 方法学提取；`enhancer.py` `ImageEnhancer`；`agent.py` SDK 完整闭环（可作批量/离线路径）；mxGraph XML 结构约定。

**需适配**：鉴权/凭证（verify_token 移除、key 服务端化、per-job 隔离）；同步→任务化；内存 session→持久化任务模型；base64→产物存储策略；CORS/localhost→panel-net 内部；前端 React→Vue 交互模式或 iframe；draw.io embed→自托管（建议候选）；Playwright 渲染 build 期装 chromium。

**明确不建议复制**：Flask 后端形态（CORS localhost、debug=True、同步端点+内存 session）；前端 React 应用壳（页面结构、Tailwind/Radix、localStorage config 传递）；外部 draw.io embed 默认值；`judge.py` 硬编码 google-genai（离线工具，不在在线链路）；未用依赖（anthropic/easyocr）；`start.sh`/`stop.sh` 杀进程模型。

## 附录 B：特别相关的既有代码（定位索引）

- 归属门：`server/src/containers/orchestrator.ts:74` `getInstanceForUser`
- 信封/错误码：`server/src/envelope.ts` / `server/src/codes.ts`
- Port 范式：`server/src/files/fsPort.ts` `FileArchive`、`server/src/containers/lifecycleQueue.ts` `LifecycleQueue`、`server/src/containers/runtime.ts` `ContainerRuntime`
- 队列基建：`server/src/containers/bullmqQueue.ts`
- 测试注入：`server/test/setup.ts`、`server/test/fleetTestUtils.ts`、`server/test/tunnel.test.ts`（`FakeGateway`）
- 审计表：`server/prisma/schema.prisma` `TextTraceLog`
- 前端先例：`frontend/src/views/ContainersView.vue`（3s 轮询）、`frontend/src/components/chat/ChatMessageItem.vue`（document 下载卡）、`frontend/src/views/ChatView.vue`（附件采集）
- 配置 fail-fast：`server/src/config.ts` `readSecret`
- 姊妹项目契约研究（方法论参考，非本集成实现源）：`docs/research/autofigure-edit-codebase.md`
