# 官方 Control UI rewind/fork/分支菜单交互状态机还原（#685）
> **来源**：wayfinder 研究票 [#685](https://github.com/ACautomata/researcher-service/issues/685) · 地图 [#682](https://github.com/ACautomata/researcher-service/issues/682) · 2026-09-12 · 基准 openclaw@2026.9.4 control-ui 打包产物（Lit + Vite minified 实测反解）

研究对象：本机全局 npm 包 `/opt/homebrew/lib/node_modules/openclaw/dist/control-ui/`（openclaw 2026.9.4，Lit + Vite minified 产物）。
权威文档锚点核实：issue 所指 `docs/web/control-ui/chat.md:97` **就在该 npm 包内**（`/opt/homebrew/lib/node_modules/openclaw/docs/web/control-ui/chat.md:97`），逐句与打包实现比对一致；researcher-service 仓库内无此文件。

主要证据文件（下文以短名引用）：

- `docs` = `/opt/homebrew/lib/node_modules/openclaw/docs/web/control-ui/chat.md`
- `Bpwd` = `dist/control-ui/assets/control-ui-boot-shared-BpwdVi0Y.js`（transcript/消息组/上下文菜单/确认弹层/分支菜单/队列行/标题栏）
- `jc3` = `dist/control-ui/assets/control-ui-boot-shared-jc3M3nDf.js`（聊天状态机：RPC 权限映射、rewind/fork/switchBranch 状态机、chat.send、outbox 泵、expectedLeafEntryId）
- `CUh` = `dist/control-ui/assets/control-ui-core-CUhKaXUc.js`（RPC wrapper + sessions 门面）
- `Cgy` = `dist/control-ui/assets/control-ui-core-CgyBiPIN.js`（i18n 文案表）
- `CVh` = `dist/control-ui/assets/control-ui-boot-shared-CVhtgdUv.js`（IndexedDB outbox 持久化）
- CSS = `dist/control-ui/assets/control-ui-boot-shared-BlRXfaim.css`

引用格式 `文件 @ 行 N / 字节 X`（minified 单行文件，行号 + 字节偏移定位）。

---

## 1. rewind 入口与确认

### 入口（两个，共用同一状态机）

**入口 A：消息 footer hover 按钮**（`Bpwd @ 206174`，组渲染函数 `h_`）。user 消息组 footer 渲染 `div.chat-group-footer-actions[data-message-actions-for]`，内含 reply / rewind / copy 三按钮；rewind 按钮模板（`ad`）：

```
<span class="chat-confirm-wrap chat-rewind-wrap">
  <openclaw-tooltip .content="Rewind">
    <button class="chat-group-rewind" aria-label="Rewind" @click=…>${icon.refresh}</button>
  </openclaw-tooltip>
</span>
```

渲染条件：`t.onRewind && !t.rewindDisabled` —— **agent working 时该按钮整体不渲染**（不是 disabled 态）。CSS 证实 hover 才显现：`chat-group-footer-actions{position:absolute;opacity:0;pointer-events:none}`，hover/focus-visible 时 `opacity:1;pointer-events:auto`（CSS 文件）。仅 persisted user 消息可 rewind：`onRewind` 仅在该组携带 entryId 时注入（`Bpwd @ 350480`：`onRewind: a && e.onRewindMessage ? … : void 0`，a=entryId）。

**入口 B：右键上下文菜单**（`Bpwd @ 309264`，构建函数 `zy`）。右键 `.chat-bubble`（须在 user 组内且有 entryId）弹 `div.chat-reply-context-menu[role=menu][aria-label="Message actions"]`，按光标定位并做视口夹取；菜单项依序：Copy（有选区时）、Reply、**Rewind to here**、Copy message、**Fork from here**。rewind/fork 项 `disabled = !!(runActive||runWorking)`，tooltip 同步换成不可用文案（见 §3）。触摸长按走 `chat-group--meta-revealed` 显露同组按钮。

### 确认 popover（`Bpwd @ 38100–38900`，`ad/od/sd` 三函数）

两个入口共用：点按钮先查偏好 `$u()` = `storage.getItem(preferenceName)==='1'`，为真直接执行；否则 `sd()` 动态建 `div.chat-confirm-popover` 挂 body：

```html
<div class="chat-confirm-popover" role="dialog" aria-modal="true" aria-label="…">
  <p  class="chat-confirm-popover__text">Rewind to before this message?</p>
  <label class="chat-confirm-popover__remember">
    <input type="checkbox" class="chat-confirm-popover__check"><span>Don't ask again</span>
  </label>
  <div class="chat-confirm-popover__actions">
    <button class="chat-confirm-popover__cancel">Cancel</button>
    <button class="chat-confirm-popover__yes">Rewind</button>
  </div>
</div>
```

- 定位：trigger 上/下自动翻转（`data-placement=below|above`，边距 8px/6px，视口夹取）；CSS：卡片底、1px 边框、radius 8px、阴影 `0 8px 24px #0006`、`scale-in` 动画、z-index 10000、yes 按钮 danger 红、cancel 灰（CSS `@ byte ~1800`）。
- 关闭路径：Escape（restoreFocus 回 trigger）、点外部、右键外部、再点 trigger（toggle）；Tab 循环焦点锁在 checkbox+yes 之间。
- **Yes 流**：若勾选 Don't ask again → `try{storage.setItem(preferenceName,'1')}catch{}` → 关闭 → 执行 action。

### "Don't ask again" 持久化位置

- key：**`openclaw:skip-rewind-confirm`**（`Bpwd` 内 `hd()` 初始化：`cd=\`openclaw:skip-rewind-confirm\``，@ 字节 ~38900）。
- 值：字符串 `'1'`；两个入口共用同一 key。
- 位置：**浏览器 localStorage**（storage accessor 为 `window.localStorage` 的安全封装，见 `CUh @ 8180`：`try{let t=window['localStorage'];…}catch{return null}`），读写均 try/catch 容错——存储不可用时静默退化为「每次都确认」。**无服务端 profile 同步**（全包 grep 无该 key 的 RPC 上报）。

UI 文案（`Cgy @ 183529`，i18n `chat.messages.*`）：`rewind:"Rewind"`、`rewindConfirm:"Rewind to before this message?"`、`dontAskAgain:"Don't ask again"`、`rewindToHere:"Rewind to here"`、`forkFromHere:"Fork from here"`、`cancel` 来自 `common.cancel`。

---

## 2. rewind pending 期间的 composer 行为

状态机 = `Wy(e, entryId)`（`jc3 @ 115866`），由 pane 方法 `rewindToMessage` 包装（`jc3 @ 284357`）：

```
1. 前置：无连接直接返回 null
2. 指纹快照 u = zc(chatMessage, chatAttachments, chatGoalDraftMode, chatMentions)   ← RPC 前抓取
3. await sessions.rewind(sessionKey, entryId, agentScope)   ← pending 区间（单次 awaited RPC，无显式取消 UI）
4. a = resp.editorText ?? ''
5. 清该 session 消息缓存（Gu）；若仍同 session+agent：
   Pv(重置本地 run/stream 状态) + await Promise.all([Q(拉全量 history), Vv(拉分支列表)])
6. 草稿守卫（关键）：
   !connectionCurrent() || !sessionLocal() || fingerprint()!==u
   → return null：composer 一字不动（新草稿与附件原地保留），仅 transcript 完成 rewind+刷新
   否则：
   jc(sessionKey,{draft:a, mentions:[], goalMode:null, expectedDraftRevision})   ← 写 editorText 进 draft store
   chatGoalDraftMode=null; chatAttachments = merge(chatAttachments, resp.editorAttachments)
   handleChatDraftChange(a, [])
7. 返回响应对象 → 调用侧 `resp && onFocusComposer()`（`Bpwd @ 350480`：`Promise.resolve(onRewindMessage(entryId)).then(t=>{t&&onFocusComposer()})`）
```

- **文本回 composer 的时机**：RPC 成功且守卫全过后一次性回填（editorText 覆盖式写入 draft store，同时合并服务端返回的 editorAttachments）。
- **与已有草稿共存**：即 docs 原文 "If you edit the composer while rewind is pending, your newer draft and attachments stay in place"（`docs:97`）——指纹不等就放弃回填；注意 transcript rewind 本身不回滚（第 5 步在守卫之前），守卫只保护 composer。
- **可取消性**：无取消按钮；隐式取消 = 连接更替 / 切换会话 / 用户编辑草稿（任一命中即放弃 composer 回填）。composer 在 pending 期间不锁定（`Wy` 不置 `chatSending`）。

---

## 3. agent working 禁用判断

- 判定式（`Bpwd @ 350585`，transcript props）：**`rewindDisabled: !!(e.runActive || e.runWorking)`**。
  - `runActive`：本地 `chatRunId` 存在，或 sessions 列表报告该 session 有活动 run（参照 `jc3 @ 114056` 的 `zy(e)`）。
  - `runWorking`（`jc3 @ 367247`：`p = chatSending || ml({runActive, queue, runStatus, sessionKey})`；ml 即 `Bpwd` 的 `jw` @ `runActive===!0&&!kw(e.runStatus)`）：`= (runActive && runStatus.phase ∉ {done, interrupted}) || queue 中存在本 session 的 sending/waiting-model 行（且非 pendingRunId、非当前 run 的行）`，外加 placement startup 未完成。
- 三处消费（形态不同）：
  1. hover rewind 按钮：disabled 时**不渲染**（`Bpwd @ 206412`：`t.onRewind && !t.rewindDisabled ? ad(t.onRewind) : I`）。
  2. 右键菜单项：`?disabled` + tooltip 换文案（`Bpwd @ 308954`：`disabled:y, tooltip: y ? rewindUnavailable : rewindToHere`）。
  3. 分支菜单 trigger：`?disabled` + `title=branchSwitchDisabledReason`（见 §5）。
- tooltip 文案（`Cgy @ 183529`）：**"Rewind is unavailable while the agent is working"** / **"Fork is unavailable while the agent is working"**；分支：**"Branch switch is unavailable while the agent is working."**（`Cgy @ 167995`）。
- 权限层（`jc3 @ 86018`，RPC 权限映射 `J_`）：`sessions.rewind → operator.admin`、`sessions.fork → operator.write`、`sessions.branches.switch → operator.admin`、`sessions.reset/compact → operator.admin`、abort → `chat.abort`（有本地 run）或 `sessions.abort`。无权限时回调直接不注入（`jc3 @ 392667` `BE`：`onRewindMessage: n.rewind.allowed ? … : void 0`）或拒绝时 `publishHeaderError(reason)`。另有 `onRewindMessage: r ? void 0 : …`（r=当前会话已归档时禁用）。
- docs 补充（`docs:97`）：rewind/fork "apply only to persisted user messages, and are rejected for sessions whose conversation is owned by an external agent harness"——后者为 Gateway 侧判定，UI 打包产物只能看到权限/归档 gate（见「无法确认」节）。

---

## 4. fork 成功后的导航

状态机 = pane 方法 `forkFromMessage(entryId)`（`jc3 @ 284357`）：

```
1. captureConnectionScope；await sessions.forkAtMessage(sessionKey, entryId, agent)
   → RPC sessions.fork {sessionKey, agentId?, entryId}（CUh @ 38210 `Vo`）
   → 响应 { sessionKey(新), editorText, editorAttachments }；门面层随后 refreshReplacement 刷新 sessions 列表（CUh @ 141313）
2. 守卫：仍持有 pane 输出权 && 原 session 仍本地存在 && onPaneSessionChange(paneId, 新sessionKey) !== false
3. 导航：onPaneSessionChange 把**当前 pane 原地切到新 session**（非新浏览器 tab；返回 false=导航被拒则中止，不播种）
4. composer 播种：jc(新sessionKey, {agentId, draft: editorText??'', mentions: []})
   + nx(context, paneId, 新sessionKey, {attachments: editorAttachments, draft})
5. 失败 → n.lastError/chatError banner（jc3 @ 285071 catch）
```

- 与 rewind 的差异：**无确认 popover**（右键 onClick 直接 `Ny(); onForkMessage(entryId)`，`Bpwd @ 308954`）、**不回填当前 composer 而是播种新 session 的 composer**、无指纹守卫（新 session draft store 本就为空）。
- docs 语义（`docs:97`）："Fork creates a new session from the active-path prefix before the message, opens it, and seeds its composer with the same text"——代码证实「opens it」= 当前 pane 替换视图；`leafEntryId` 前缀之前的历史构成新会话。

---

## 5. 分支菜单 UI（标题栏）

### 数据面（`jc3 @ 95089`）

- `Vv(e)`：`sessions.listBranches` → RPC `sessions.branches.list {sessionKey, agentId?}`（`CUh @ 38210` `Ho`，响应取 `.branches`）；带 branchVersion/connectionEpoch/agent 归属四重 stale guard，成功写 `chatBranches / chatBranchesSessionKey / chatBranchesConnectionEpoch`（初始 `chatBranches:[]`，`jc3 @ 220627`）。
- `Bv(e)`：仅当缓存 sessionKey===当前 sessionKey 才返回（防串会话）。
- 失效：`session.operation` 事件 reason ∈ `{rewind, branch-switch, fork, reset, new}`（`jc3 @ 316898` `qT` 集合）→ `branchVersion++`、清空 `chatBranches`、当前会话立即重拉；历史加载 `Q(e,{deferBranches})` 协同。

### DOM（`Bpwd @ 454723`，标题栏 trailing 槽；仅 `branches.length>1 && !catalog` 时渲染）

```html
<wa-dropdown class="chat-pane__branches-menu" placement="bottom-end" @wa-select=…>
  <button slot="trigger" class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
          ?disabled={!!branchSwitchDisabledReason}
          title={branchSwitchDisabledReason ?? "Session branches"}
          aria-label="Session branches">{icon.gitBranch}</button>
  {for branch of branches}
  <wa-dropdown-item class="chat-pane__branch-item" value={branch.leafEntryId}
                    ?disabled={branch.active || !!disabledReason} data-active={…}>
    <span class="chat-pane__branch-copy">
      <span class="chat-pane__branch-headline">{branch.headline || "Untitled branch"}</span>
      <span class="chat-pane__branch-meta">{"{count} message(s)"}{branch.updatedAt ? " · " + fmt(updatedAt) : ""}</span>
    </span>
    {branch.active ? <span class="chat-pane__branch-active" aria-label="Active branch">{icon.check}</span> : …}
  </wa-dropdown-item>
</wa-dropdown>
```

- **每条分支渲染字段**：`headline`（最新消息预览，空 → "Untitled branch"）、`messageCount`（`chat.sessionHeader.oneMessage:"{count} message"` / `messages:"{count} messages"`，`Cgy @ 167995`）、`updatedAt` 经 `DT()` 格式化的 recency（具体格式化细节无法从产物确认，docs 描述为 "recency"）。当前活动分支：check 图标 + "Active branch" aria-label（非文本标签）。
- `branchSwitchDisabledReason` 三态（`jc3 @ 367247`）：已归档 → "This session is archived. Unarchive it to continue the conversation."；无权限 → 权限 reason；`chatSending || working(同 §3 谓词)` → **"Branch switch is unavailable while the agent is working."**；否则 null（可用）。

### 切换确认流程

`wa-select` → 前置 guard `value && branch && !branch.active && !disabledReason`（**active 项 disabled，UI 从不发送已活动分支的切换**）→ `onBranchSelect`（`jc3 @ 370682`）再过 `J_.branchSwitch` 权限 gate（拒绝 → `publishHeaderError`）→ `switchToBranch` → `Gy` 状态机（`jc3 @ 116587`）：`await sessions.branches.switch {sessionKey, agentId?, leafEntryId}`（`CUh @ 38210` `Uo`）→ 清该 session 消息缓存 → `Pv` 重置本地 run 态 → `Promise.all([Q(history), Vv(branches)])` → 校验连接/会话仍一致。**无确认弹层**（与 rewind 不同，直接切换）。失败 → chatError banner。
「选已活动分支是 typed no-op error at the RPC boundary」：UI 层不触发，Gateway 侧行为无法从 UI 产物确认（见文末）。

---

## 6. active-leaf-changed 冲突状态机（send 被拒 → park UI）

### 冲突判定与文案

- 哨兵常量 `aw='active-leaf-changed'`（`jc3 @ 199046`）；`rw(e)` = `e instanceof Pn && e.details.reason==='active-leaf-changed'`（Gateway RPC typed 错误）。
- 发送侧乐观并发控制：composer 提交时抓 `g=nw(e)`（= `chatDisplayedLeafEntryId`；该值来自历史加载响应的 `sessionInfo.activeLeafEntryId`，`jc3 @ 106551/108513`；null=已知无 leaf、undefined=未知；`nw` trim 后 undefined 不发送）→ `chat.send` 带 `expectedLeafEntryId`（`tw` @ `jc3 199007`：`...t.expectedLeafEntryId===void 0?{}:{expectedLeafEntryId}`；**steer 模式永不带**）。
- 被拒（`jc3 @ 204761` catch）：
  - `o=rw(err)` → 错误文案 = `chat.sendErrors.activeLeafChanged`（`Cgy @ 159700`）：**"The session switched branches — review and resend."**
  - **非 retryable、直落终态 `failed`**：行状态置 failed + inline 错误（`$m(…,{inline: durable && !restored})`）；
  - **立即 `Promise.all([Q(e), Vv(e)])` 刷新 transcript + 分支列表**——用户此刻看到的就是分支已切换后的新真相（这也是「刷新 transcript 的时机」的准确答案：错误抵达即刷，不等用户操作）。
  - 对照：瞬时断连错误 → `waiting-reconnect` + 按 retryAfterMs（clamp 100–5000ms）自动重试（banner "Message will send when the Gateway reconnects." / "The Gateway asked us to retry this message shortly."）；非冲突终态错误用 `kl(err)` 通用文案。

### park UI（composer 上方队列区，`Bpwd @ 533663+`，`XD/ZD/$D`）

```html
<div class="chat-queue" role="status" aria-live="polite">
  [<div class="chat-queue__global-state" data-chat-queue-global-state="warn">Queue paused. Retry or discard the earlier unconfirmed message in the conversation.</div>]
  <div class="chat-queue__scroll" data-scrollable data-at-start data-at-end> …rows（按 id 复用，拖拽排序）… </div>
</div>
```

- 全局横幅：队首为 `unconfirmed` 时 tone=warn、**暂停后续发送**（`blockedByUnconfirmed`）；等待 settings 应用时 tone=settings（"Applying chat settings"）。
- 行级状态标签 `XD`：`unconfirmed` → **"Delivery uncertain"**；`failed` → "Failed"；`waiting-reconnect` → **"Waiting for reconnect"**；`executing-command` → "Running command"；`waiting-model/waiting-idle` → 无标签。
- **用户确认重发流程**：行上 **Retry**（`retryQueuedChatMessage` → `vw` @ `jc3 209359`：校验非 in-flight → `yw` 重置 `sendState=waiting-idle`（失败且非 steer/intent 换新 sendRunId）→ 泵重发）与 **Discard**（"Discard this local pending copy. This does not cancel a message already received by the Gateway."）。`unconfirmed` 另有 **Check delivery**（`checkDeliveryHelp`: "Delivery is unconfirmed. Check delivery looks for the original message without resending it or starting a worker. Inspect the conversation, or copy the retained prompt if you choose to start a separate attempt."）。
- in-flight 行锁位：`sending/waiting-model/uncertain` 行不可拖越（队列按其位置分裂，`jc3 @ 28949` `jm/Am` + docs:146 一致）。

---

## 7. outbox 重放（重连后省略 expectedLeafEntryId 的代码路径）

**结论：证实。重发链路全程不携带 `expectedLeafEntryId`。**

- 持久化：queue item 进 durable outbox（`jc3`：`up(e).keep(e,{sessionKey,agentId},t)`）；附件 blob 落 **IndexedDB `openclaw-control-ui`（v2）`outboxPayloads` store**，key=`[gatewayOwner, recoveryScope, queueId, tabId]`，单记录 25 MiB / 总量 250 MiB / ≤1000 条（`CVh @ 18132–21710`）；tab 所有权 = Web Locks `openclaw-outbox:<scope>` + localStorage `openclaw.control.outboxTab.v1`。配额/缺失文案 `chat.sendErrors.outboxPayload*`（"…No new message was sent; your input is retained." 等）。
- 断连标记：`Hp(e)`（`jc3 @ 19877`）把 `sending/waiting-idle` 项置 `waiting-reconnect`；请求可能已达 Gateway 的（`xp` uncertain）置 `unconfirmed`。
- 重连/事件驱动重发：泵入口 `bw = NC(e, fw)`（泵全部 scope；`jc3 @ 193835`）→ `jC` 串行循环 → `lw(item, id, options, sessionKey)`（`jc3 @ 200185`）。**leaf id 选择点**（`jc3 @ 202349`）：

  ```js
  let r = d.intent ? d.expectedLeafEntryId : n?.expectedLeafEntryId;
  await tw(e, { …, queueMode, ...d.queueMode !== 'steer' && r !== void 0 ? { expectedLeafEntryId: r } : {}, … });
  ```

  - 普通消息 item 自身不存该字段（`X_` @ `jc3 86890`：仅 intent（goal）才落 `expectedLeafEntryId`）；
  - 泵调用链的 options 从不带它：首发 composer 路径 `uw → MC(…, {…, expectedLeafEntryId: g})`（`jc3 @ 206257/216182`，g=提交时 displayed leaf）**只在第一次发送时传入**；重连自动续发（`NC`，options=undefined）、Retry（`vw` → `MC(…, {routingSessionKey, allowActiveRunSend})`）、run 结束后驱动（`chat` 事件完成分支 `bw(e)`）都不传；
  - `tw` 层 `…===void 0?{}:{…}` 展开 → **`chat.send` 请求体省略 `expectedLeafEntryId`**，由 Gateway 以「追加到当前 leaf」语义落库。
- 附：重连后恢复同 session 在途 send 会加 `__controlUiReconnectResume: true` + `sessionId`（`reconnectResumeSessionId`，发送后清空，`jc3 @ 199007`）——与 leaf 省略并行的独立恢复标记。
- 与 UI 状态的呼应：重发成功后新消息出现在（可能已切换的）分支尾；若期间 leaf 被他人/其他 tab 改变且 UI 带了 leaf id，则走 §6 的 active-leaf-changed park。

---

## 关键 UI 文案清单（英文原文，均为打包产物内置 i18n）

| key | 文案 |
|---|---|
| chat.messages.rewind | `Rewind` |
| chat.messages.rewindConfirm | `Rewind to before this message?` |
| chat.messages.dontAskAgain | `Don't ask again` |
| chat.messages.rewindToHere | `Rewind to here` |
| chat.messages.forkFromHere | `Fork from here` |
| chat.messages.rewindUnavailable | `Rewind is unavailable while the agent is working` |
| chat.messages.forkUnavailable | `Fork is unavailable while the agent is working` |
| chat.messages.actions | `Message actions` |
| chat.sessionHeader.branches | `Session branches` |
| chat.sessionHeader.untitledBranch | `Untitled branch` |
| chat.sessionHeader.oneMessage / messages | `{count} message` / `{count} messages` |
| chat.sessionHeader.activeBranch | `Active branch` |
| chat.sessionHeader.branchSwitchUnavailable | `Branch switch is unavailable while the agent is working.` |
| chat.archivedSessionDisabled | `This session is archived. Unarchive it to continue the conversation.` |
| chat.sendErrors.activeLeafChanged | `The session switched branches — review and resend.` |
| chat.queue.states.needsReview | `Delivery uncertain` |
| chat.queue.states.blockedByUnconfirmed | `Queue paused. Retry or discard the earlier unconfirmed message in the conversation.` |
| chat.queue.states.waitingForReconnect | `Waiting for reconnect` |
| chat.queue.states.runningCommand | `Running command` |
| chat.queue.checkDeliveryHelp | `Delivery is unconfirmed. Check delivery looks for the original message without resending it or starting a worker. …` |
| chat.queue.discardPendingMessage | `Discard this local pending copy. This does not cancel a message already received by the Gateway.` |

## 无法从打包产物确认、需官方源码仓库验证的点

1. `sessions.branches.switch` 对「已活动分支」的 typed no-op 错误的具体类型/码（Gateway 侧行为；UI 从不触发，仅 docs:97 声明）。
2. external agent harness 会话拒绝 rewind/fork 的服务端判定与错误类型（docs:97 声明；UI 侧只见权限 gate、归档 gate）。
3. `sessions.branches.list` 的 `operator.read` scope（docs 声明；UI 权限映射仅列 switch/rewind/fork/reset/compact 五项）。
4. 分支 recency `DT(updatedAt)` 的具体格式化规则。
5. rewind 响应 `editorAttachments` 与现有草稿附件的合并函数 `nt()` 的精确语义（按 id 去重合并的推断）。

