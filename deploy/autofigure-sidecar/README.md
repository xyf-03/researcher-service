# AutoFigure sidecar（T08）

AutoFigure V1 的真实计算单元：私有 panel-net Python 服务，桥接上游 AutoFigure 的 text-to-figure
生成管线到 T07 冻结的 HTTP adapter 契约（`docs/autofigure/sidecar-contract.md`）。

- **上游 vendor**：`autofigure/` 是上游 AutoFigure 包的逐字拷贝（pin `454ee86`，见 `UPSTREAM.md`）。
- **薄桥**：`service/bridge.py`（CONFIG 注入 + stdout 抑制 + 响应归一化 + 跨调用隔离）+
  `service/app.py`（Flask 表面）。
- **零 host mount**（ADR 0013）：镜像自包含；凭证运行时经 `X-Autofigure-Api-Key` header 注入，
  镜像内无密钥。

## 本地开发（契约接缝测试，无真 LLM/网络/浏览器）

```bash
cd deploy/autofigure-sidecar
python3 -m venv .venv
.venv/bin/pip install openai Pillow cairosvg requests flask pytest   # 契约接缝最小依赖
.venv/bin/pytest                                                     # 29 个契约接缝测试
```

运行 pytest 需宿主机有 libcairo（`brew install cairo`，`import cairosvg` 必需）。

## 构建 / 运行

```bash
# 构建（需要 docker daemon；T10 组装 panel-net compose 时引用）
docker build -t autofigure-sidecar deploy/autofigure-sidecar

# 本地冒烟（dev-only：-p 把端口发布到宿主 loopback 便于 curl 验证；生产是 panel-net 内部接入，
# T10 compose 不发布宿主端口——AC「无宿主端口暴露」指生产形态）。
docker run --rm -p 127.0.0.1:8080:8080 -e AUTOFIGURE_PROVIDER=openrouter autofigure-sidecar
curl -s localhost:8080/health
curl -s -X POST localhost:8080/v1/generate \
  -H 'X-Autofigure-Api-Key: sk-...' -H 'Content-Type: application/json' \
  -d '{"prompt":"draw a training pipeline"}'
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `AUTOFIGURE_PROVIDER` | `openrouter` | `openrouter` / `bianxie` / `gemini` / `kimi`（Kimi Coding API，opt-in；OpenRouter 仍为默认） |
| `AUTOFIGURE_MODEL` | 各 provider 默认 | 可选；provider=`kimi` 时**必填**（显式，无产品默认） |
| `AUTOFIGURE_BASE_URL` | 各 provider 默认 | 可选；kimi 缺省 `https://api.kimi.com/coding/v1` |

API key **只**经 `X-Autofigure-Api-Key` header 请求级注入（T07 契约），绝不落盘/日志/响应。

## Kimi Coding provider（T13，opt-in）

`AUTOFIGURE_PROVIDER=kimi` 走 **Kimi Coding API**（`https://api.kimi.com/coding/v1`）。

- **Base URL 默认**：`https://api.kimi.com/coding/v1`——唯一在真实兼容实验（T13）中验证通过的端点。
  本支持**不隐含 Moonshot 端点**（`api.moonshot.cn` / `api.moonshot.ai`）支持；该 credential 只对
  Kimi Coding API 认证。
- **Model 必填**：`AUTOFIGURE_MODEL` 必须显式提供；缺省/空串在 OpenAI 兼容调用前本地 fail-fast
  （短不透明配置错误，不泄漏内部细节/凭证）。**无产品默认 model**——视觉模型 ID 更新频繁。
  已验证示例：`kimi-for-coding`（真实实验中成功通过全链的模型；**不是**永久/默认 model 承诺）。
- **凭证单一**：仍只经 `X-Autofigure-Api-Key` header 请求级注入（`AUTOFIGURE_LLM_KEY` 为唯一
  env credential）；无每用户/每 provider 独立凭证支持。
- **opt-in**：未设 `AUTOFIGURE_PROVIDER` 时默认 `openrouter`，kimi 仅在显式 `AUTOFIGURE_PROVIDER=kimi`
  时激活。Kimi 是 **sidecar 级 transport 适配器**：内部复用既有 `BIANXIE_*` CONFIG 槽位
  （`LLM_PROVIDER=kimi` + `BIANXIE_API_KEY/BIANXIE_BASE_URL/BIANXIE_CHAT_MODEL`），该复用是内部
  实现细节，**不是用户可见的 provider**；vendored `autofigure/**` 零改动。

## 运行语义（运维须知）

- **无 sidecar 超时**（契约授权：V1 唯一 execution timeout 在 researcher 侧 T04
  `AUTOFIGURE_JOB_TIMEOUT_MS`，sidecar 不新增 timeout policy）。生成是阻塞的：若 provider 调用挂死，
  会**永久占住生成锁**——`/health` 仍存活，但后续 `/v1/generate` 无限排队，只能靠容器重启恢复
  （T10 compose `restart: unless-stopped` 覆盖）。researcher 侧 T04 超时会 abort 请求，但 sidecar
  仍跑完本次生成（late-result fence 丢弃）。
- **降权运行**：Dockerfile 以非 root 用户跑（chromium 浏览器缓存经 `PLAYWRIGHT_BROWSERS_PATH` 隔离）。

## 端点（T07 冻结契约）

- `GET /health` → `{"status":"ok"}`
- `POST /v1/generate` → 请求 `{"prompt": 1-4000}` + header
  - 成功：`{"ok":true,"xml":"<mxfile>…","png_base64":"…","evaluation":"{…JSON…}"}`
  - 生成失败（2xx 内）：`{"ok":false,"error":"<短不透明代码>"}`
  - 请求校验失败：`400 {"ok":false,"error":"<短不透明代码>"}`
