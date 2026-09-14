# 前端接入点测绘：rewind / fork / 分支菜单 / CAS 四功能（#686）
> **来源**：wayfinder 研究票 [#686](https://github.com/ACautomata/researcher-service/issues/686) · 地图 [#682](https://github.com/ACautomata/researcher-service/issues/682) · 2026-09-12 · 基线 master@3f12d1a · 上游基准 openclaw@2026.9.4

工作基线：`master@3f12d1a`（worktree unified-dancing-steele）。上游基准：本机 `openclaw@2026.9.4` docs + dist 源码（`docs/web/control-ui/chat.md:97`、`docs/gateway/protocol/rpc-session-control.md:39`、`dist/sessions-rlbLHLas.mjs`、`dist/chat-send-handler-oS9rX200.mjs`、`dist/chat-history-handler-DpOELHcj.mjs`、`dist/session-accessor-BxcCxteu.mjs`、control-ui bundle 实测反解）。所有行号为本仓库 worktree 现状。

**总判定：四个功能全部是前端增量改造，`frontend/src/api/chat.ts`（REST 代理）与 `frontend/src/chat/outboxStore.ts` 零改动；无「大」级（>100 行/文件）改造面，合计约 300–400 行（含测试）。**

---

## 1. gatewayChat.ts 扩展点（协议机 Facade）

**现状（证据）**

- `send()`：`frontend/src/chat/gatewayChat.ts:707-723`，`client.request('chat.send', {sessionKey, message, idempotencyKey, ...attachments})` 在 :716。参数自构造、返回 `{runId}` 归一。已有可选参条件展开先例：`...(attachments && attachments.length > 0 ? { attachments } : {})`（:720）——「不带 = 与现状同形状」。
- RPC 封装惯例两种：
  - **简单透传**：`resolveApproval`（:743-748）——一行 `client.request(method, params)`，无结果解析；`deleteSession`（:674-682）同款。
  - **0 信任校准**：`listSessions`（:642-660）/ `getHistory`（:683-706）/ `listCommands`（:724-742）/ `listPendingApprovals`（:754-777）——对响应逐字段 `typeof` 门 + 非法项跳过，产出强类型 DTO。
- DTO 定义位置：文件顶部集中区（`SessionDTO` :31-35、`HistoryMessageDTO` :37-41、`SessionHistoryDTO` :43-47、`CommandDTO` :49-53、`ApprovalCardDTO` :109-117）；方法签名集中在 `GatewayChat` 接口 :74-105。
- scope：`OPERATOR_SCOPES`（:184）已含 `operator.read/write/approvals/admin`——上游 method-scopes（`dist/method-scopes-tKV11oMS.mjs:1347-1366`）要求 `sessions.rewind`/`sessions.branches.switch` = admin、`sessions.fork` = write、`sessions.branches.list` = read，**连接参数零改动**。

**改造点**

1. **CAS**：`send()` 签名加第 5 参 `expectedLeafEntryId?: string | null`，payload 条件展开 `...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {})`（与 attachments 同款）。最小侵入：不传（undefined）时键不出现、wire 形状与现状逐字节一致，全量回归无差。CAS 拒绝为 RPC 错误 `details.reason: "active-leaf-changed"`（上游 `assertExpectedLeafActive`，chat-send-handler:3614-3622），经 `GatewayProtocolRequestError` 上抛，调用层 catch 判 reason。
2. **新 RPC（4 个）**，沿用哪个模式：
   - `sessions.rewind {sessionKey, entryId} → {editorText?, editorAttachments?}`、`sessions.fork {sessionKey, entryId} → {sessionKey, editorText?, editorAttachments?}`、`sessions.branches.switch {sessionKey, leafEntryId} → {}`：沿用 **resolveApproval 简单透传** 模式（switch 恒空返回可作 typed no-op 错误处理——上游选已激活分支是带类型错误）；
   - `sessions.branches.list {sessionKey} → {branches}`：沿用 **listSessions 0 信任校准** 模式（`leafEntryId/headline/messageCount/updatedAt/active` 逐字段 typeof 门）。
   - 上游参数/结果 schema 实证：`dist/sessions-rlbLHLas.mjs:2430-2480`（`SessionsRewindParamsSchema`/`SessionsForkResultSchema`/`SessionBranchSchema`）。
3. **DTO 落位**：`SessionBranchDTO` / `RewindResultDTO` / `ForkResultDTO` 定义在文件顶 DTO 区，`GatewayChat` 接口追加 4 方法签名。官方 UI 包装层同构先例：`Bo/Uo/Ho` 函数（control-ui-core bundle，`e.request('sessions.rewind', {...To(key), entryId})` 薄包装）。

**规模：小～中**（CAS ≈10 行；4 RPC + DTO + 0 信任门 ≈80 行；单文件合计 <100，中档下限）。

## 2. ChatMessageItem（rewind/fork 按钮挂点）

**现状（证据）**

- `frontend/src/components/chat/ChatMessageItem.vue`（295 行）哑组件，props `{msg, regenerateText?}`（:21-24），emits `{regenerate, toggleTraceFold}`（:27）。
- **无右键菜单、无 hover 工具条**。唯一消息操作区 = assistant 完成后的 `.ai-notice` 行（:224-232：「内容由 AI 生成」+ 重新生成/复制按钮）——这是现成的「消息级操作行」先例。
- user 消息分支纯文本渲染（:146-148 `<template v-else>{{ msg.text }}…`），无任何操作入口。
- 上游官方形态（control-ui bundle 实测）：user 气泡 hover 回复按钮 + 气泡 `data-entry-id`（取 `message.__openclaw.id` 回退 `messageId`）+ 右键菜单 **Rewind to here / Fork from here**；busy（runActive/runWorking）时禁用 + tooltip；rewind pending 期间保留用户更新的草稿；仅对已持久化的 user 消息生效（`docs/web/control-ui/chat.md:97`）。

**改造点**

- user 气泡（:146-148 分支）加 hover 操作条或 `@contextmenu.prevent`：两个按钮 emit `rewind: [msg]` / `fork: [msg]`；busy 门 = 新 props（`actionsDisabled`，由 ChatStream 透传 streaming/connecting）。
- 转发链：ChatStream emits（`frontend/src/components/chat/ChatStream.vue:26-30`）加 `rewind/fork` 转发 → ChatView 绑定（`frontend/src/views/ChatView.vue:272-279`）加 `@rewind/@fork`。
- 前置依赖：`Msg.entryId`（见问题 4）；无 entryId 的历史消息（旧数据/异常形状）不显示入口（0 信任，与 regenerate 的 `previousUserText` 空串隐藏先例同款）。

**规模：中**（组件 ~50-70 行 + ChatStream/ChatView 转发 ~15 行）。

## 3. ChatHeader（分支菜单）

**现状（证据）**

- `frontend/src/components/chat/ChatHeader.vue`（28 行）极简哑组件：props `{title, container, connecting}`（:3-7）+ `banner` slot（:9-11，当前无使用方）。**无 session 元数据展示**（无 updated_at/计数；标题在 ChatView `currentSessionTitle` :82-85 算好传入）。
- 结构适合：`.topbar` 是 flex 单行（:24），右侧追加下拉不破坏布局；且已具备 slot 扩展先例。

**改造点**

- 加 props `branches?: SessionBranchDTO[]` + `branchBusy?: boolean`，emit `branchSwitch: [leafEntryId: string]`；组件内用 el-dropdown（Element Plus 已全局引入）渲染，每项显示 headline + messageCount + updatedAt、active 项禁用——官方同构（`branches.length > 1` 才显示菜单，wa-dropdown placement bottom-end，control-ui bundle 实测）。数据源与加载时机在 useChatConnection/ChatView 侧（见问题 4/7），组件只渲染。
- 规模：中（组件 ~50-70 行）。

## 4. chatStore / useChatConnection（leaf entryId 数据流 + busy 状态）

**现状（证据）**

- **history 消息已携带 entryId，但当前被丢弃**：网关 `chat.history` 每条消息带 `__openclaw` 元数据 `{id, seq, idempotencyKey, turnBoundary, transcriptPosition, truncated?…}`（上游 `dist/chat-history-handler-DpOELHcj.mjs:77-96, 207-236` 实证；官方 Control UI 取 `message.__openclaw.id`，回退 `message.messageId`，作 `data-entry-id`）。我们的流经路径：`getHistory` 原样透传 messages（gatewayChat.ts:698-705）→ `loadHistory` 逐条 `translateHistoryMessage`（useChatConnection.ts:1221）→ 白名单投影成 `Msg`（useChatConnection.ts:1268-1295）——**`__openclaw.id` 在此被丢**（`HistoryMessageDTO` :37-41 虽 `[k:string]:unknown` 全透传，但 `Msg`（stores/chat.ts:20-41/59-70）无 entryId 字段）。
- 实时路：done 帧透出权威 `message`（eventTranslate.ts:503）但 handleDone 仅外来分支消费本体（useChatConnection.ts:443-449），本 run 不提取。
- 分页锚点 ≠ entryId：`SessionHistoryDTO.nextOffset` 是分页 cursor（number offset | string messageId 两态，gatewayChat.ts:83-96），与 transcript entryId 是不同字段，**不可混用作 CAS/rewind 参数**（Codex #678 P1 类型分发教训直接适用）。
- busy 状态：无 `hasActiveRun` 同名物，等价物齐全——`streaming` computed（useChatConnection.ts:1417、ChatView.vue:88 `messages.some(m => m.streaming)`；send 占位 push 即 `streaming=true`，chat.ts:66，覆盖 pendingSend 窗口）+ `connecting`（视图态）+ `disconnected`（composable :81）+ 审批 pending/工具 running（executionStatus :105-111 已有三态文案）。**禁用 rewind/fork/branch-switch 直接复用 `streaming || connecting || disconnected`，无需新增状态**。
- store 无分支状态：`branches` 需新增（贴 `sessions` 先例 chat.ts:88-93 + `setSessions` :129-131）。

**改造点（元数据挂载层）**

1. `Msg` 加可选 `entryId?: string`（stores/chat.ts）；`translateHistoryMessage` 提取 `m.__openclaw.id`（0 信任 string 门）——单点 choke point，三条历史路径（loadHistory/loadMoreHistory/外来 final 插入）自动全覆盖。
2. 当前会话 leaf entryId 的权威来源：`sessions.branches.list` 返回的 `active: true` 项 `leafEntryId`（官方分支菜单即此数据源）；展示侧来源 = 已翻译历史最后一条 user/assistant 消息的 `entryId`。空转录按官方语义显式传 `null`（authoritative empty transcript）。
3. CAS 传参策略：仅「rewind / branch-switch 成功后的第一次 send」由 UI 层显式携带（rewind 返回后本地已知新 leaf）；其余 send 不传（见问题 5）。
4. store 加 `branches` + setter（或视图本地 ref；入 store 贴先例）。

**规模：中**（Msg+提取 ~15 行；store ~10 行；leaf 计算 ~10 行）。

## 5. outbox 重放路径（CAS 故意省略点）

**现状（证据）**

- `frontend/src/chat/outboxStore.ts`（107 行）纯存储：`OutboxItem {id, text, createdAt}`（:9-13），**无 CAS 字段位，也无需加**。
- 重放触发点：`useChatConnection.syncSessions` :656-665（onReady 首连/重连统一路径，loadHistory 铺底后调 `resendOutbox`）；`resendOutbox` :1104-1143 内容级去重后 `myGw.send(sessionKey, item.text, undefined, item.id)`（:1129，第 4 参 = 复用幂等 key）。
- 正常发送路：`send()` :1061 同款四参调用。

**改造点**

- **预期零代码改动**：gatewayChat.send 的 `expectedLeafEntryId` 为可选参，重放路径不传即天然省略。要写进 spec 的条款：
  - expectedLeafEntryId **只在**「rewind / branch-switch 成功后的第一次 send」由 UI 显式传入；正常 send、outbox 重放、`regenerate` 重发路径一律不传——重放的是旧语境消息，网关幂等去重（idempotencyKey）已兜底，若传旧 leaf 会误触 `active-leaf-changed` 拒绝造成永久重发失败。
- 规模：小（0-5 行；主要是 spec 条款 + 「重放不携带 CAS」回归用例）。

## 6. ChatSidebar（fork 新 session 感知）

**现状（证据）**

- `frontend/src/components/chat/ChatSidebar.vue`（140 行）纯哑组件：渲染 `chat.sessions`（:83-101），emits `selectSession/removeSession/newSession`（:27-34）。**组件本身零改动**——sessions 数组响应式驱动，fork 新 session 只要进 store 自动出现。
- 会话列表更新机制现状：全量拉取 `syncSessions`（useChatConnection.ts:635-672）→ `chat.setSessions`；本地新增仅 `newSession` 路径 `chat.prependSession`（:1163）。
- **无 `sessions.changed` 订阅**：eventTranslate.translate（:322-398）只消费 `chat` 事件（:347 `if (event !== 'chat') return []`）+ 审批族（:327-335）+ agent 族（:337-346）——`sessions.changed` 事件帧直接落空。上游确有此事件（`docs/gateway/protocol/rpc-bootstrap-and-events.md:26,79`：session index/metadata 变更广播；fork 建行、标题生成完成均发）。
- fork 后切会话导航现状：`pickSession` :1172-1179（setSelectedSession + loadHistory）已完备。

**改造点**

- **最小改法（推荐）**：fork RPC 成功回调内本地 `chat.prependSession({session_key, title:'', updated_at: nowISO})` + `pickSession(newKey)` + `chat.setInput(editorText)`（官方「opens it and seeds its composer」同构，editorText 来自 fork 结果）——零事件订阅，单标签页语义完整。
- **增强（可选，多标签页感知才需要）**：eventTranslate 加 `sessions.changed` → 新帧类型，useChatConnection onFrame 分派 → 节流重拉 `syncSessions`。
- 规模：小（本地路径 ~15 行）～中（含事件订阅 ~40-60 行）。

## 7. eventTranslate（rewind/fork/branch-switch 事件与 transcript reset）

**现状（证据）**

- **上游无 rewind/fork/branch-switch 专属网关推送事件**——三者都是纯 RPC 应答式（`active-leaf-changed` 是 chat.send 的错误 reason 非事件；分支相关广播仅 `sessions.changed` 元数据级，见问题 6）。翻译层 `ChatFrame` 判别集（eventTranslate.ts:7-36）**无需新增帧类型**（除非做问题 6 的增强项）。
- **transcript reset 的客户端形态 = RPC 成功后主动 `loadHistory` 全量重建**，与既有「重连恢复 / 切会话」路径完全同构，无需新翻译。
- **#678 循环锚点分页对 reset 已天然安全**（逐点核对 useChatConnection.ts:1186-1249）：
  - `loadHistory` 开头 `chat.resetForSession()`（store :287-292 清 messages + historyHasMore/historyAnchor/historyLoading）——rewind 后调一次即完整重置分页态；
  - `++historyGen`（:1188）取代在途分页/旧 loadHistory（loadMoreHistory :1334 捕获 hgen 不自增、:1342 丢弃）——reset 期间的迟到响应安全；
  - 「不前进守卫」`seenAnchors` 是调用局部 Set（:1205）——每次重载重新开始，无跨次残留；cursor 类型分发（number→offset / string→messageId，gatewayChat.ts:691-696）不受影响。
  - 注：docs/research/ 无 `deltaCursor` 记载（grep 零命中）；#678 的锚点/cursor 语义实际记载于 gatewayChat.ts:83-96 接口注释与 loadHistory/loadMoreHistory 实现。
- 需要写进 spec 的两个防御点（均非缺口）：
  1. rewind/branch-switch 动作内先 `abandonActiveRun()` + `clearResumeWait()`（pickSession 先例 :1174-1175）——在途 run 的迟到 delta/final 不写入已重建的 transcript（abandonedRunIds/foreignRunIds 既有机制消化）；
  2. translator `sent` 累积器与 projection 的 reset 只在连接边界（onHello :536 / resetTranslator :284）——历史重建覆盖 messages 不需要动它；若 rewind 恰逢重连，onHello reset + syncSessions→loadHistory 已是现有闭环。

**规模：小**（翻译层零改动或仅问题 6 增强项 ~15 行；rewind/fork/branchSwitch 动作函数落 useChatConnection ~30-50 行，含 busy/断线守卫与 loadHistory 重建接线）。

---

## 改动文件清单汇总

| 文件 | 改动内容 | 规模 |
|---|---|---|
| `frontend/src/chat/gatewayChat.ts` | `send()` 加可选 `expectedLeafEntryId`（:707-723）；+4 RPC（`sessions.rewind/fork/branches.list/branches.switch`，贴 resolveApproval/listSessions 惯例）；+3 DTO（顶部 DTO 区）；GatewayChat 接口 +4 签名 | 中 ~90 行 |
| `frontend/src/stores/chat.ts` | `Msg.entryId?` 字段（:20-41/59-70）；`branches` 状态 + setter（贴 sessions 先例） | 小 ~15 行 |
| `frontend/src/chat/useChatConnection.ts` | `translateHistoryMessage` 提取 entryId（:1268-1295）；rewind/fork/branchSwitch 动作（abandonActiveRun + RPC + loadHistory 重建 + editorText 回填 + fork 后 prependSession/pickSession）；CAS「rewind 后首 send」标记 | 中 ~80-120 行 |
| `frontend/src/components/chat/ChatMessageItem.vue` | user 气泡 hover/右键 rewind/fork 入口 + emits（:146-148/:27） | 中 ~50-70 行 |
| `frontend/src/components/chat/ChatStream.vue` | rewind/fork emits 转发（:26-30/:211-222） | 小 ~6 行 |
| `frontend/src/components/chat/ChatHeader.vue` | 分支菜单 props/emit + el-dropdown（:3-21） | 中 ~50-70 行 |
| `frontend/src/views/ChatView.vue` | @rewind/@fork/@branch-switch 绑定 + busy 门复用 streaming/connecting/disconnected | 小 ~20 行 |
| `frontend/src/chat/eventTranslate.ts` | 可选：`sessions.changed` 帧（多标签页增强）；否则零改动 | 小 0-15 行 |
| `frontend/src/chat/outboxStore.ts` | **零改动**（重放路不传 CAS——spec 条款 + 回归用例） | 0 |
| `frontend/src/api/chat.ts` | **零改动**（已确认只剩 pairing/bootstrap-token，会话 CRUD/历史均走协议机 RPC，注释 :4 明示） | 0 |
| `frontend/src/chat/sessionProjection.ts` | **零改动**（归约器只管 run 终态，与分支无关） | 0 |
| 测试（gatewayChat/useChatConnection/eventTranslate/outboxStore `.test.ts`） | CAS 省略回归、4 RPC 0 信任校准、rewind 重建 reset、fork 导航、busy 门 | 中 ~60-100 行 |

**后端（server/）预判零改动**：chat RPC 浏览器直发容器网关，隧道只做握手 + 原始帧透传（ADR 0006）；唯一前置是 `deploy/openclaw-image` 镜像升级 2026.7.1 → 2026.9.x（#682 已决策），回归面 = 现有 RPC 行为变化，不在本测绘范围。

