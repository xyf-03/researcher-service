# 迁移部署镜像：cn-im fork → ghcr 官方 browser 变体

本仓库历史部署镜像为 `acautomata/openclaw-docker-cn-im`（fork 自 `justlovemaki/OpenClaw-Docker-CN-IM`，R6 §5）。researcher 的 `openclaw.json` 保留了 browser 插件配置（`plugins.entries.browser.enabled=true`），但该 fork 镜像**不含 browser 运行时** —— image config 的 env 无 `PLAYWRIGHT_BROWSERS_PATH`，体积 1468MB 全为 IM 插件 + init 逻辑。因此 browser 能力在 fork 上是死的。

经实测 ghcr 完整 tag 列表（1702 个）：`-browser` 变体（env 含 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`、预装 Playwright 运行时）是官方 browser 能力载体（`-slim` 309MB 未预装浏览器二进制）。

> **2026-08-01 更新**：原校准对象 `2026.6.34-browser` 已被上游从 registry 删除（`manifest unknown`，CI integration 因此全红，issue #302）。最新稳定 `-browser` 变体为 `2026.7.1-browser`（与 `latest-browser` 同 digest；`2026.7.2` 系列仍全为 beta）。本 ADR 决定目标随之更新为 `2026.7.1-browser`，并在该镜像上重验 wire 校准（全绿，无漂移，见下）。

> **2026-09-12 更新**：部署基线由 `2026.7.1-browser` 前进到 `2026.9.4-browser`——本次是**主动升级**
（容器升级 epic #682 的版本前提，issue #695），非上游删除驱动；候选版本经
`docs/research/683-image-upgrade-2026-9.md` 实测筛出（9.4 与 7.1 同属 wire 协议族 `PROTOCOL=4`，
握手 shape 一致）。本 ADR 决定目标随之更新为 `2026.9.4-browser`，重验见「后果」。

**决定**：把部署与集成测试镜像迁移到 `ghcr.io/openclaw/openclaw:2026.9.4-browser`（官方稳定版 browser 变体；原 `2026.6.34-browser` 因上游删除已废弃，`2026.7.1-browser` 由 issue #695 主动升级取代）；**集成测试的 CI pin 本轮未随迁**（`.github/workflows/ci.yml` 仍 pin `2026.7.1-browser`，见「后果」的「未重验面」）。迁移以「最小 DoD」先行：容器跑起来 + WS connect 握手通过 + 设备配对完成 + 一个 `chat.send` 收到真实事件流（顺带验证 `browser.noSandbox` 能起）；**chat wire schema 校准在官方镜像上做**。

**为什么**：
- browser 能力是产品需求，fork 镜像给不了（无 Playwright），官方 `-browser` 变体是唯一稳健路径。
- 选稳定版（`2026.6.34` → 上游删除后 `2026.7.1`）而非 beta（`7.2-beta.*`）：beta 的 wire schema 会随迭代漂移，做 schema 校准的**对象必须稳定**（见 chat_client.py 中大量"待实测"标注）。
- 迁移先行、chat schema 校准在官方镜像上做：fork 7.1 与官方 6.34/7.1 是不同谱系/版本，在 fork 上校准的 wire schema 未必适用于官方，等于白做。

## 考虑过但否决的方案

- **留在 fork 上做 chat schema 校准**：fork 给不了 browser（动机未达）；且不同谱系 schema 可能存在版本差异，校准成果不可迁移到目标镜像。
- **官方 beta（`2026.7.2-beta.*-browser`）**：beta 做 schema 校准会漂移，校准对象不稳定；校准对象须为稳定版（`2026.6.34` → 上游删除后 `2026.7.1`）。
- **`-slim` 变体**：体积 309MB 未预装浏览器二进制，browser 能力需运行时额外下载，违背"browser 即开即用"的产品诉求。
- **沿用已删除的 `2026.6.34-browser`**：tag 已从 registry 移除，pull 必失败（`manifest unknown`），不可作为部署/CI 目标。

## 后果

- **挂载契约重做**：官方镜像 entrypoint 为 `tini` 直起 gateway，**无 init 脚本、无 sync 逻辑**。compose 现有 `user:0:0` + `cap_add:[CHOWN,SETUID,SETGID,DAC_OVERRIDE]`（为 fork init.sh 的 chown 降权而设）、`${GATEWAY_TOKEN}` 占位插值、LLM `SecretRef` 方式 —— 均需重验/重做。官方镜像以非 root `node`(uid 1000) + `no-new-privileges` 运行，compose user/caps 应据此收紧。
- **两个拦路虎已 spike 实测（`2026.6.34-browser`，均兼容，无需改 openclaw.json）**：
  1. **token 机制** ✅：openclaw.json `"token":"${GATEWAY_TOKEN}"` 占位插值**在官方 gateway 生效**。spike 同时注入 `GATEWAY_TOKEN=spike-gw-token` 与 `OPENCLAW_GATEWAY_TOKEN=spike-gw-env-token`（值不同），握手 `connect.params.auth.token=spike-gw-token` 通过、`=spike-gw-env-token` 被拒（1008 token mismatch）—— 证明服务端 token = openclaw.json 占位解析值（即 `GATEWAY_TOKEN` env），官方 gateway 会做 `${ENV}` 插值。fork 的 token 占位机制可直接复用。（`config get gateway.auth.token` 返回 `__OPENCLAW_REDACTED__`，敏感值脱敏。）
  2. **LLM key 模式** ✅：`SecretRef {source:env,id:LLM_API_KEY}` + `secrets.providers.default` 官方 6.34 接受 —— 启动日志 `minimax auth configured, enabled automatically` + `agent model: minimax/MiniMax-M3`。不用改 auth-profiles.json，ADR 0001「凭证经 env SecretRef 不落明文」守住。
- **配置路径细节**（spike 实测）：官方镜像 image env **无 `HOME`**（fork 有）。以 `node`(1000) 运行时 HOME 自然 `/home/node`；若以 root 运行须显式 `-e HOME=/home/node`，否则 gateway 读 `/root/.openclaw`（空）报 `Missing config`。
- **本地 Colima VM + `/tmp` bind-mount 陷阱**（spike 实测，修正初期误判）：daemon 是**本地 Colima**（`docker context ls` = `colima`，endpoint `unix://~/.colima/default/docker.sock`），**非远程**。`docker info` 见 Ubuntu/Linux **不等于**远程 —— Colima/Docker Desktop 本地 VM 都报 Linux；判本地/远程看 context endpoint（unix socket = 本地）。spike 初期 bind-mount 失效是因 macOS `/tmp` → `/private/tmp` 符号链接，Colima 挂 `/tmp/...` 时容器内退化为空目录。**Colima 共享白名单路径（如 `~/Documents`）bind-mount 正常**（实测 worktree 路径秒读）。含义：正式集成测试 `bind-mount researcher clone`（`~/Documents` 下）可行，**「删 `RUN_INTEGRATION` 强制本地验证」无 daemon 阻塞**；spike 的 base64 内联是 `/tmp` 陷阱的临时绕过，非必需。
- **spike DoD 全达成 + wire schema 校准**（2026-07-27, `ghcr.io/openclaw/openclaw:2026.6.34-browser`, 真 minimax key）：
  - **配对全流程跑通**：`PAIRING_REQUIRED`(requestId) → `docker exec openclaw-spike openclaw devices approve <requestId>` → 重连拿 `deviceToken` + 全 4 operator scopes（`REQUIRED_SCOPES` 全满足）。Ed25519 v3 签名逐字节正确（复用 backend `device_crypto`+`wire.ConnectFrameBuilder`）。
  - **`chat.send` 收到真实 LLM 事件流**：`chat` 事件 `state:delta`(`deltaText`) / `state:final`(`message`+`stopReason`) + `agent` 事件 `stream:assistant`/`lifecycle` —— 坐实 `event_translate.py` 的 `deltaText`/`state` 假设。
  - **发现并修复真实 bug**：`event_translate.py:_translate_final` 把 `payload.message` 当字符串（`.startswith`），实测是 dict `{role, content:[{type:text,text}], timestamp}` → `AttributeError`。加 `_extract_text` 兼容 str/dict（final + delta-replace），TDD 2 个新测试，chat 214 + integration 114 测试全绿。**完美印证本 ADR 动机：fake 测试用字符串 message 掩盖了 wire schema 假设错误，#94 smoke 未测 send_message 事件流，bug 潜伏至真实集成才发现。**
  - 附带实测：`sessions.create` 返回 sessionKey 格式 = `agent:<agentId>:<raw>`（`chat.send` 须用此完整格式，不必先 create）；`label` 要唯一；`sessions.list` = `{count,totalCount,limitApplied,nextOffset,hasMore}`。
  - **容器内 CLI token 陷阱**：`openclaw devices approve` 等 CLI 自连 gateway，token 须 = `gateway.auth.token`（openclaw.json `${GATEWAY_TOKEN}` 占位值），**不是** `OPENCLAW_GATEWAY_TOKEN` env —— 部署时两者须一致或占位统一用 `${OPENCLAW_GATEWAY_TOKEN}`。
- **exhaustive 校准 4 个只读 RPC**（spike 同容器，2026-07-27）：
  - `sessions.list`：`sessions[].key/derivedTitle/updatedAt` —— views._parse_sessions 假设**全对**（`derivedTitle` 由首条消息派生，如 "你好，请用一句话介绍你自己"）。
  - `chat.history`：`messages[].content` **多态**（user=字符串，assistant=list `[{type:thinking,...},{type:text,...}]`）；views._parse_history 透传不解析，前端契约须容忍 content str/list。
  - `commands.list`：`commands[].name/textAliases/description` 假设**全对**（实测还含 `nativeName`/`category`/`source`/`scope`/`acceptsArgs`，当前未透传）。
  - `exec.approval.list`：**payload 直接是 list（空 `[]`），非 `{approvals:[...]}` dict** → 第二个被真实集成发现的 fake 盲区 bug：`chat_client.list_pending_approvals` 假设 dict 取 `.approvals`，非空 list 会 `list.get` 崩。修：加 payload 类型分支（list 直用 / dict 取 approvals），TDD 2 新测试，chat 216 测试全绿。
  - **两次 bug 都印证 ADR 动机**：fake 用 dict/字符串假设掩盖了 wire schema 真相，只有真实集成才暴露。`chat_client.py` 中所有"待实测"注释现均已实测坐实或修复。
- **深挖边缘实测：`agent.tool.*` + `approval.resolve` 非空**（spike 同容器，2026-07-27，token 对齐后）—— 又发现 7 个 wire schema 假设错误（累计 9 个，强证真实集成是唯一能补的洞）：
  - **工具事件结构**：网关发 `event:"agent" + payload.stream:"tool" + data.phase:"start"/"update"/"result"`（`data.name/toolCallId/args/partialResult/result/isError`），**非** `wire.py` 假设的独立 `agent.tool.start`/`agent.tool.result` 事件 → `event_translate._translate_tool` 整条路径永不触发，**前端工具帧（T08）从不产生**。还含 `stream:"item"`（`kind:"tool"/"command"`,`status`）、`stream:"command_output"`（命令输出流）等更细粒度事件未覆盖。
  - **approval.requested 字段路径**：`payload.request.command` / `payload.request.sessionKey`（非 `systemRunPlan.rawCommand`/`systemRunPlan.sessionKey`，实测 systemRunPlan=null）→ `_approval_card` command/sessionKey 取空。payload **无 kind 字段**（事件名派生 exec/plugin 正确）。`allowedDecisions:["allow-once","allow-always","deny"]`。
  - **resolve 方法名/params**：`exec.approval.resolve`（按族，非通用 `approval.resolve` —— 后者网关报 `unknown method`），params `{id, decision}`（无 kind），decision 取 `allow-once`/`allow-always`/`deny`（非 `approve`）。res `payload:{ok:true}`，网关广播 `exec.approval.resolved`（含 `decision`/`resolvedBy`/`request`）。
  - **`APPROVAL_RESOLVED_EVENTS` 漏 exec 族**：`wire.py` 仅列 `plugin.approval.resolved`，漏 `exec.approval.resolved`。
  - **拆 ticket 后续回写**（避免本 PR 膨胀）：工具翻译重构、approval card 字段路径、resolve 方法名/params、`APPROVAL_RESOLVED_EVENTS` 补 exec —— 每项一个 TDD fix。
- **browser 免 SYS_ADMIN**：官方 browser 变体用 Playwright + Xvfb + `noSandbox`，hardened compose 已 drop `NET_RAW`/`NET_ADMIN`，**不需要 `SYS_ADMIN` cap**（与 fork 的 caps 设计无关，是独立利好）。
- **`2026.7.1-browser` 重验（2026-08-01, CI integration job, 真容器）**：上游删除 `2026.6.34-browser` 后全仓升级到 `2026.7.1-browser`（PR #299 `6be88d0`）。CI integration 三 job 全绿——**wire schema 校准在 7.1 上无漂移**：T1-T5（`chat.send` 事件流 / 只读 RPC / approval 路径）、`event_translate` 的 `deltaText`/`state:final`/工具帧、`request_router` 的 `exec.approval.resolve` 方法名、`pairing_ws` 嵌套错误码均仍通过，无需修改任何校准代码。7.1 与 6.34 同属 wire 协议族（`PROTOCOL=4`），本 ADR 的 spike 实测结论（token 占位 / SecretRef / 配对 / 工具事件结构）对 7.1 继续成立。
- **`2026.9.4-browser` 重验（2026-09-12, 本机门控 smoke + 派生镜像本地构建, 真容器）**：两套 smoke 的
  缺省常量仍 pin `2026.7.1-browser`（见下「未重验面」），故本次**显式**设
  `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.4-browser` 覆盖后再跑——9.4 基线上
  `containers-smoke`（5/5）与 `pairingSmoke`（3/3）全绿：配对闭环（bootstrap → `PAIRING_REQUIRED` →
  approve → deviceToken 直连）与既有 wire 行为无漂移；派生镜像（`deploy/openclaw-image/`，`FROM` 已
  bump 至 9.4，issue #695）在该基线上构建通过全部构建期断言（`pdftotext` 可用 + 12 个骨架文件齐全）。
  **未重验面（如实记录）**：CI `server` job 的两个 smoke 仍 pin `2026.7.1-browser`
  （`.github/workflows/ci.yml` 的 `OPENCLAW_IMAGE`，注释理由：CI 阶段派生镜像尚不存在、smoke 测编排
  逻辑，官方/派生镜像等价；本地缺省常量同源），故「wire schema 校准在 9.4 上无漂移」尚未由 CI
  确认——切换该 pin 属 epic #682 的后续范围，不在 #695 内。
- **历史实测文档须重验**：R6（挂载契约）、`r26`（ws 协议/operator scope 来自配对）、`r28`（热加载不重启）均基于 fork + init.sh，迁移后须在新镜像上重新验证回填。
- **配置小坑**：`openclaw.json:33` `browser.executablePath:"/usr/bin/chromium"` 需对齐 Playwright 路径（`/home/node/.cache/ms-playwright`）或删除让其自解析。
- 本 ADR 与 [0001-persistent-credential-encryption](./0001-persistent-credential-encryption.md) 相关：LLM key 注入方式若从 SecretRef 改为 auth-profiles，必须守住 0001 的"凭证不落明文"不变量（经 env/SecretRef 读，不写盘）。
