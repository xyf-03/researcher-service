# RPC 精确形状提取：rewind / fork / branches / expectedLeafEntryId（#684）
> **来源**：wayfinder 研究票 [#684](https://github.com/ACautomata/researcher-service/issues/684) · 地图 [#682](https://github.com/ACautomata/researcher-service/issues/682) · 2026-09-12 · 基准 openclaw@2026.9.4（本机 npm 包 dist 源码实证）

基准：官方 npm 包 `openclaw@2026.9.4`（`/opt/homebrew/lib/node_modules/openclaw/`）。
证据标注：【源码】= dist 反编译确认（附文件与行号）；【文档】= 包内 docs 陈述；【推断】= 依据以上两者的推断，待实测验证。

通用事实（先读）：

- 响应帧（【源码】`dist/sessions-rlbLHLas.mjs:1428-1433`）：
  成功 `{ type:"res", id, ok:true, payload }`；失败 `{ type:"res", id, ok:false, error: ErrorShape }`。
  `ErrorShape = { code: string, message: string, details?: unknown, retryable?: boolean, retryAfterMs?: number }`（同文件 1412-1417）。handler 侧 `errorShape(code, message, opts)` 即 `{code, message, ...opts}`（【源码】`dist/error-codes-C3Z5XSDw.mjs:65-69`）。
- 错误码字符串（【源码】`dist/gateway-error-details-Brpdn9L1.mjs:14-20`）：`INVALID_REQUEST` / `FORBIDDEN` / `UNAVAILABLE` 等，**不是数字**。
- 四个方法全部注册在 `sessionRewindHandlers`（【源码】`dist/sessions-rewind-Dj-sygqb.mjs:53-70`，region 标记 `src/gateway/server-methods/sessions-rewind.ts`），经 `assertValidParams`（zod TypeBox 编译）先做参数校验，schema 全部为 `closedObject`（多余字段拒绝）。
- 权限 scope（【源码】`dist/method-scopes-tKV11oMS.mjs:1346-1367`）：

| method | scope |
|---|---|
| `sessions.branches.list` | `operator.read` |
| `sessions.branches.switch` | `operator.admin` |
| `sessions.rewind` | `operator.admin` |
| `sessions.fork` | `operator.write` |

  scope 不足错误（【源码】`dist/error-codes-C3Z5XSDw.mjs:84-85`）：`FORBIDDEN`，message `` `missing scope: ${missingScope}` ``，`details = { code: "MISSING_SCOPE", missingScope, requiredScopes: string[] }`。

---

## 1. sessions.rewind

**请求**（【源码】`dist/sessions-rlbLHLas.mjs:2434-2438` `SessionsRewindParamsSchema`）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `sessionKey` | string (minLength 1) | 是 | 会话 key（trim 后使用） |
| `agentId` | string | 否 | agent 域会话选择；缺省按 key 推断（`resolveRequestedSessionAgentId`，失败整单报错） |
| `entryId` | string | 是 | 目标**用户消息**的 transcript entry id；rewind 到「该消息之前」的活跃路径前缀 |

**响应 payload**（【源码】`sessions-rlbLHLas.mjs:2449-2452` `SessionsRewindResultSchema`）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `editorText` | string | 否 | 被剪掉的首条用户消息文本，回填 composer（【源码】`session-accessor-BxcCxteu.mjs` `resolveMessageCut`→`extractEditorText`：content 为 string 直接取，数组则拼接 text block） |
| `editorAttachments` | `{mimeType, data}[]` | 否 | 被剪消息里的图片附件（base64；最多 10 张，单张 ≤5MiB，超出直接丢弃该图）（【源码】同文件 `extractEditorAttachments`，`EDITOR_ATTACHMENT_LIMIT=10` / `EDITOR_ATTACHMENT_MAX_BASE64_CHARS`）；另支持 `__openclaw.media` 引用经 media store 回读（`sessions-rewind` handler `resolveEditorMediaAttachments`，同为 10 张上限） |

**错误全集**（【源码】`dist/sessions-rewind-Dj-sygqb.mjs:105-387`；除注明外均无 `details`）：

| 触发条件 | code | message |
|---|---|---|
| scope 不足 | `FORBIDDEN` | `missing scope: operator.admin` + MISSING_SCOPE details |
| 参数校验失败 | （校验器格式化错误） | assertValidParams 路径 |
| agent 解析失败 | — | `resolveRequestedSessionAgentId` 返回的 error |
| 会话不存在 | `INVALID_REQUEST` | `` `session not found: ${sessionKey}` `` |
| 会话初始化中 | `UNAVAILABLE` | `` `Session ${key} is initializing; retry rewind later.` `` |
| 会话被 fork 持有的 repository workspace 前置校验等变更 | `INVALID_REQUEST` | `` `Session ${key} changed; retry rewind.` ``（乐观并发：`sessionId`+`lifecycleRevision` 双重比对，prepare 与 run 各查一次） |
| agent 正在工作（活跃 run / 竞争 admission / worker inference） | `UNAVAILABLE` | `Rewind is unavailable while the agent is working.` |
| 已归档 | `INVALID_REQUEST` | `Rewind is unavailable for archived sessions.` |
| 外部 harness 拥有的会话（upstream link，非 fork 一律拒绝） | `INVALID_REQUEST` | `Session history changes are unavailable because this session is owned by an external agent harness.` |
| worker placement 不允许 | （placement 错误形状） | `respondSessionWorkerPlacementMutationError` |
| model selection 锁定 | `INVALID_REQUEST` | `Session history changes are unavailable while model selection is locked.`（`ModelSelectionLockedError.message`） |
| entryId 不存在 | `INVALID_REQUEST` | `` `message entry not found: ${entryId}` ``（status `missing-entry`） |
| entryId 不是持久化 user message | `INVALID_REQUEST` | `` `entry is not a user message: ${entryId}` ``（status `not-user-message`；assistant/tool/system 消息都拒绝） |
| entryId 不在活跃路径上（在别的分支） | `INVALID_REQUEST` | `` `message entry is not on the active path: ${entryId}` ``（status `off-active-path`） |
| 存储 backend 不支持 | `INVALID_REQUEST` | `session transcript storage does not support rewind`（status `unsupported-storage`） |
| 本地 mutation 抛异常 | `UNAVAILABLE` | `Failed to rewind the local session. Try again.` |
| 内部 failed 兜底 | `UNAVAILABLE` | `failed to rewind session` |

成功副作用：`clearSessionQueues` 清空该会话 pending 输入队列；transcript 换新代（见附录）；广播 `sessions.changed`（见 §5）。

## 2. sessions.fork

**请求**（【源码】`sessions-rlbLHLas.mjs:2440-2444`）：与 rewind 完全同形 `sessionKey` + `agentId?` + `entryId`（entryId 语义同上：从该持久化 user message 之前的活跃路径前缀 fork）。

**响应 payload**（【源码】`sessions-rlbLHLas.mjs:2453-2457` `SessionsForkResultSchema`）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `sessionKey` | string | 是 | **新会话 key**。本地 fork 由 `buildDashboardSessionKey(agentId, {incognito})` 生成（【源码】`sessions-rewind-Dj-sygqb.mjs:228`），incognito 属性继承源会话 |
| `editorText` / `editorAttachments` | 同 rewind | 否 | 同 rewind，seed 新会话 composer |

**权限**：`operator.write`（且 fork 额外走 `authorizeGatewaySessionCreation` 创建授权，【源码】`sessions-rewind-Dj-sygqb.mjs:135-145`）。

**`forkSource` 确切内容**（【源码】`session-accessor-BxcCxteu.mjs` `mutateSqliteSessionAtMessageInTransaction` + `cloneMessageCutSessionEntry`）：

```ts
forkSource = {
  sessionKey: canonicalSourceKey,   // 源会话 canonical key
  sessionId: currentEntry.sessionId, // fork 时刻源会话的 transcript generation id
  entryId: params.entryId,           // fork 切点（请求里的 entryId）
}
// 同时写 parentSessionKey = forkSource.sessionKey
```

即文档「exact source key + transcript generation」的精确形状（【文档】`docs/gateway/protocol/rpc-session-control.md:23`；【源码】落盘于 SQLite `session_nodes` 的 `fork_source_session_key` / `fork_source_session_id` / `fork_source_entry_id` 三列，`dist/openclaw-agent-db-fItexY2B.mjs:47` DDL）。该字段出现在会话行投影（sessions 列表行 / `sessions.changed` 快照，`dist/session-event-payload-6znNKcu1.mjs:58`）。

**错误**：与 rewind 同表，差异点——
- 建会话授权失败：`authorizeGatewaySessionCreation` 的错误形状；
- upstream 外部 harness 会话**允许** fork（rewind/switch 拒绝），但要求恰好一个注册 harness 支持 `sessionFork.upstreamKinds`；失败时 `details = { reason: "upstream-unavailable" }`（code `UNAVAILABLE`）或其他 upstream code（code `INVALID_REQUEST`）（【源码】`sessions-rewind-Dj-sygqb.mjs:233-268`）；
- fork **不清**源会话队列，改为 `recordSessionCreated` 注册新会话行。
- 注意 fork 的切点也要求 user message + 活跃路径（与 rewind 同一套 `resolveMessageCut`）；新 transcript 只复制切点前 prefix，**不带** leaf 控制事件。

## 3. sessions.branches.list / sessions.branches.switch

**`sessions.branches.list` 请求**（【源码】`sessions-rlbLHLas.mjs:2466-2469`）：`sessionKey`（必填）+ `agentId?`。

**响应**（`SessionsBranchesListResultSchema`，2470）`{ branches: SessionBranch[] }`，`SessionBranch`（2458-2464）：

| 字段 | 类型 | 必填 | 语义（【源码】`session-accessor-BxcCxteu.mjs` `summarizeSessionBranch`） |
|---|---|---|---|
| `leafEntryId` | string | 是 | 该分支（DAG tip）的叶子 entry id，即 switch 的 `leafEntryId` 参数值 |
| `headline` | string | 是 | 分支最新一条消息摘要：assistant 取 phase text、user 取 editor text，空白折叠，**截断到 120 字符**（119 + `…`，`BRANCH_HEADLINE_MAX_CHARS=120`） |
| `messageCount` | integer ≥0 | 是 | 该路径上 `type==="message"` 事件总数（user+assistant 都计） |
| `updatedAt` | string | 否 | tip 节点的 ISO timestamp（无则省略）——Control UI 的 recency 列 |
| `active` | boolean | 是 | 是否当前活跃分支（`tree.leafId === leaf.id`） |

- 排序：active 优先，其余按 tip 索引新→旧（【源码】`summarizeSessionBranches` 的 `toSorted`）。
- 分支 = 「无子节点的消息节点」∪「当前 leaf」（leaf 控制事件不算 tip，【源码】`sessionBranchTipNodes`）。
- 会话无 transcript / upstream link 会话 → 返回**成功** `{ branches: [] }`（【源码】`sessions-rewind-Dj-sygqb.mjs:85-92`）。
- 错误：`missing-session`→`INVALID_REQUEST` "session not found"；`unsupported-storage`→`INVALID_REQUEST` "session transcript storage does not support branch listing"；`failed`→`UNAVAILABLE` "failed to list session branches"（【源码】`respondBranchListError`）。
- 服务端有 32 条 LRU 缓存，按 `(generation, maxSeq)` watermark 失效（内部实现，不影响协议形状）。
- **分支菜单三件套（最新消息/消息数/recency）全部来自本 RPC**（【文档】`docs/web/control-ui/chat.md:97` 与【源码】字段一一对应）。

**`sessions.branches.switch` 请求**（【源码】`sessions-rlbLHLas.mjs:2472-2476`）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `sessionKey` | string | 是 | |
| `agentId` | string | 否 | |
| `leafEntryId` | string | 是 | 目标分支 tip 的 entryId（来自 list 的 `leafEntryId`）。注意字段名与 rewind/fork 的 `entryId` 不同 |

**响应**：`{}`（空对象，`SessionsBranchesSwitchResultSchema = closedObject({})`；handler 对 switch 返回 `{}`，无 editorText）。

**typed no-op**：选已活跃分支 → `INVALID_REQUEST`，message `` `branch is already active: ${entryId}` ``（内部 status `already-active`，【源码】`validateBranchTip` + `respondMessageCutError`）。文档同述「selecting the already-active branch is a typed no-op error at the RPC boundary」（【文档】`chat.md:97`）。其余错误：目标不是任何分支 tip → `entry is not a branch tip: ${entryId}`；不存在 → `branch entry not found: ${entryId}`；agent 工作中 → `Branch switch is unavailable while the agent is working.`；归档 → `Branch switch is unavailable for archived sessions.` 等（同 §1 表，message 前缀换 Branch switch）。

## 4. chat.send + expectedLeafEntryId

**参数 schema**（【源码】`sessions-rlbLHLas.mjs:1749-1771` `ChatSendParamsSchema`，关键 CAS 字段）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `expectedLeafEntryId` | `string \| null`（`Type.Union([NonEmptyString, Type.Null()])`，optional） | 否 | transcript 分支 CAS。**三态**：缺省（undefined）=不校验；string=要求该 entryId 是活跃路径 leaf（或祖先，见下）；`null`=**权威空 transcript CAS**（仅当活跃 transcript 为空时通过） |
| `sessionId` | string | 否 | 调用方看到的当前 sessionId。**CAS ancestor 放行的必要条件** |
| `queueMode` | `"steer" \| "followup" \| "collect" \| "interrupt"` | 否 | `"steer"` 时 CAS 完全被忽略 |

**精确行为**（【源码】`dist/chat-send-handler-oS9rX200.mjs`）：

1. 归一化：`expectedLeafEntryId === null ? null : normalizeOptionalChatText(...)`（3686 行）——字符串做空白归一，null 保留。
2. 校验时机：admission 阶段、`commitOutcome && queueMode !== "steer" && expectedLeafEntryId !== undefined` 时调用 `assertExpectedLeafActive`（3955 行，region `chat-send-pre-admission` / work-start）。即 **steer 忽略；其余模式都校验**。【推断】校验发生在新用户消息落盘前的准入点（错误归类在 pre-admission region）。
3. 关系判定 `readSessionTranscriptActivePathEntryRelation`（【源码】`session-accessor-BxcCxteu.mjs:5551-5562`）：对照物化活跃投影（`session_transcript_index_state.leaf_event_id` + `transcript_event_identities` ⋈ `session_transcript_active_events`）：
   - `entryId === leafEventId` → `"exact"`；
   - `entryId === null` → 仅当 `leafEventId` 也为 null（空 transcript）才 `"exact"`，否则 `"off-path"`（**null 的权威空语义在此实现**）；
   - entryId 存在于活跃路径投影但非 leaf → `"ancestor"`；
   - 查不到 → `"off-path"`。会话无 sessionId 时：`null → "exact"`，否则 `"off-path"`。
4. 放行规则（【源码】`assertExpectedLeafActive` 3614-3622）：
   - 前置：若传了 `sessionId`，必须等于当前 `session.entry.sessionId`，否则直接 throw；
   - `"exact"` → 放行；
   - `"ancestor"` → **仅当调用方同时传了 `sessionId` 且匹配当前 sessionId** 才放行（即：期间只追加了新消息、未换代/未切分支）；
   - 其余（`"off-path"`、无 sessionId 的 ancestor）→ throw `ACTIVE_LEAF_CHANGED_ERROR_REASON`。
   - **结论：前端应回传 `chat.history`/`chat.startup` 给的 `sessionId`**（session 行的 transcript generation id），它同时启用 ancestor 放行和重连恢复语义。
5. 拒绝错误（【源码】`respondChatSendAdmissionError` 3341-3343）：`INVALID_REQUEST`，message `active branch changed; review and retry`，**`details` 只有一个字段：`{ reason: "active-leaf-changed" }`**——没有其他字段。
6. 附加：通过后 `expectedLeafEntryId` 以 `originatingLeafEntryId` 透传进 run 上下文（【源码】2811 行；具体消费方未追，标注【推断】仅记录）。
7. 【文档】佐证：`docs/gateway/protocol/rpc-session-control.md:39`——「independent transcript-branch compare-and-swap for non-steer interactive sends: pass the displayed branch leaf (or deliberate `null` for an authoritative empty transcript) … rejects with `details.reason: "active-leaf-changed"` … steer sends ignore it」。

## 5. 事件广播

三个 mutation 的 handler 只做一种广播：`emitSessionsChanged(context, { sessionKey, agentId, reason })`（【源码】`sessions-rewind-Dj-sygqb.mjs:271-280, 371-375`）：

| action | reason | 广播 sessionKey |
|---|---|---|
| fork | `"fork"` | **新 fork 会话的 key** |
| rewind | `"rewind"` | 源会话 canonical key |
| branch switch | `"branch-switch"` | 源会话 canonical key |

`emitSessionsChanged` 行为（【源码】`dist/session-change-event-njg2QdFD.mjs`，region `src/gateway/server-methods/session-change-event.ts`）：

- 事件名 **`sessions.changed`**，仅推给订阅了 sessions 事件的连接（`getSessionEventSubscriberConnIds`，需先 `sessions.subscribe`，【文档】`docs/gateway/clients.md:255`），`dropIfSlow: true`，按 key 定向（`sessionKeys: [key]`）。
- **防抖**：同 (agentId, sessionKey) 100ms 合并（payload 被最新覆盖），最长延迟 500ms；首个立即广播。
- payload = `{ sessionKey, agentId?, reason, ts: number }` **融合 reload 后的完整会话快照**（`buildGatewaySessionSnapshot`：含 `sessionId`、`forkSource`、`previousSessionId`、`updatedAt` 等，`dist/session-event-payload-6znNKcu1.mjs`）——第二个标签页能直接从事件里读到**新 sessionId**。
- **没有 transcript delta / chat 事件推送**：rewind/switch/fork 不产生 agent run，handler 无任何 chat broadcast（【源码】该文件仅 `clearSessionQueues` / `recordSessionCreated` / `emitSessionsChanged`）。另外 rewind/switch 会清空 pending inputs 队列（第二个 tab 的 pendingInputs 消失）。
- 同 session 第二个标签页的实时观感（【推断】，由上述机制推导）：收到一次 `sessions.changed`（reason=`rewind`/`branch-switch`/`fork`，快照内 sessionId 已变）→ 应重新拉 `chat.history`（全量，拿新 `activeLeafEntryId`）与 `sessions.branches.list`；若它持旧 cursor 走 delta 增量读，generation/leaf 变化会得到 `kind:"reset"`/`"unavailable"`（【源码】`dist/server-runtime-subscriptions-dSZ219Ld.mjs:131-158` 比较 `activeLeafEntryId/generation/indexedSeq/totalMessages`）。

## 6. 前端数据入口

| 数据 | 来源 | 证据 |
|---|---|---|
| 当前分支叶子 entryId | `chat.history` **尾页**响应顶层字段 **`activeLeafEntryId: string \| null`**（仅 offset 缺省或 0 的尾页携带；翻页页不携带；无 transcript 时为 `null`） | 【源码】`dist/chat-history-handler-DpOELHcj.mjs:421-426`（`resolveChatHistoryActiveLeafEntryId`：非 active 源→null；否则取投影 `leafEventId` 或从事件扫描），500/517 行输出；346 行空会话给 `activeLeafEntryId: null` |
| 同上（替代入口） | `chat.startup` 响应 `sessionInfo.activeLeafEntryId`（`Object.hasOwn(historyPage,"activeLeafEntryId")` 时写入）；cursor 增量响应同样带 `sessionInfo.activeLeafEntryId` | 【源码】同文件 847、922 行 |
| 值的权威源 | 物化投影 `session_transcript_index_state.leaf_event_id`（即 `projection.state.leafEventId`） | 【源码】`dist/session-transcript-readers-BZjuw2hz.mjs:2811` 等 |
| sessionId（CAS ancestor 放行要回传） | `chat.startup` `sessionInfo.sessionId` / 会话行投影 `sessionId` / `sessions.changed` 快照 | 【源码】`session-event-payload-6znNKcu1.mjs:15` |
| 分支列表 | **专用 RPC `sessions.branches.list`**——`chat.history`/`chat.startup`/`sessions.list` 均**不**携带分支数组（grep 无 branch 列表投影） | 【源码】全 dist 检索确认 |
| fork 来源信息（列表行展示用） | 会话行投影 `forkSource: {sessionKey, sessionId, entryId}` 与 `parentSessionKey`（sessions 列表 / `sessions.changed` 快照） | 【源码】`session-event-payload-6znNKcu1.mjs:58, 68`；【文档】rpc-session-control.md:23 |

## 附录：存储机制（理解形状用，全部【源码】）

- transcript 是**事件 DAG**（append-only）：SQLite 表 `transcript_events(session_id, seq, event_json)`；`transcript_event_identities(session_id, event_id→seq, event_type, parent_id)`；活跃路径物化在 `session_transcript_active_events` + `session_transcript_index_state`（含 `leaf_event_id`、`active_message_count`）（DDL：`dist/openclaw-agent-db-fItexY2B.mjs:47`）。
- rewind/switch **追加**一个 `{type:"leaf", id, parentId, timestamp, targetId}` 控制事件把活跃路径重定向到 `targetId`，然后**整体复制进新 sessionId（随机 UUID）**——即每次 rewind/switch/fork 都换 transcript generation；`session_windows.reason` 枚举恰好含 `'fork' | 'rewind' | 'switch'`。entry 上 rewind/switch 记 `previousSessionId`，fork 记 `forkSource`+`parentSessionKey`；fork 才换 `lifecycleRevision`（rewind/switch 保持）。
- 旧分支不删除——它们留在旧 generation 的 DAG 里，靠 `sessions.branches.list` 扫描 tips 暴露（文档「the pre-rewind transcript remains preserved in the append-only session store」，`chat.md:97`）。
- 乐观并发：mutation 前后比对 `sessionId` + `lifecycleRevision`（`expectedState`），不一致报 `conflict`。

## TypeScript DTO 草案

```ts
// ===== 通用 =====
type GatewayErrorCode =
  | "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE" | (string & {});

interface GatewayError {
  code: GatewayErrorCode;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

// ===== sessions.rewind =====
interface SessionsRewindParams {
  sessionKey: string;
  agentId?: string;
  entryId: string;               // 必须是活跃路径上的持久化 user message
}
interface SessionEditorAttachment { mimeType: string; data: string; } // base64
interface SessionsRewindResult {
  editorText?: string;           // 被剪首条用户消息 → 回填 composer
  editorAttachments?: SessionEditorAttachment[]; // ≤10 张图片
}

// ===== sessions.fork =====
type SessionsForkParams = SessionsRewindParams;
interface SessionsForkResult extends SessionsRewindResult {
  sessionKey: string;            // 新会话 key
}
interface ForkSource {           // 会话行投影里的 forkSource
  sessionKey: string;
  sessionId: string;
  entryId: string;
}

// ===== sessions.branches =====
interface SessionsBranchesListParams { sessionKey: string; agentId?: string; }
interface SessionBranch {
  leafEntryId: string;
  headline: string;              // ≤120 chars
  messageCount: number;
  updatedAt?: string;            // ISO
  active: boolean;
}
interface SessionsBranchesListResult { branches: SessionBranch[]; }
interface SessionsBranchesSwitchParams {
  sessionKey: string;
  agentId?: string;
  leafEntryId: string;           // 注意：字段名不是 entryId
}
type SessionsBranchesSwitchResult = Record<string, never>; // {}

// ===== chat.send（CAS 相关切片）=====
interface ChatSendCasParams {
  sessionId?: string;            // 回传 chat.startup/history 的 sessionId：启用 ancestor 放行
  expectedLeafEntryId?: string | null;
  // undefined = 关闭 CAS；string = leaf/ancestor CAS；null = 权威空 transcript CAS
  queueMode?: "steer" | "followup" | "collect" | "interrupt"; // steer 忽略 CAS
}
// CAS 拒绝：
// { code: "INVALID_REQUEST", message: "active branch changed; review and retry",
//   details: { reason: "active-leaf-changed" } }

// ===== 前端数据入口 =====
interface ChatHistoryTailResult {
  activeLeafEntryId: string | null; // 仅尾页（offset 缺省/0）；null = 空 transcript
  deltaCursor?: string;
  messages: unknown[];              // 展示投影，非本 issue 范围
  pagination?: { offset: number; totalMessages: number; rawPageMessages: number };
}
interface ChatSessionInfo {
  sessionId?: string;
  activeLeafEntryId?: string | null;
  forkSource?: ForkSource;
  parentSessionKey?: string | null;
}

// ===== sessions.changed 事件 =====
interface SessionsChangedPayload {
  sessionKey: string;
  agentId?: string;
  reason: "fork" | "rewind" | "branch-switch" | (string & {});
  ts: number;
} // 融合完整会话快照字段（sessionId / forkSource / previousSessionId / updatedAt …）
```

### 移植要点（给 researcher-service）

1. 四个 RPC 均为「请求校验 → 乐观并发（sessionId+lifecycleRevision）→ 排他 mutation → envelope 响应」同构流程，可共用一个 mutate 框架。
2. DTO 落地最少集合：`SessionBranch`、`ForkSource`、`ChatHistoryTailResult.activeLeafEntryId`、CAS 错误 details。`reason` 枚举按上表硬编码。
3. 前端发消息必须缓存 `sessionId` + 尾页 `activeLeafEntryId`；切分支/rewind 后两者都要刷新（否则 CAS 会以 `active-leaf-changed` 拒绝——这正是期望行为）。
4. 未实测项【文档推断，待实测验证】：校验失败的具体错误 message 格式（assertValidParams 内部格式化）；`originatingLeafEntryId` 的下游消费；`sessions.changed` 快照字段的完整清单（以 `buildGatewaySessionSnapshot` 实际输出为准）。

