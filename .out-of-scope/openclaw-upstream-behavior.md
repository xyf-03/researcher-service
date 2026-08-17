# OpenClaw 上游行为（模型限流 / 并发上限 / abort 语义）

面板不对 OpenClaw 容器内 / 模型 API 层的运行时行为负责——控制面对这些事件是纯透传（网关隧道 ADR 0006，浏览器直连网关，控制面只做握手与帧转发）。因此「现象确凿但根因在容器内」的报告按此概念处理，不再逐条重复上游证据链调研。

## Why this is out of scope

限流、子任务并发上限、abort/超时语义、环境内工具缺失，全部由 OpenClaw 官方镜像（`ghcr.io/openclaw/openclaw:2026.7.1-browser`）与模型 API 决定，面板侧没有实现代码、没有可调配置（报错串全仓零命中即可确认）。

面板唯一可做的两项：

1. **显示侧收口**——把不可理解的内部噪声折叠/翻译（见 #499 的 Agent Brief，已排期）。
2. **模板配置**——若 OpenClaw 暴露了对应配置项，可在 `deploy/openclaw.json` 模板中调整（如子任务并发上限；该配置项是否存在于上游仍待确认，见 #528）。

## Prior requests

- #490 — OpenClaw transcript-repair 等内部行为，wontfix（上游）先例
- #526 — 并发子任务触发模型限流（`Token Plan rate limit` / HTTP 2062），wontfix
- #525 — 子任务 accepted 后静默中止（`OPENCLAW_DIRECT_ABORT`），needs-info（同族）
- #528 — 子任务并发计数超过上限（`sessions_spawn has reached max active children`），needs-info（同族，唯一可控路径是模板配置）
- #527 — 容器内缺 PDF 工具与 pip，enhancement → ready-for-human（部署/镜像层，需人拍板）
