# T08 — Python sidecar

## Parent specification

Reference: `docs/autofigure/spec.md`（§7 Python 边界 · §10 部署 · Testing Decisions）
Source of truth: `docs/autofigure/grilling-decisions.md` §7 / §10 / §11 / §14

## What to build

交付真实计算侧的 **Python sidecar 服务**：桥接 AutoFigure 的 text-to-figure 生成能力到私有 HTTP 契约（T07），并满足可观察的跨调用隔离。

- **sidecar 服务**：监听 panel-net 私有网络、**不暴露宿主端口**；`/health` 端点；实现 T07 契约（请求 → 生成 → `{xml, pngBase64, evaluation}`）。
- **保留 AutoFigure 生成能力**：复用其 Python 生成管线（generate → XML → PNG），**非盲目重写算法**；保留/遵守适用许可与署名要求。
- **可观察的跨调用隔离**（本票规范的是**行为**）：每次调用独立完成、无跨 Job 可变状态残留、provider 配置不泄漏于响应/日志；**内部是否使用 AutoFigure session 属实现细节，本票不强制 session 实现形态**。
- **边界**：不接收 researcher-service JWT、不接收 userId；只收生成参数 + 服务端注入的 provider 凭证；不拥有 public Job 状态。
- **chromium 构建期安装**（Playwright，XML→PNG 用）；Dockerfile 就绪（供 T10/T11 引用/构建）。
- **不复制** AutoFigure 的 `start.sh` / `stop.sh` / Flask app 形态（grilling §10）。
- 仅桥接 **V1 最小生成契约**（text-to-figure 单次生成）；AutoFigure 独立 Flask API 其余端点**不接入、不整体暴露**。

## Blocked by

**T07**（sidecar HTTP 契约）。

## Why this ticket exists

把已批准的能力来源（AutoFigure）以受控形态接入宿主：能力保留、边界隔离（无 JWT/userId、私有网络、无状态残留）、行为可观察。是 dev（T10）/ prod（T11）接线与真实 smoke 的前置。

## Acceptance criteria

- [ ] `/health` 返回可用状态（panel-net 内可探）。
- [ ] **契约自测**：给定输入 → 响应符合 T07 契约 schema `{xml, pngBase64, evaluation}`。
- [ ] **跨调用隔离（行为）**：连续两次生成，第二次不受第一次状态影响；无跨 Job 可变状态残留；provider 配置不出现在响应/日志。
- [ ] 请求不携带 JWT/userId（schema 不含，或显式忽略）。
- [ ] 无宿主端口暴露（私有网络）；无 public Job 状态逻辑。
- [ ] Dockerfile 构建含 chromium（Playwright）运行时；构建期安装依赖。
- [ ] 许可/署名要求保留于镜像内容（对齐 grilling §10「config 入镜像」）。
- [ ] 不复制 `start.sh`/`stop.sh`/Flask 形态。

## Relevant global invariants

- **Python 不接收 JWT / userId**；只收生成参数 + 服务端注入凭证（grilling §7 / spec §7）。
- **panel-net 私有、无宿主端口**；浏览器绝不直连（grilling §7 / spec §7）。
- **凭证由 researcher-service 注入**，Python 不管理/不持有/不暴露（grilling §4 / §7）。
- **零 host 挂载**（ADR 0013）；config 入镜像（grilling §10）。
- **V1 无删除**；**无自动重试**；**无 BullMQ AutoFigure 依赖**。
- 保留/复用 AutoFigure 生成能力 + 适用许可/署名（spec §7）。

## Explicitly out of scope for this ticket

- **dev compose 接线 / 本地真实生成 smoke → T10**；**deploy compose + GHCR 镜像管线 → T11**。
- **Adapter（researcher-service 侧）→ T07**（已交付）；**runner/状态机 → T03/T04**。
- **AutoFigure 独立 Flask API 其余端点**：不接入、不整体暴露。
- **内部 session 实现形态**：不强制；只要求可观察隔离行为。
- **前端 → T09**；**删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **Python 契约接缝（辅助，非新架构接缝）**：sidecar 契约 schema 自测（给定输入 → 断言响应 JSON 形状）。
- **门控真实集成接缝（辅助）**：需真 sidecar + 真 key 的 smoke 由 T10 门控覆盖（自动探测，对齐 containers-smoke）。
- **不补 AutoFigure 内部 Python 单测**（grilling §11）。

## Completion evidence

- **fixed point**：`fe1e0eb`（T07 HTTP adapter 合并点，af/t08-python-sidecar 基线）。
- **implementation commit**：`210d8ca`（feat: AutoFigure T08 — private Python sidecar bridging upstream pipeline）。
- **evidence commit**：本段所在 docs commit（git log 可查；不硬编码自身 SHA——evidence 无法自引用，T07 已证明）。
- **targeted tests**：17/17 契约接缝（`deploy/autofigure-sidecar`，pytest：test_bridge 9 · test_app 8）——纯逻辑、无真 LLM/网络/浏览器；上游 pipeline 三函数桩化为独立已知字面量（conftest 共享 `_pipeline_stub`）。覆盖：成功形状 `{xml, png_base64, evaluation}` + PNG 8 字节签名、失败短不透明码、CONFIG snapshot/restore、跨调用隔离（两次生成互不污染）、stdout 抑制防凭证泄漏、UTF-16 长度与 zod 精确等价（2000 emoji=4000 units 通过 / 2001=4002 拒绝）、reference 加载失败归一。
- **typecheck/build**：`tsc --noEmit` clean（T08 零 TS 变更；基线确认）。Python 侧无 build；Dockerfile 构建期断言（上游包可导入 / playwright / 署名文件 `test -f`）镜像 openclaw-image 先例。
- **broader tests**：full repo suite 714 passed / 6 skipped（仅 2 个预存在 docker smoke 失败 —— `ENOENT /var/run/docker.sock`，无 docker daemon，环境固有；与 T07 证据一致，T08 无回归）。
- **first code review**（fixed point `fe1e0eb` 双轴并行子代理）：
  - Standards：**无硬违规**。行动项 4：①`topic` 参数内联为常量（Speculative Generality，上游默认 content type）②两测试文件 `_pipeline_stub`/`KNOWN_PNG` 去重上移 conftest（Duplicated Code）③`_load_references` 移入锁内+重定向、失败归一 `GenerationError('reference_load_failed')` ④Dockerfile 增非 root `USER autofigure`（对齐 `USER node` 先例）+ `PLAYWRIGHT_BROWSERS_PATH` 前置 + `passwd`。确认项 2：provider if/elif/else（镜像上游 `update_config_from_sdk`）；prompt 双边界校验（400 vs 2xx 语义不同）。
  - Spec：**无 scope creep、AC 全满足**；vendored `autofigure/` 与上游 `diff -rq` 一致、`requirements-upstream.txt` 逐字；凭证卫生与跨调用隔离双检通过。行动项 2：①bridge `len()`（码点）与 zod UTF-16 长度不等价 → `_utf16_len` 精确对齐 ②README `-p` 端口注记 dev-only（AC「无宿主端口暴露」指生产形态）。确认项：无 sidecar 超时→挂死 provider 永久占锁（契约授权，README「运行语义」文档化）；Dockerfile 无 HEALTHCHECK（归 T10 compose）；契约示例端口 8796 vs 实际 8080（T10 接线对齐）。
- **fixes**：上述 6 行动项全部落实；新增 UTF-16 边界测试（红→绿）。修复后 17/17 绿。
- **second code review**：修复后逐点复核——UTF-16 校验有独立边界测试；Dockerfile USER 降权对齐 openclaw-image；测试 fixture 去重后 conftest 为单一来源；无新发现。
- **验证环境**：venv Python 3.14.6 + 全量 `requirements-upstream.txt` 安装兼容性验证通过（含 PyMuPDF/pdfplumber/google-genai/anthropic/playwright）。Dockerfile 未实构建（本机无 docker daemon——同 server smoke 门控先例；构建属 T10）。
- **commit**：`210d8ca`（实现）+ 本 evidence docs commit。
- **T09 handoff**：sidecar 就绪待 T10 组装 panel-net compose + 门控真实生成 smoke（需真 provider key + chromium + 真上游；自动探测门控对齐 containers-smoke）。researcher 侧 `AutoFigureGenerationPort` 契约已冻结（T03-T07），sidecar 不改动契约。
