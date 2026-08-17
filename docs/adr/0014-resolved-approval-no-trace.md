# ADR 0014：resolved/expired 审批卡不留痕——时间线审批渲染路径退役

## 状态

已接受。经 grill-with-docs 会话逐项盘问产出（2026-08-12）。**部分 supersede #547 与 [ADR 0009](./0009-chat-timeline-merge.md) 的「resolved/expired 卡回时间线留操作记录」条目**。不推翻 ADR 0009 的其余决定——`seqCounter` 单调序号、滚动范式 B、按 id 幂等去重等仍保留（`seq` 继续服务于 ApprovalDock 内多卡排序）；只是「审批卡进消息时间线」这一渲染路径整体退役。

## 背景

ADR 0009 + #547 拍板：审批卡 resolved/expired 后回消息时间线，以 `opacity:.55` 变淡留显「已批准/已拒绝」标签，作操作记录留痕。实现上 `ChatView` 把 `visibleApprovals` 按 status 互斥切分：`activeApprovals`（pending/resolving → composer 上方 `ApprovalDock`）与 `historicalApprovals`（resolved/expired → `ChatStream` 时间线，经 `mergeTimeline` 按 `seq` 插入）。

用户反馈：时间线里那张变淡的残留卡「和最新 OpenClaw 官方页面不匹配、很丑」，要求批准/拒绝后**直接消失**。grill 会话核查事实：

1. **代码层面无任何淡出动画**——全库 grep 零 `transition`/`<Transition>`/全局 fade 类作用到 `.approval`。`ApprovalCard.vue` 的 `.approval.resolved { opacity:.55 }` 无 `transition`，opacity 是瞬时跳变。用户感知的「淡出」是同一渲染 tick 内「dock 橙卡（满不透明、带按钮）瞬时销毁 + 时间线灰卡（55%、无按钮）瞬时出现」的视觉整合。
2. **时间线审批渲染路径本已部分废置**：`ChatStream` 只收 resolved/expired 卡，而 `ApprovalCard` 在 resolved/expired 态隐藏全部操作按钮（`v-if="approval.status !== 'resolved' && approval.status !== 'expired'"`），故 `ChatStream` 上的 `@resolve-approval` / `@toggle-approval-detail` **从不可触发**——时间线里的留显卡是纯只读残影。
3. **pending/resolving 卡的家在 `ApprovalDock`**（composer 上方），不在时间线。故时间线**只**承载 resolved/expired 残影；删残影 = 时间线再无任何审批卡。
4. 仓库 docs（`oc-chat-page.html`、ADR 0009）曾把「变淡留显」记为官方对齐基准——那是 #33 时期原型假设；用户核实**最新** OpenClaw 官方页面 resolved 后不留痕，旧假设过时。

## 决定

1. **resolved/expired 审批卡不再在任何位置渲染**——既不进时间线，也不留任何紧凑记录。pending/resolving 卡仍在 `ApprovalDock`（行为不变）。用户点击批准/拒绝 → 卡进 `resolving`（dock 显示「处理中…」）→ 网关 `approvalResolved` 回执落定 `resolved` 那一帧，卡从屏幕消失。
2. **退役时间线审批渲染路径**（其唯一用途 resolved/expired 留痕既已移除，整条路径成为无消费者死代码）：
   - `ChatStream.vue` 不再接收 `approvals` / `anchorState`，不再渲染 `ApprovalCard` 与 `SyntheticAnchor`；模板回归纯 `messages` v-for；移除审批相关 props/emits/处理函数与 layout 快照里的 approvals 投影及相关 import。
   - `ChatView.vue` 移除 `historicalApprovals` / `anchorState` 计算与向 `ChatStream` 的审批 prop/事件绑定（审批 resolve/detail 统一经 `ApprovalDock`）。
   - 删除 `chat/timeline.ts`（`mergeTimeline` + `SyntheticAnchor` + 锚定规则）及其纯函数单测 `chat/timeline.test.ts`——无消费者。
   - 删除/修正 `chatComponents.test.ts` 中「ChatStream 合并时间线渲染」整块（审批排序 + anchorState 合成虚拟气泡）与所有 ChatStream mount 的 `approvals`/`anchorState` props。
3. **保留**：`seqCounter`、`addApproval` 的 `seq` 赋值、`visibleApprovals` getter、`ApprovalItem` 状态机（pending/resolving/resolved/expired）、`ApprovalDock`、`ApprovalCard`——pending 多卡在 dock 内仍按 `seq` 排序；状态机与断线复位（`recoverPendingApprovals`）、网关失效（`expireApproval`）语义不变。resolved/expired 卡仍在 `store.approvals` 留存至切容器清空（仅不再渲染），保持 store 语义最小改动。`ApprovalCard` 的 resolved/expired 样式分支保留为防御性死分支（dock 实际只收 pending/resolving），不强行删除以收敛本次改动面。

## 为什么

- **对齐最新官方**：用户核实最新 OpenClaw 官方页面 resolved 后不留痕迹；#33 时期原型 `oc-chat-page.html` 的「变淡留显」假设过时。
- **退役死代码优于留空抽象**：时间线审批路径在 resolved/expired 态无操作按钮、本不可交互；删残影后 `mergeTimeline` 永远收到 `approvals=[]` 早退返回 messages，`SyntheticAnchor` 恒不触发。保留这套空转机制会让未来读者误以为时间线仍渲染审批卡，且 `ChatStream` 的审批 resolve 处理函数是永远走不到的孤儿。
- **最小 store 改动**：不改状态机与 `seq` 语义，只在渲染层撤离——`resolved`/`expired` 终态、`recoverPendingApprovals` 断线复位、`expireApproval` 网关失效语义全部不动，降低回归面。

## 考虑过但否决的方案

- **改低调（紧凑一行记录）而非删除**：用户明确选「删了」，且官方不留痕；紧凑记录是无依据的新发明。
- **保留 `mergeTimeline` / `SyntheticAnchor` 作空壳**：无消费者的死抽象，未来读者需重新理解一套不再触发的锚定规则——否决（全删）。
- **从 store 立即移除 resolved/expired 卡**：会动状态机与 `seq` 幂等去重语义；渲染层撤离已足够，卡留 store 至切容器清空无副作用——否决（改渲染不改 store）。
- **乐观隐藏（点击即消失，不等网关回执）**：`resolving` 态需保留以承载「处理中…」与 RPC 失败复位（`recoverPendingApprovals`）反馈；网关回执落定即消失已满足「直接消失」体感——否决乐观隐藏。

## 后果

- **`frontend/src/components/chat/ChatStream.vue`**：模板简化为纯 `messages` v-for；移除 `ApprovalCard` 渲染分支、`SyntheticAnchor` div、审批 props（`approvals`/`anchorState`/`disconnected` 中审批相关）/emits（`resolveApproval`/`toggleApprovalDetail`）/处理函数（`onResolve`/`onToggleDetail`）、layout 快照的 approvals 投影与 `anchor` 段、相关 import（`mergeTimeline`/`isApprovalEntry`/`isSyntheticAnchor`/`TimelineEntry`/`ApprovalItem`/`ApprovalCard`）。
- **`frontend/src/views/ChatView.vue`**：移除 `historicalApprovals` 与 `anchorState` 计算属性；`<ChatStream>` 去掉 `:approvals` / `:anchor-state` / `@resolve-approval` / `@toggle-approval-detail` 绑定（后者只留 `ApprovalDock` 走）。
- **删除** `frontend/src/chat/timeline.ts` 与 `frontend/src/chat/timeline.test.ts`。
- **`frontend/src/components/chat/chatComponents.test.ts`**：删除「ChatStream 合并时间线渲染」整块 describe；所有 ChatStream mount 去掉 `approvals`/`anchorState` props。
- **保留不动**：`stores/chat.ts`（`ApprovalItem`/`seqCounter`/`visibleApprovals`/状态机）、`ApprovalDock.vue`、`ApprovalCard.vue`。
- **验证**：`cd frontend && npm run test`（vitest 回归）+ `npm run build`（vue-tsc 类型检查）。
- **关联**：本 ADR 不触碰 Q2-1(a)（历史工具提取修复）与 Q2-2(ii)（消息级 `__openclaw.seq` 排序）——后者属独立后续工作，分别见其实现。
