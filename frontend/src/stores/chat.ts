// chatStore —— 对话页响应式投影（#316 候选 B / #340：Pinia 纯 mutation，贴 useWikiStore 形态）。
// 渲染状态与连接解耦：messages/approvals/sessions/instances/commands/selectedContainer/
// selectedSession/input + 历史分页态 全在此；连接生命周期 × runId 路由 × 非响应式簇
// （gateway/定时器/请求代）归 useChatConnection 同宿主（#340 关键约束）。
import { defineStore } from 'pinia'
import type { InstanceDTO } from '@/api/containers'
import type { CommandDTO, SessionBranchDTO, SessionDTO } from '@/chat/gatewayChat'
import type { MediaBlock } from '@/chat/eventTranslate'
import { isSubagentApproval, isSubagentSessionKey } from '@/chat/subagentApproval'

export interface ToolRow {
  id: string | null // 工具调用 id（codex P2：同名并发调用按 id 配对 result，无 id 退 name）
  name: string
  state: 'running' | 'done' | 'error'
  title: unknown // 网关 toolTitles 用途短标题（待实测），有则优先显示
  input: unknown
  result: unknown
}

export interface Msg {
  role: 'user' | 'assistant'
  raw: string // 原始累积文本（含 <thinking> 标签）；user 与 text 相同。thinking 由此剥离
  text: string // 展示正文（已剥离 thinking）
  thinking: string // T08 思考链（spec §8.3 (a)）：从 raw 内 <thinking> 标签剥离出的思考内容，折叠卡渲染
  thinkingOpen: boolean // 流式中 <thinking> 未闭合（思考中）
  streaming: boolean
  tools: ToolRow[] // T08 工具行（仅 assistant 会有，user 恒空；保持接口统一）
  // #459-T3 #464：附件媒体块（image/audio/video）——历史（loadHistory）与流式（final/delta
  // replace 快照）双路径提取；与 text 独立数据通道（文本提取语义不污染，附件渲染走这里）。
  // 纯图片消息（text 空但 media 非空）照常渲染。user 发送的附件也入此（echo 渲染）。
  media: MediaBlock[]
  // T1 轮次折叠（#664 / CONTEXT.md「折叠条」）：轮次正常完成后轨迹（思考+工具）收进折叠条的
  // 折叠态。可选（缺省展开）：done 帧自动置 true；T3（#666）起历史翻译（loadHistory/分页/外来
  // 可见 final 局部插入）有轨迹的 assistant 消息默认置 true；手动开合经 toggleTraceFold mutation；
  // error/断线/宽限收尾不置值。正文与附件恒在折叠外，不受此字段影响。
  traceFolded?: boolean
  // T2 执行时长（#665 / CONTEXT.md「执行时长」）：本轮 send → done 的墙钟毫秒数（含建连排队/
  // 审批等待/断线重连间隔——墙钟语义）。可选：done 帧落定（时长信号同折叠信号独占 done）；
  // 历史轮/error/断线/宽限收尾缺省 undefined（条面回退「执行过程 · …」计数文案）。
  turnDurationMs?: number
  // #694 网关 transcript 条目 id（网关 chat.history 每条消息 __openclaw.id → translateHistoryMessage
  // 单点提取，官方 Control UI 亦取此值作 data-entry-id）。语义 = 该消息在网关 transcript DAG 里的
  // 持久化条目身份，回退/fork/分支切换（sessions.rewind 等）的定位参数。**仅已持久化消息有值**：
  // 本地乐观 echo（send/resendOutbox 新建的 Msg）与流式占位缺省 undefined——UI 据此不显示任何
  // 消息级操作入口（不可对未落库的消息发起 rewind）。与分页锚点（historyAnchor/nextOffset，number
  // offset | string messageId 两态）是**不同字段**，禁止混用（Codex #678 P1 教训）。
  entryId?: string
  // #694（Codex #703 P1）：本轮发送键 = chat.send 的 idempotencyKey，仅本地乐观 echo 有值（同轮
  // assistant 占位不需要；历史翻译的消息 entryId 直接来自网关，无需回读）。网关取该键作 clientRunId
  // （openclaw dist `chat-send-handler` 实证），故落库的用户条目 __openclaw.idempotencyKey 为
  // `${sendKey}:user`——ack 到达后据此回读最新一页历史，把网关条目 id 补进 entryId
  // （见 markUserEntryId）。否则「刚发出的那条」在切会话/重连前没有 entryId，回退入口不渲染，
  // 而它恰是回退的主用例。
  sendKey?: string
}

// T06 审批卡（连接级，无 runId）：独立列表渲染，不混入 messages——避免破坏流式锚定/finalizeLast
// （审查 #5），并可独立按 sessionKey 过滤、随会话/容器切换清空（codex P1 / 审查 #6）。
export interface ApprovalItem {
  id: string
  kind: string
  command: string
  sessionKey: string | null
  // #405-T1：发起方 agentId（subagent 审批来源标识；null = 主会话审批或未知来源）。
  // #394 实测定案：request.agentId 恒下发（string|null），事件/补拉两路透传，识别首选此字段。
  agentId: string | null
  status: 'pending' | 'resolving' | 'resolved' | 'expired' // pending 待处理 / resolving 已点击等回执 / resolved 已处理 / expired 网关侧已失效（过期/已处理，终态不可回覆）
  decision: '' | 'allow-once' | 'allow-always' | 'deny' | 'unknown' // codex P1 (issue #154)：网关权威值 allow-once/allow-always/deny
  detailOpen: boolean
  seq: number // ADR 0009：全局单调到达序号（先到者小、后到者大）——渲染期合并时间线排序用
}

export function newMsg(role: 'user' | 'assistant', text = ''): Msg {
  return {
    role,
    raw: text,
    text,
    thinking: '',
    thinkingOpen: false,
    streaming: role === 'assistant',
    tools: [],
    media: [], // #459-T3 #464：附件媒体块初始空（send/loadHistory/流式各自填充）
  }
}

// 轨迹判定（#664 / CONTEXT.md「轨迹」）：思考非空或工具行非空即有轨迹；正文与附件不算轨迹。
// 无轨迹的轮次不渲染折叠条。store（foldLastTrace）与渲染层（折叠条渲染门）共用此单一实现。
export function hasTrace(m: Msg): boolean {
  return m.thinking !== '' || m.tools.length > 0
}

// 默认折叠判定（审查 Standards 轴：foldLastTrace 与历史翻译两处的「assistant 且有轨迹」条件
// 收敛单一实现）——#664 done 帧自动折叠与 #666 历史翻译默认折叠共用；user 消息与无轨迹
// 消息不折叠（渲染层本就不渲染折叠条）。
export function shouldFoldTrace(m: Msg): boolean {
  return m.role === 'assistant' && hasTrace(m)
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    instances: [] as InstanceDTO[],
    sessions: [] as SessionDTO[],
    // #698 分支菜单：会话级渲染投影（贴 sessions 先例，#693 spec §1.2「branches 数组入 chat
    // store」）。active:true 项的 leafEntryId 是分支 CAS 的唯一权威基准（#700 消费）。拉取失败
    // /单分支/能力缺失统一表现为空或单元素 → 头部按钮不渲染（length > 1 门）。
    branches: [] as SessionBranchDTO[],
    selectedContainer: '' as string,
    selectedSession: '' as string,
    messages: [] as Msg[],
    approvals: [] as ApprovalItem[],
    // ADR 0009：审批卡全局到达序号计数器（addApproval 时赋 ++seqCounter）。
    // 只随 resetForContainer 重置（与审批卡清空同生命周期）；切会话（resetForSession）不清空审批卡，
    // 若重置会与留存旧卡撞序——seq 必须严格单调递增（ticket #399 明确要求）。
    seqCounter: 0 as number,
    commands: [] as CommandDTO[],
    input: '' as string,
    // T3 会话历史回看（issue #82 / spec #76）：分页态——hasMore 标记可向回翻更旧消息，
    // historyAnchor=nextOffset 为下一更旧页的 messageId 锚点；historyLoading 控「加载更多」禁用。
    historyHasMore: false as boolean,
    historyAnchor: null as string | number | null,
    historyLoading: false as boolean,
    // T07 斜杠命令补全：菜单选中项 + Esc 关闭态
    slashIndex: 0 as number,
    slashDismissed: false as boolean,
  }),
  getters: {
    // #405-T1（#395 钉死 + #394 实测）：审批卡唯一家在 main——当前会话**不是** subagent 会话时
    // 显示归属卡：无 sessionKey 连接级卡任何会话可见；归属当前会话的卡显示；**subagent 发起的卡
    // （agentId 即来源语义）恒在 main 框可见**——其 sessionKey 是 subagent 会话形态
    // （`agent:<id>:subagent:<uuid>`，纯 sessionKey 匹配永不可达，故 spec 决定 7 公式延伸
    // isSubagentApproval 分支，这是满足「唯一家在 main」问题陈述的必要补充）。当前会话是 subagent
    // 会话（#394 实测形态判定，非裸 `agent:` 头——主会话也可带 agent: 头，前缀匹配有误报）时
    // 审批区**恒空**（无条件，任何卡都不显示，含其自身历史残留卡）。被过滤的卡留存于 approvals
    // 列表，仅渲染层隐藏（codex R2 P1 留存不变量）——切回 main 即可见可回覆。
    visibleApprovals(state): ApprovalItem[] {
      if (isSubagentSessionKey(state.selectedSession)) return [] // subagent 会话审批区恒空
      return state.approvals.filter(
        (a) => !a.sessionKey || a.sessionKey === state.selectedSession || isSubagentApproval(a),
      )
    },
  },
  actions: {
    // ---- 容器 / 会话 ----
    setInstances(list: InstanceDTO[]): void {
      this.instances = list
    },
    setSessions(list: SessionDTO[]): void {
      this.sessions = list
    },
    // #698：整替（非追加）——重拉后旧列表不残留；stale 丢弃由调用层守卫负责（branchesGen）。
    setBranches(list: SessionBranchDTO[]): void {
      this.branches = list
    },
    setSelectedContainer(name: string): void {
      this.selectedContainer = name
    },
    setSelectedSession(key: string): void {
      this.selectedSession = key
    },
    // #697 幂等：同 key 重复插入（fork prepend 后 refreshSessions 合并前的重复路径）不重复行，
    // 且保留首次行字段（占位行不覆盖已在位的权威行）。
    prependSession(s: SessionDTO): void {
      if (this.sessions.some((x) => x.session_key === s.session_key)) return
      this.sessions = [s, ...this.sessions]
    },
    removeSession(key: string): void {
      this.sessions = this.sessions.filter((s) => s.session_key !== key)
    },

    // ---- 消息投影（纯 mutation，供 useChatConnection 的 handle* 调用）----
    pushMessage(m: Msg): void {
      this.messages.push(m)
    },
    // #569: 外来可见 final 插入（在途时）——插到当前最后一条（在途气泡/占位）之前。「尾部 =
    // 在途气泡」是 handleText/handleAttachment 续帧 append 的锚定不变量：外来消息若尾部 push，
    // 后续续帧（activeRunId===runId 放行 streaming=false）会污染外来消息。调用方保证
    // activeRunId 非空时最后一条为在途气泡；空闲/终态路径走 pushMessage（尾部追加）。
    insertBeforeLast(m: Msg): void {
      this.messages.splice(this.messages.length - 1, 0, m)
    },
    // PHASE 2 retry-run handoff：空 final 失败 fallback 移除最后一条消息。**仅限**删除「本次
    // pendingSend 创建且仍完全空（text/media/tools 全空）」的 assistant 占位——调用方
    // （useChatConnection.armRetryWindow）在删除前按该条件校验，绝不删除任何已有可见消息。
    // 刻意不做成任意 index 删除，保持最小 API。
    popMessage(): void {
      this.messages.pop()
    },
    setMessages(list: Msg[]): void {
      this.messages = list
    },
    // #694（Codex #703 P1）：把网关回读的 transcript 条目 id 补回本地乐观 user 消息——按发送键
    // （Msg.sendKey）精确定位。命中才写：消息已出列（切会话/容器重建后旧对象不在投影内）或已有
    // entryId（历史翻译给过）时不动，避免无意义的响应式触发。
    markUserEntryId(sendKey: string, entryId: string): void {
      const m = this.messages.find((x) => x.role === 'user' && x.sendKey === sendKey && !x.entryId)
      if (m) m.entryId = entryId
    },
    // 最后一条助手消息：仅当仍是占位/流式时落定（done/error/断线收尾共用）
    finalizeLast(): void {
      const last = this.messages[this.messages.length - 1]
      if (last && last.streaming) {
        last.streaming = false
        last.thinkingOpen = false
      }
    },
    // T1 轮次折叠（#664）：done 正常完成后收起该轮轨迹（最后一条 assistant 消息有轨迹时）。
    // 折叠信号独占 done 帧——仅 useChatConnection.handleDone 的本 run 终态分支调用，不得挂共享
    // 收尾 finalizeLast（error/断线/8s 宽限收尾不折叠）。每次 run 终态只发生一次，手动展开后
    // 无第二次自动收起。
    foldLastTrace(): void {
      const last = this.messages[this.messages.length - 1]
      if (last && shouldFoldTrace(last)) last.traceFolded = true
    },
    // T1 手动开合（#664）：折叠条 emit 回父层落 store（贴既有纯 mutation 形态）。自动折叠只在
    // done 发生一次，手动开合不被自动覆盖。
    toggleTraceFold(m: Msg): void {
      m.traceFolded = !m.traceFolded
    },
    // T2 执行时长（#665）：done 正常完成落定本轮墙钟毫秒。仅 useChatConnection.handleDone 的
    // 本 run 终态分支调用（与 foldLastTrace 同点，起点在连接簇闭包 turnStartedAt）；error/
    // 断线/宽限收尾不落定（异常轮无「已执行」可言，条面回退计数文案）。
    setLastTurnDuration(ms: number): void {
      const last = this.messages[this.messages.length - 1]
      if (last && last.role === 'assistant') last.turnDurationMs = ms
    },
    setInput(v: string): void {
      this.input = v
    },

    // ---- 审批卡（T06）----
    addApproval(card: {
      id: string
      kind: string
      command: string
      sessionKey: string | null
      agentId?: string | null // #405-T1：发起方 agentId（缺省 null = 主会话审批）
    }): void {
      // codex R2 P1：按 id 去重后**留存全部**（含其它会话的），仅渲染时按 sessionKey 过滤
      if (this.approvals.some((a) => a.id === card.id)) return // 幂等（重连补拉 + 实时推送去重）
      this.approvals.push({
        id: card.id,
        kind: card.kind,
        command: card.command || '（网关未提供命令详情）',
        sessionKey: card.sessionKey,
        agentId: typeof card.agentId === 'string' && card.agentId ? card.agentId : null, // 0 信任：仅 string 才取
        status: 'pending',
        decision: '',
        detailOpen: false,
        seq: ++this.seqCounter, // ADR 0009：到达序号（先到者小、后到者大；重连补拉排所有现有卡之后）
      })
    },
    // 网关回执：以权威 decision 落定（first-answer-wins，codex P1，可能与请求不同）
    resolveApproval(id: string, decision: string): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a) {
        a.status = 'resolved'
        a.decision =
          decision === 'allow-once' || decision === 'allow-always' || decision === 'deny'
            ? decision
            : 'unknown'
      }
    },
    // resolve 失败（带 approval id 的 RPC 错误）或断线（无 id → 全部）：恢复 resolving 卡为 pending 可重试
    // （codex R2 P2：仅复位匹配卡，不误复位并发在途的其它卡）。expired 是终态，不复位。
    recoverPendingApprovals(id?: string): void {
      for (const a of this.approvals) {
        if (a.status === 'resolving' && (id === undefined || a.id === id)) a.status = 'pending'
      }
    },
    // #492：网关侧审批已失效（过期/他端处理，APPROVAL_NOT_FOUND 等终态错误）→ 卡落定 expired，
    // 终态不可回覆（按钮禁用、卡片明示失效），不再静默复位造成「反复点击无反馈」。
    expireApproval(id: string): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a && a.status === 'resolving') a.status = 'expired'
    },
    toggleApprovalDetail(id: string): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a) a.detailOpen = !a.detailOpen
    },
    clearApprovals(): void {
      this.approvals = []
    },

    // ---- 斜杠命令（T07）----
    setCommands(list: CommandDTO[]): void {
      this.commands = list
    },
    setSlashDismissed(v: boolean): void {
      this.slashDismissed = v
    },
    setSlashIndex(i: number): void {
      this.slashIndex = i
    },

    // ---- 历史分页（T3）----
    setHistoryState(hasMore: boolean, anchor: string | number | null, loading: boolean): void {
      this.historyHasMore = hasMore
      this.historyAnchor = anchor
      this.historyLoading = loading
    },
    setHistoryLoading(loading: boolean): void {
      this.historyLoading = loading
    },

    // ---- 切容器 / 切会话时清态（连接簇由 useChatConnection 负责）----
    resetForContainer(): void {
      this.sessions = []
      this.selectedSession = ''
      this.messages = []
      this.approvals = [] // 切容器：清空审批卡（审查 #6）
      this.seqCounter = 0 // 与审批卡清空同生命周期，编号干净（ADR 0009）
      this.commands = [] // 切容器：清空命令缓存（命令按容器隔离，T07）
      this.input = ''
      this.slashDismissed = false
      this.historyHasMore = false
      this.historyAnchor = null
      this.historyLoading = false
      this.branches = [] // #698：切容器必换会话，分支随之作废
    },
    resetForSession(): void {
      this.messages = []
      this.historyHasMore = false
      this.historyAnchor = null
      this.historyLoading = false
      this.branches = [] // #698：分支属于单个会话，切会话不得残留（length 门会误渲染按钮）
    },
  },
})
