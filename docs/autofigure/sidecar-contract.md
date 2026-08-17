# AutoFigure 私有 sidecar HTTP 契约

> 本文档是 **researcher-service ↔ AutoFigure Python sidecar** 私有 wire 契约的**人工文档镜像**。
> **规范性单一来源是代码**：`server/src/figures/httpPort.ts` 中的 zod schema 与常量
> （`sidecarGenerateRequestSchema` / `sidecarSuccessSchema` / `sidecarFailureSchema` /
> `SIDECAR_CREDENTIAL_HEADER` / `SIDECAR_GENERATE_PATH`）。改契约必须同步改代码 schema + 本文档。
>
> 属主票据：T07（docs/autofigure/tickets/T07-autofigure-http-adapter.md）。
> 上游参考：AutoFigure 现有 Web 模式返回 `{xml, png_base64, evaluation}`（reconnaissance 报告），
> 但 **api_key-in-request-body 是被否决的 anti-pattern**（grilling §14；`autofigure_routes.py:366`）。

## 1. 范围与拓扑

- 本契约描述 researcher-service 控制面进程 → 私有 AutoFigure sidecar 的单向调用（生成一次图）。
- **panel-net 私有、不暴露宿主端口**（spec §7 / grilling §7）。浏览器永不直连 sidecar。
- **sidecar 实现（Python）是 T08**；本契约是 T07 定准的传输表示，T08 按其实现。

## 2. 传输

| 项 | 值 |
|----|----|
| 协议 | HTTP 1.1 over TCP（panel-net 内私有；生产部署建议 sidecar 只监听内部网络接口） |
| Base URL | `config.autofigure.sidecarUrl`（env `AUTOFIGURE_SIDECAR_URL`，如 `http://autofigure:8796`） |
| 端点 | `POST {baseUrl}/v1/generate`（相对路径常量 `SIDECAR_GENERATE_PATH = '/v1/generate'`） |
| 方法 | `POST` |
| 请求体 | `application/json` |
| 无 TLS 内在要求 | 信任边界是网络隔离（panel-net 私有）+ 服务端凭证注入；生产经 HTTPS 反代亦可 |

> **无 adapter-local 超时**（T07 属主决策）：sidecar 请求超时语义由 T04
> `AUTOFIGURE_JOB_TIMEOUT_MS`（应用 runner 超时）唯一承担。迟到 settle 由 T04 终态围栏
> （CAS `WHERE status='running'`）丢弃。**无自动重试**——一次生成恰好一次传输。
>
> **Abort signal（T07 已批准扩 Scope · 风险 A）**：request 恒携带 `signal`（AbortController），
> 由 runner 持有；**同一 controller 的两个触发源**——(A) **T04 应用超时**到点 (B)
> **graceful shutdown / runner.stop()**。不建两套互相竞争的取消抽象。signal **仅**用于取消在飞
> 传输（解 pump 卡死——半开网络 fetch 永不 settle 会永久阻塞单 worker；防 shutdown 挂起——
> stop() 不得等待到 `AUTOFIGURE_JOB_TIMEOUT_MS` 默认 30min）。abort 后 fetch 抛 AbortError →
> adapter 归一 `GENERATION_EXECUTION_ERROR`（**不新增 adapter-local 超时错误态**）；超时原因
> （`JOB_TIMEOUT_REASON`）由 runner 依据 `signal.aborted` 统一归一，此契约在 adapter 层不可见。
> **shutdown abort 不改 Job 业务终态**：stop() 后仍 running 的 Job 保持 running，下次 startup 由
> T04 reconcile 终态化（crash/restart interruption 唯一事实语义）。时序不变量：promise settle 的
> 微任务先于 abort timer 宏任务 → 合法成功恒在 abort 前 settle，绝不误标超时。

## 3. 凭证传输（T07 属主定准）

- **header**：`X-Autofigure-Api-Key: <provider apiKey>`（常量 `SIDECAR_CREDENTIAL_HEADER`）。
- **为什么是 header 而非 body**：
  1. 对齐 `AutoFigureGenerationPort` 的 **input / credential 分离**——生成输入是域数据，凭证是
     服务端执行上下文，二者不混同（T03 边界纪律）。
  2. 规避被否决的 upstream anti-pattern（`api_key` 明文进 POST body，grilling §14）。
  3. 请求 body 保持纯域输入（`{prompt}`），无凭证 → 请求体可安全入日志/追踪，凭证卫生范围收窄。
- 值来源：`config.autofigure.llmKey`（env `AUTOFIGURE_LLM_KEY`，全面板共享系统级凭证）。
- **生产建议**：本契约默认明文 HTTP（panel-net 私有信任边界）；生产部署若 sidecar 与控制面不在
  同一可信网段，应在 sidecar 前置 HTTPS 反代，使凭证不落明文链路（`AUTOFIGURE_SIDECAR_URL`
  置为 `https://…` 即可，adapter 不做强制——强制 https 会破坏内网部署形态，见 §2）。
- **绝不**：落日志 / 追踪 / 响应 / Job payload / DB（grilling §4）；不随请求体（浏览器侧）传递；
  Python 不管理/不持有/不暴露该凭证。
- **不转发 JWT、不转发 userId**（spec §7 / grilling §7）：sidecar 无鉴权、无归属概念。

## 4. 请求体（`sidecarGenerateRequestSchema`）

```json
{ "prompt": "画一幅星空下的麦田" }
```

| 字段 | 类型 | 约束 |
|------|------|------|
| `prompt` | string | 非空、1–4000 字符（V1 唯一生成输入；域输入已在 T01/T02 validation 层 trim 规范化，sidecar 契约原样透传、不重复 trim） |

## 5. 成功响应（2xx，`sidecarSuccessSchema`）

```json
{
  "ok": true,
  "xml": "<mxfile>...</mxfile>",
  "png_base64": "iVBORw0KGgo...",
  "evaluation": "{\"ok\":true,\"quality\":\"good\"}"
}
```

| 字段 | 类型 | 约束 |
|------|------|------|
| `ok` | `true`（字面量） | 固定 |
| `xml` | string | draw.io 兼容图 XML |
| `png_base64` | string | base64 编码的 PNG 字节；**必须可解码为以 PNG 8 字节签名（`89 50 4E 47 0D 0A 1A 0A`）开头的非空字节** |
| `evaluation` | string | **已归一化的非敏感 JSON 字符串**（渲染质量/评分等；不含凭证/内部栈/路径） |

### `png_base64` 边界纪律（T07 属主决策）

- `png_base64` 是 **Python 侧命名**（对齐 upstream AutoFigure），**只存在于本私有 wire 边界**。
- 生产 HTTP adapter 在边界**立即 base64 decode 为 Prisma Bytes 等价（`Uint8Array<ArrayBuffer>`）**，
  解码失败/空 → 归一失败；归一化结果用 `png` 字段名返回——**`png_base64` 绝不泄漏到
  Figure 域 / GenerationJob / 公开 REST / 前端**（T06 产物契约保持 `png`）。
- **PNG 签名校验（T07 已批准扩 Scope · 风险 B）**：decodePng 先 base64 decode，再校验
  **8 字节 PNG 签名**（`89 50 4E 47 0D 0A 1A 0A`）。解码为空 / 签名不匹配（截断、错误 sidecar
  产物、非 PNG 内容）→ 归一失败（`invalid_png_base64`），**绝不放行以 succeeded 落库**——否则
  只能新建 Figure 重生成。

## 6. 失败响应（2xx 内，`sidecarFailureSchema`）

```json
{ "ok": false, "error": "generation_failed" }
```

| 字段 | 类型 | 约束 |
|------|------|------|
| `ok` | `false`（字面量） | 固定 |
| `error` | string（可选） | 短不透明诊断代码，**仅服务端可读**，绝不外泄到公开错误 |

> 失败形态与超时（sidecar 无响应）→ adapter 归一为稳定非敏感原因
> `GENERATION_EXECUTION_ERROR = '生成执行异常（内部错误）'`（T05 白名单单源，见 runner.ts）。
> **raw provider 错误 / Python traceback / 内部文本绝不进入 `GenerationJob.errorMessage`**。

## 7. 错误面（非 2xx 与传输层）

- 非 2xx、JSON 解析失败、fetch 抛错（sidecar 不可达）→ 全部归一为 `GENERATION_EXECUTION_ERROR`
  的 `{ok:false, errorMessage}`。诊断日志只记固定类别 + HTTP 状态码，不插值凭证/body/raw 响应。
- **重定向（3xx）被拒绝**（adapter 以 `redirect: 'error'` 发起请求）：契约未定义重定向语义，
  任何 3xx → 传输抛错 → 稳定失败。凭证（`X-Autofigure-Api-Key`）**绝不跟随重定向**——Node
  fetch 默认会向跨源重定向目标重发自定义 header，这是被显式关闭的凭证外泄路径。
- **Abort（T07 扩 Scope · T04 超时 / shutdown 两触发源）**：runner 触发 abort → fetch 抛
  AbortError → 归一同上（`GENERATION_EXECUTION_ERROR`）；超时原因由 runner 依 `signal.aborted`
  归一（`JOB_TIMEOUT_REASON`），adapter 不新增超时态；shutdown abort 不改业务终态（见 §2）。

## 8. 显式不做（V1）

- **无鉴权**（sidecar 网络隔离即信任）；**无 CORS**（仅 panel-net 内部服务间调用）。
- **无其他端点接入**：AutoFigure 独立 Flask API 其余端点（session/continue/enhance/…）不接入、不整体暴露。
- **无 artifact URL 概念**：产物只经 `png_base64` 回传，由 researcher-service 落库（T06）。
- **无浏览器直连**、**无每用户凭证**（grilling §13）。
- **无自动重试**；**无 adapter-local 超时**。
