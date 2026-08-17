# T13 — Kimi Coding provider（AutoFigure sidecar 正式支持）

## Fixed point

`a696802b9e831b51b83f6329fed4378e15ea1090`（`feature/autofigure-integration` HEAD，T12 完成证据）。

正式分支：`feature/autofigure-kimi-provider`（自固定点新建）。实验分支
`experiment/autofigure-kimi-provider` 与 deepseek 实验 stash（`stash@{0}`）保留用于追溯，不触碰。

## Parent specification

- AutoFigure 集成规格：`docs/autofigure/spec.md` + `docs/autofigure/grilling-decisions.md`（Source of Truth）。
- sidecar 契约：`docs/autofigure/sidecar-contract.md`（T07 冻结，本票**不改契约**）。
- sidecar 本体：`deploy/autofigure-sidecar/`（T08；vendored 上游包 pin `454ee86`）。

## Motivation

T08 起 AutoFigure 仅支持 `openrouter` / `bianxie` / `gemini` 三个 provider（sidecar README env 表）。
真实兼容实验（见下）证明 **Kimi Coding API** 可作为 AutoFigure 的 OpenAI 兼容多模态 provider。
本票把该支持从「实验性 shim」升格为 **sidecar 侧正式 provider 值 `kimi`**：文档化、强制配置不变量、
确定性测试 + 门控真实 smoke 验证，且**不改 vendored 上游包、不改 researcher 侧任何代码**。

## Experimental evidence（真实兼容实验，已被 preflight 验证）

- **端点**：`https://api.kimi.com/coding/v1`（Kimi Coding API）。实验 credential **只对该端点认证**；
  对 `api.moonshot.cn/v1` / `api.moonshot.ai/v1` 均返回 401（已逐一实测）。
- **多模态 schema**：Kimi Coding API 接受 AutoFigure 的 `image_url` + `data:image/png;base64`
  引用图像结构（probe 200 + 视觉描述确认）。
- **thinking 模式**：`message.content` 已填充，上游 generator 读取路径可用。
- **完整链路**：AUTH → transport → reference-image multimodal → generation → render →
  evaluation → PNG persisted → `succeeded`，真实跑通（实验记录约 275s）。
- **模型**：`kimi-for-coding`（K2.7 Coding）为实验中验证通过的模型；`k3` / `k3-256k` 为同 API
  面候选（未逐一实测）。模型 ID 更新频繁 → **不作产品默认**。

## Formal provider contract

- `AUTOFIGURE_PROVIDER=kimi` 成为 sidecar 的**一等文档化 provider 值**（README env 表 + 文档节）。
- Wire 契约不变（T07 冻结）：成功 `{ok, xml, png_base64, evaluation}`；失败 2xx 内
  `{ok:false, error=<短不透明代码>}`。Kimi 是 provider 维度，非契约维度。
- 归属门 / 错误归一不变：researcher 侧所有失败仍归一 `GENERATION_EXECUTION_ERROR`。
- Kimi 是 **sidecar 级 transport 适配器**，不是 researcher 级功能；`server/`、`frontend/` 零改动。

## Accepted CONFIG-slot implementation strategy

vendored `autofigure/generator.py`（pin `454ee86`）的 `call_unified_llm` 对未知 provider 落
else(bianxie) 分支（generator.py:137-143），读 `BIANXIE_*` CONFIG 槽位，统一汇入
`_call_openai_compatible`（OpenAI 兼容 transport + `image_url` 多模态）。

**批准的内部映射**（`bridge._configure_generator` provider='kimi' 分支）：

```
LLM_PROVIDER    = "kimi"
BIANXIE_API_KEY  = api_key          # 请求级 X-Autofigure-Api-Key
BIANXIE_BASE_URL = base_url or "https://api.kimi.com/coding/v1"
BIANXIE_CHAT_MODEL = model          # 显式 AUTOFIGURE_MODEL，必填
```

- 复用 `BIANXIE_*` 槽位是**内部实现细节**：用户可见的 provider 是 `kimi`，**不把 BIANXIE
  呈现为用户可见 provider**。
- **不改 vendored `autofigure/**`、不新增 `KIMI_*` CONFIG 槽位、不改变默认 provider**。
  这是与「绝不修改 vendored 上游包」硬约束唯一相容的路径。

## Base URL policy

- **默认**：`https://api.kimi.com/coding/v1`——唯一在真实实验中验证通过的端点。
- **明确不默认到**：`api.moonshot.cn` / `api.moonshot.ai`（实验 credential 对二者均 401，
  Moonshot 端点不隐含支持）。
- 显式 `AUTOFIGURE_BASE_URL` 仍可覆盖默认（透传映射进 `BIANXIE_BASE_URL`）。

## Explicit-model policy

- `AUTOFIGURE_MODEL` 在 provider=`kimi` 时**必填**。无产品默认 model（视觉模型 ID 更新频繁）。
- 缺省 / 空串 → 在 OpenAI 兼容调用前**本地 fail-fast**：`bridge._configure_generator` raise
  `GenerationError('missing_model')` → wire `{ok:false, error:"missing_model"}`（稳定短不透明
  配置错误，不泄漏内部细节 / 凭证 / traceback）。
- `kimi-for-coding` 仅在文档中作为**已验证示例**，不作永久 / 默认 model 承诺。

## Credential policy

- 复用**唯一** credential：`AUTOFIGURE_LLM_KEY`（researcher `config.ts` 生产 fail-fast 读取，
  经 `X-Autofigure-Api-Key` header 请求级注入 sidecar；T07 契约）。
- **不新增** `KIMI_API_KEY` / `MOONSHOT_API_KEY` / 任何第二凭证路径；无每用户 provider 凭证支持。
- 凭证卫生延续：`redirect_stdout` 抑制上游 stdout、`finally` 恢复 CONFIG、失败码不透明、
  凭证绝不落盘 / 日志 / 响应 / XML / evaluation。

## Acceptance criteria

- [ ] `AUTOFIGURE_PROVIDER=kimi` 被接受为文档化一等 provider 值（README 已列）。
- [ ] `LLM_PROVIDER=kimi`；key / base_url / model 分别映射进 `BIANXIE_*` 槽位。
- [ ] base_url 缺省 = `https://api.kimi.com/coding/v1`；**不默认** moonshot 端点。
- [ ] model 缺省 / 空串 → `missing_model` 不透明失败，**OpenAI 调用不被触发**，CONFIG 还原。
- [ ] 凭证绝不出现在进程 stdout / wire 响应（含上游泄漏 key suffix 时）。
- [ ] CONFIG 在成功 / 失败后均还原基线（跨调用隔离）。
- [ ] 未知 provider 仍 `unsupported_provider`；openrouter / bianxie / gemini 映射不受影响。
- [ ] vendored `autofigure/**` 零 diff（实现后 git diff 验证）。
- [ ] 门控真实 Kimi smoke：researcher API → queued/running → sidecar → Kimi Coding API →
      succeeded → 有效 PNG signature（elapsed 记录；evaluation 真伪为已接受局限，见下）。
- [ ] 默认 provider 仍 `openrouter`；`server/**` / `frontend/**` / `sidecar-contract.md` /
      compose / requirements / T12 evidence / 既有 T01–T12 AC 零改动。

## Deterministic test seams

`deploy/autofigure-sidecar/service/tests/test_bridge.py`（conftest `_pipeline_stub` 桩化上游
三函数 + KNOWN_PNG/CANNED_XML/CANNED_EVAL；纯逻辑，无真 LLM / 网络 / 浏览器）。kimi 用例：
provider 接受 / key→`BIANXIE_API_KEY` / base_url 显式映射 / model 显式映射 / base_url 缺省
走 coding 端点 / 缺 model 与空 model 均 fail-fast（pipeline 不被触发 + CONFIG 还原）/
凭证不泄漏 / 未知 provider 仍拒 / 三既有 provider 回归不变 / 跨调用隔离。全量 29 用例通过。

## Gated real Kimi smoke

机制复用实验已验证路径（**不改 `figuresSmoke.test.ts`**）：构建 kimi-env sidecar 容器
（`AUTOFIGURE_PROVIDER=kimi` + `AUTOFIGURE_BASE_URL=https://api.kimi.com/coding/v1` +
`AUTOFIGURE_MODEL=kimi-for-coding`），loopback 发布（macOS Docker Desktop bridge-IP 不可达），
researcher smoke 经显式 `AUTOFIGURE_SIDECAR_URL` 指向之；门控 = docker 可用 +
`AUTOFIGURE_SMOKE=1` + `AUTOFIGURE_LLM_KEY` 非空（`server/test/smokeGating.ts` 三条件）。
断言：`succeeded` + PNG 8 字节签名。前置：真 credential（opt-in，本票不提供）。

## Evaluation fallback limitation（已接受）

上游 `create_fallback_evaluation(5.0)`（generator.py:1353）+ `evaluate_code` catch fallback
（:1557-1559）+ bridge `evaluation is None` fallback（bridge.py:167-168）：三处兜底均不抛异常，
`ok:true` 恒成立。现有门控 smoke 不断言 evaluation 内容 → **succeeded 不区分真实 LLM evaluation
与既有 fallback**。这是**全 provider 共通**、T10/T12 已接受的验证局限，非 kimi 特有。
本票**不**新增公开字段证明 provider evaluation、不全局禁用 fallback、不改 vendored evaluation
行为、不扩展 smoke 契约；仅如实记录。

## Security boundaries

- 凭证面零扩大：无新 env、无新落盘、无新日志路径；`X-Autofigure-Api-Key` 不变。
- 修正错误默认 base_url 消除「默认指向拒绝该 key 的端点」的 401 混淆面（fail-fast 优于静默失败）。
- `missing_model` 等失败码不泄漏内部细节 / 凭证 / provider traceback。

## Backward compatibility

- 默认 provider 恒为 `openrouter`；未设 `AUTOFIGURE_PROVIDER` 行为与 T08 完全一致。
- 三既有 provider 分支字节级不变（回归测试锁定）。
- researcher 侧无感知：wire 契约、归属门、错误归一、credential header、端口 / compose 全不变。

## Explicitly out of scope

- **不改** vendored `autofigure/**`；不新增 `KIMI_*` 槽位；不调默认 provider。
- **不加** retries / text-only 路径 / 不剥 reference 或 evaluation 图像。
- **不改** `server/**`、`frontend/**`、`sidecar-contract.md`、`deploy/docker-compose*.yml`、
  `requirements*`、T12 evidence、既有 T01–T12 票 AC/scope。
- **不新增** evaluation 真伪断言（smoke 契约不动）；不把任何模型 ID 固化为产品默认。
- **不触碰** `experiment/autofigure-kimi-provider`、`experiment/autofigure-deepseek-provider`
  分支与 `stash@{0}`。
- **不修改** `docs/autofigure/tickets.md`（V1 12 票 DAG 历史固化文件，不索引逐票；T13 为
  post-T12 票，不并入 V1 计划）。

## Completion evidence

- fixed point: `a696802`（feature/autofigure-integration HEAD，T12 完成证据）。
- implementation commit: `122f309`（`feat: AutoFigure T13 — Kimi Coding provider support`）。
- 性质：**feature 票**（sidecar 侧 provider 正式化）——researcher `server/` / `frontend/` / 契约 /
  打包零改动；vendored `autofigure/**` 零改动；T12 evidence 零改动。
- acceptance criteria 状态：
  - **确定性 AC：PASS** —— `deploy/autofigure-sidecar/.venv/bin/pytest service/tests -q` →
    **29 passed**（test_bridge 21：9 基线 + 12 kimi；test_app 8）。覆盖：provider 接受 / key→
    `BIANXIE_API_KEY` / base_url 显式映射 / model 显式映射 / base_url 缺省=coding/v1 /
    缺 model 与空 model 均 fail-fast（pipeline 不触发 + CONFIG 还原）/ 凭证不泄漏 /
    未知 provider 仍拒 / openrouter・bianxie・gemini 回归不变 / 跨调用隔离。
  - **门控真实 Kimi smoke：PASS** —— 真实完整链路经 researcher API：
    submit → queued/running → sidecar（kimi env，loopback）→ **Kimi Coding API** →
    **succeeded** → PNG 8 字节签名断言通过。测试体 **249.2s**（vitest 250712ms；
    Start 11:18:15；Duration 251.70s）。
- 真实 smoke 参数（PASS）：
  - endpoint: `https://api.kimi.com/coding/v1`
  - provider: `kimi`（opt-in；未设 `AUTOFIGURE_PROVIDER` 时默认仍是 `openrouter`）
  - model: `kimi-for-coding` —— **验证使用，不作为默认模型**；`AUTOFIGURE_MODEL` 必填
  - credential: `AUTOFIGURE_LLM_KEY`（唯一凭证，经 `X-Autofigure-Api-Key` header 请求级注入；
    临时 sidecar 容器内零凭证 env；sidecar 日志 / smoke 输出 0 次 `sk-kimi` 匹配）
- **Caveat（evaluation fallback）**：evaluation fallback 行为保持既有 AutoFigure 行为不变
  （`create_fallback_evaluation(5.0)` + `evaluate_code` catch fallback + bridge `evaluation is None`
  fallback，全 provider 共通，非 kimi 特有）；smoke 只断言 `succeeded` + PNG 签名，**不独立证明
  evaluation score 的来源**（真实 LLM vs fallback）。已接受为验证局限，如实记录。
- FIRST dual-axis review（vs a696802）：1 项 minor（test_bridge 残留 EXPERIMENTAL/`shim` 标签）
  已修复并重跑全绿；Standards + Spec/product 轴全部通过（BIANXIE 槽位为内部实现细节 / 无隐藏默认 /
  凭证零泄漏 / CONFIG 成功・失败后均还原 / vendored 零 diff / kimi opt-in / OpenRouter 默认不变 /
  端点正确 / model 必填 fail-fast / server・frontend・契约零改动 / 无 T12 重释 / 无 V2 scope creep）。
- `git diff --check`：PASS；`git diff --stat a696802` 恰为批准文件集（README +25 / bridge.py +15 /
  test_bridge.py +157 / 新 T13 票）。
