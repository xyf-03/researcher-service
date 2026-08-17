// #369 M5 前端接线：网关事件 → ChatView 渲染帧的纯翻译函数（无 I/O 无状态，除 _sent 累积器）。
// 移植 backend/chat/event_translate.py（实测校准：ghcr 2026.6.34 / ADR 0003 / issue #153/#154）。
// 协议 v4 事件（官方 ./browser 协议机 onEvent）→ 与旧自定义 wire 同构的 ChatFrame 列表。
// 一帧网关事件可产 0..N 帧；delta 增量按 runId 累积已发文本（_sent）支持 replace 快照 / final 尾部补发。

// 翻译输出的渲染帧（对齐 ChatView 现有 onText/onDone/onError/onApproval/onApprovalResolved/onTool 签名）。
export type ChatFrame =
  // #565: thinking?: string | null —— 结构化 thinking 块提取（方案 A：翻译层提取随帧携带）。
  // 仅在 replace 快照 / final 帧可能非 undefined；delta 增量帧恒 undefined（增量字段是纯文本串，
  // 无 content[]），消费端对 undefined 跳过覆盖、走内联 <thinking> 路（splitThinking）现状。
  | { type: 'text'; runId: string; delta: string; replace?: boolean; thinking?: string | null }
  // #565: done 帧可携带 thinking——final 权威文本与流式累积相等/无文本（thinking-only）时翻译层
  // 不产 text 帧（无帧可挂），经 done 帧独立数据通道携带（不经 handleText 的 raw 逻辑，与
  // attachment 帧同哲学；不等价于谎报文本变更的 replace 帧）
  // #569: message?: unknown —— 外来 run 可见 final 的归约权威消息本体（#560 currentRun.message）
  // 透出数据通道。翻译层无外来概念（纯函数），有归约 message 即带；消费端仅 handleDone 外来分支
  // 读该字段做局部插入，本 run final 分支沿用现有 tail 补发逻辑、不读。
  | { type: 'done'; runId: string; thinking?: string | null; message?: unknown }
  // runId 可选：run 级错误挂 runId（前端按 runId 过滤）；无 runId 为连接/会话级错误（照常显示）
  | { type: 'error'; runId?: string; message: string }
  | { type: 'approval'; id: string; kind: string; command: string; sessionKey: string | null; agentId: string | null }
  | { type: 'approvalResolved'; id: string; decision: string }
  // #459-T3 #464：附件媒体帧——final/delta(replace) 消息 content 含 image/audio/video 块时产出
  // （run 级，挂 runId 走同款 runId 路由/锚定语义；与 text 帧独立数据通道，互不污染）
  | { type: 'attachment'; runId: string; media: MediaBlock[] }
  | {
      type: 'tool'
      runId: string
      name: string
      state: 'running' | 'done' | 'error'
      id: string | null
      title: unknown
      input: unknown
      result: unknown
      isError?: boolean
    }

// 网关 onEvent 回调的帧（官方 EventFrame 的窄化投影；payload 无严格 schema，0 信任防御取值）。
export interface GatewayEventFrame {
  type: string
  event?: string
  payload?: unknown
}

// 审批事件名（连接级广播，不挂 chat runId；实测校准 wire/values.py）
const APPROVAL_REQUESTED_EVENTS = ['exec.approval.requested', 'plugin.approval.requested'] as const
const APPROVAL_RESOLVED_EVENTS = ['exec.approval.resolved', 'plugin.approval.resolved'] as const
// 工具事件（实测校准：event:'agent' + payload.stream:'tool' + payload.data.phase）
const TOOL_AGENT_EVENT = 'agent'
const TOOL_STREAM = 'tool'

// delta state 下增量字段；replace=true + message 快照时改发 replace 帧（整段替换）
const DELTA_TEXT = 'deltaText'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// 从 final/delta 的 message 提取文本（实测校准 spike ghcr 2026.6.34-browser, 2026-07-27）：
// message 实测是 dict {role, content:[{type:text,text}], timestamp}；str 直返；dict 拼 content 中
// type=text 的 text；content 为 string（user 消息）直返；None/空 → ''。
// E1: 与 ChatView.loadHistory 历史消息复用——history 消息 content 多态（user=string /
// assistant=数组），此函数是内容提取的单一实现，历史路径不再另写只认 string 的逻辑。
export function extractMessageText(message: unknown): string {
  if (!message) return ''
  if (typeof message === 'string') return message
  const obj = asRecord(message)
  const content = obj.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (asRecord(b).type === 'text' && typeof asRecord(b).text === 'string' ? (asRecord(b).text as string) : ''))
      .join('')
  }
  return ''
}

// #565 结构化 thinking 块提取（对齐官方 message-extract.ts extractThinking，C 档自写）：
// 取 message.content[] 里 type==='thinking' 块的 thinking 字段（string 才取）、逐块 trim、丢空串、
// 多块 '\n' join；全空/无块/content 非数组/message 非对象 → null（区别于 extractMessageText 的 ''）。
// 0 信任：非对象 message / 块非对象 / thinking 非 string 一律跳过。**不读 text 字段兜底**（官方只读
// thinking；无实测证据不预设变体）。与内联 <thinking> 标签剥离（thinking.ts splitThinking）双路并存、
// 各司其职——本函数作用在结构化 content[] 块，splitThinking 作用在累积内联标签文本串。
export function extractThinking(message: unknown): string | null {
  if (!message || typeof message === 'string') return null
  const obj = asRecord(message)
  const content = obj.content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = asRecord(block)
    if (b.type !== 'thinking') continue
    if (typeof b.thinking !== 'string') continue
    const cleaned = b.thinking.trim()
    if (cleaned) parts.push(cleaned)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

// ---- #459-T3 #464：附件块提取（与 extractMessageText 并列的独立数据通道）----
// 历史消息（loadHistory）与流式消息（final/delta replace 快照）中的 image/audio/video 内容块
// → 渲染媒体数据。附件块此前被渲染层丢弃（extractMessageText 只认 text 块），本函数补齐非 text
// 媒体块的提取。**文本与附件不互相污染**：extractMessageText 仍只含 text 块（摘要/审计/claimedEmpty
// 判定等文本用途），媒体块只经本函数进 Msg.media，不进 Msg.text。
// 块 type 是归类依据（0 信任：mimeType 前缀与块 type 不一致时按块 type 归类，不猜测）。
// #568: 附件元数据增强——type 扩 document + sizeBytes/durationMs/width/height/label（全可选条件
// 透传：有才带上、缺则不带）。src 语义扩为「纯 base64 或完整 url」（url 形态块直存完整 url，
// 组件侧 mediaSrc 按 http(s) 前缀原样返回、不拼 base64）。
export interface MediaBlock {
  type: 'image' | 'audio' | 'video' | 'document'
  mimeType: string
  src: string // 纯 base64（剥 data:...;base64, 前缀）或完整 url；组件侧重建完整 dataURL 供
              // <img>/<audio>/<video>/<a download>（document 下载卡）
  fileName?: string // 原始文件名（有则供下载/无障碍标注）
  label?: string // 展示名（优先于 fileName，document 下载卡主标题）
  sizeBytes?: number // 体积（字节），条件透传
  durationMs?: number // 时长（毫秒），条件透传
  width?: number // 像素宽（仅 image/video 有意义），条件透传
  height?: number // 像素高（同上），条件透传
}
const MEDIA_TYPES = ['image', 'audio', 'video', 'document'] as const

// #568: 附件展示元数据条件透传（提取两路共用，防 drift）——官方「有才带上」同构（规格 §4.2/§4.3）：
// fileName/label 须非空 string；sizeBytes/durationMs 须为非负 number；width/height 须为正 number
// （0/负为无意义值）。非法值一律不带（0 信任，网关不回填则与现状一致）。
function mediaMeta(b: Record<string, unknown>): {
  fileName?: string
  label?: string
  sizeBytes?: number
  durationMs?: number
  width?: number
  height?: number
} {
  return {
    ...(typeof b.fileName === 'string' && b.fileName ? { fileName: b.fileName } : {}),
    ...(typeof b.label === 'string' && b.label ? { label: b.label } : {}),
    ...(typeof b.sizeBytes === 'number' && b.sizeBytes >= 0 ? { sizeBytes: b.sizeBytes } : {}),
    ...(typeof b.durationMs === 'number' && b.durationMs >= 0 ? { durationMs: b.durationMs } : {}),
    ...(typeof b.width === 'number' && b.width > 0 ? { width: b.width } : {}),
    ...(typeof b.height === 'number' && b.height > 0 ? { height: b.height } : {}),
  }
}

// #568 安全修复（security review）：url 形态只收**完整 http(s) URL**——在单一提取 choke point 校验
// （new URL 可解析且协议为 http:/https:），其他 scheme（javascript:/file:/data: 等）、相对/协议相对
// url、畸形 url 一律跳过。渲染层（img/audio/video 自动加载、document href）拿到的 url 恒为 http(s)。
function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// 从 message.content[] 提取 image/audio/video/document 块 → MediaBlock[]（渲染数据）。
// 0 信任：content/url 缺失或非 string → 跳过。块 type 是归类依据；mimeType 缺失回退 `${type}/*`。
// content 多态同 extractMessageText（string message / 无 content → 无附件）。
// #568: 三种来源形态——① b.content 裸 base64（含 document 型，同形状条件透传元数据）；
// ② {type:'attachment', attachment:{kind,url,...}}（官方 (a) 路）；③ {type:audio|video|document,
// url}（官方 (b) 路，src 直存完整 url）。②③ 为纯防御：面板 history 未实测此形态，条件透传保证
// 「无此形态则零影响」。
export function extractMessageAttachments(message: unknown): MediaBlock[] {
  if (!message || typeof message === 'string') return []
  const obj = asRecord(message)
  const content = obj.content
  if (!Array.isArray(content)) return []
  const out: MediaBlock[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = asRecord(block)
    // ②: {type:'attachment', attachment:{kind,url,...}}——kind 是类型归类依据（官方 (a) 路）
    if (b.type === 'attachment') {
      const att = asRecord(b.attachment)
      const kind = typeof att.kind === 'string' ? att.kind : ''
      if ((MEDIA_TYPES as readonly string[]).includes(kind)) {
        const src = isSafeHttpUrl(att.url) ? att.url : ''
        if (!src) continue
        const mimeType = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : `${kind}/*`
        out.push({
          type: kind as MediaBlock['type'],
          mimeType,
          src,
          ...mediaMeta(att),
        })
      }
      continue
    }
    const type = typeof b.type === 'string' ? b.type : ''
    if (!(MEDIA_TYPES as readonly string[]).includes(type)) continue
    // ①: b.content 裸 base64 优先（现有路）；③: 无 content 时退 url 形态（{type:audio|video|document,
    // url}，官方 (b) 路）——src 直存完整 http(s) url，组件侧 mediaSrc 原样返回不拼 base64
    const contentStr = typeof b.content === 'string' ? b.content : ''
    const url = contentStr ? '' : (isSafeHttpUrl(b.url) ? b.url : '')
    const src = contentStr || url
    if (!src) continue // 无 string content/url → 无法渲染，跳过
    // mimeType 缺失/非 string → 回退 `${type}/*`（组件重建完整 dataURL 须有 mime 段）。
    const mimeType = typeof b.mimeType === 'string' && b.mimeType ? b.mimeType : `${type}/*`
    out.push({
      type: type as MediaBlock['type'],
      mimeType,
      src,
      ...mediaMeta(b),
    })
  }
  return out
}

// 发送侧单附件（attachments.ts 采集/校验后的官方形状，type 已从 mimeType 主段派生）→ MediaBlock。
// 与 extractMessageAttachments 共用同一 MediaBlock 投影，避免发送 echo（useChatConnection.send）与
// 历史/流式提取两路各自重写「mimeType 主段派生 type / string content 门 / fileName 条件拷贝」而 drift
// （code-review Standards 轴）。content 非 string/空 → null（该附件无 echo 渲染数据，跳过）。
// 块 type 取自 a.type（采集层已校验白名单 image/audio/video；document 属函数级防御，采集层暂不放行）；
// mimeType 缺失回退 `${type}/*`。
// #568: 补透传 sizeBytes/durationMs/width/height（Attachment 已在 attachments.ts 声明，buildAttachments
// 原样透传——§2.1 数据已确证在 wire 上，此前被本函数丢弃）——与 extractMessageAttachments 共用
// mediaMeta 条件透传判定，防两路 drift。
export function attachmentToMediaBlock(a: {
  type?: string
  mimeType?: string
  fileName?: string
  content?: unknown
  sizeBytes?: number
  durationMs?: number
  width?: number
  height?: number
}): MediaBlock | null {
  const type = typeof a.type === 'string' ? a.type : ''
  if (!(MEDIA_TYPES as readonly string[]).includes(type)) return null
  const src = typeof a.content === 'string' ? a.content : ''
  if (!src) return null
  const mimeType = typeof a.mimeType === 'string' && a.mimeType ? a.mimeType : `${type}/*`
  return {
    type: type as MediaBlock['type'],
    mimeType,
    src,
    ...mediaMeta(a),
  }
}

// #560: SDK SessionProjection 减负——翻译层经注入的归约器读「归一化后的 run 终态」，不再手写
// 判 payload。归约器接口刻意收窄为翻译层所需：终态 status（aborted/error/timeout/yielded/
// completed）、终态权威 message（errorMessage 已 readNonemptyString 归一）、重放去重判定。
// 真实实现由 gatewayChat 连接闭包持有（SDK createSessionProjection + reduceSessionProjectionRunEvent，
// 见 sessionProjection.ts），生命周期 = 连接（onHello 重建）；测试注入假实现断言「终态判定读
// currentRun 而非手写 payload」。
export interface SessionProjectionReducer {
  // 归约一个 chat run 事件（final/aborted/error——终态判定权威）；无 runId / 非法 state → null
  reduce(event: GatewayEventFrame): SessionProjectionRunTransition | null
  // 连接生命周期边界清空（onHello 重建 projection）
  reset(): void
}

export interface SessionProjectionRunTransition {
  currentRun: SessionProjectionRun
  // 重放去重网（SDK hasSessionProjectionAcceptedFinal）：上次终态已接受过的 final 再次到达（resume
  // 重放/断线重发）→ 跳过本次终态渲染。**仅对已终态 run 生效**——首次终态时 previousRun 为
  // streaming（message 是 delta 快照），SDK 对无 id/seq 的消息退化为内容指纹判定，同内容快照会被
  // 误判为重放（规格 §2.6 关键否定：同连接内 dedup 仍靠 _sent 前缀求差，本网只兜「重放 final」）。
  isReplayedFinal: boolean
}

export interface SessionProjectionRun {
  runId: string
  status: 'streaming' | 'completed' | 'error' | 'aborted' | 'timeout' | 'yielded'
  message?: unknown
  errorMessage?: string
  errorKind?: string
}

export class ChatEventTranslator {
  // runId → 已发文本累积；final 尾部补发 / replace 整段替换时用于求差集或覆盖。
  // P2（code review）：有界清理——容量上限防御极端场景，连接生命周期边界（reset）由 gatewayChat
  // onHello 调用（断线 resume 从头重放也不双重追加）。
  // #560: 终态不再 delete（改由 SDK acceptedFinalMessageIdentities 记终态 identity）——条目转「冷
  // 条目」，靠 MAX_SENT_ENTRIES 容量上限 + reset 兜底清理（与 SDK 终态不删、靠 200 run 淘汰同构）。
  private readonly sent = new Map<string, string>()
  private readonly MAX_SENT_ENTRIES = 500

  // #560: 归约器注入（必填）——终态判定/终态 message/重放去重全部读归约结果，翻译层不再手写判
  // payload。生产注入真实实现（gatewayChat → sessionProjection.ts），测试注入假实现断言
  // currentRun 消费。归约器未认可的事件（无 runId / 非法 state）不产终态帧（保守丢弃）。
  private readonly reducer: SessionProjectionReducer

  constructor(reducer: SessionProjectionReducer) {
    this.reducer = reducer
  }

  // 连接生命周期边界清空累积器（断线重连后旧 run 的已发文本作废——若网关 resume 从头重放，
  // 不清空会双重追加，直到 final 才 replace 纠正）。
  reset(): void {
    this.sent.clear()
    this.reducer.reset()
  }

  translate(frame: GatewayEventFrame): ChatFrame[] {
    if (frame.type !== 'event') return []
    const event = frame.event ?? ''
    const payload = frame.payload ? asRecord(frame.payload) : {}
    // 审批事件是连接级广播（不挂 chat runId，r26:88）→ 单独翻译出卡，不进 chat 分支
    if ((APPROVAL_REQUESTED_EVENTS as readonly string[]).includes(event)) {
      const card = this.approvalCard(event, payload)
      return card ? [card] : []
    }
    // 他端 resolve 后的网关 resolved 事件（codex R3 P2）→ approvalResolved 帧收敛 peer 卡
    if ((APPROVAL_RESOLVED_EVENTS as readonly string[]).includes(event)) {
      const resolved = this.approvalResolved(payload)
      return resolved ? [resolved] : []
    }
    // 工具生命周期事件（实测校准：event:agent + stream:tool + phase；旧假设独立事件从不触发 #153）
    if (event === TOOL_AGENT_EVENT) {
      if (payload.stream === TOOL_STREAM) {
        return this.translateTool(payload, String((asRecord(payload.data).phase) ?? ''))
      }
      return []
    }
    if (event !== 'chat') return []
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    const state = payload.state
    if (state === 'delta') {
      if (!runId) return [] // 无 runId 的 delta 无锚点，无法渲染
      return this.translateDelta(runId, payload)
    }
    if (state === 'final') {
      if (!runId) return []
      // #560: 终态判定/终态 message/重放去重读归约后的 currentRun（翻译层不再手写判 payload；
      // 归约器未认可的事件不产终态帧——生产恒注入真实归约器）。
      const run = this.reducer.reduce(frame)
      if (!run) return []
      if (run.isReplayedFinal) return [] // 重放 final：已接受过，跳过渲染
      return this.translateFinal(runId, payload, run.currentRun)
    }
    if (state === 'aborted') {
      if (!runId) return []
      // #560: aborted 恒产 done（SDK 归约 status='aborted'）——**不走 isReplayedFinal 网**：
      // SDK acceptedFinalMessageIdentities 只在 completed/yielded 记终态身份（规格 §2.4/§2.6
      //「去重网只兜重放 final」），error/aborted 事件 consult 该网会在「事件带与 delta 快照相同
      // message」时误判重放、吞掉真实 done 帧（气泡卡 streaming）。重复 aborted 的 done 帧在
      // handleDone 幂等（activeRunId 已清则无操作），多产无害。
      return [{ type: 'done', runId }]
    }
    if (state === 'error') {
      // P2（code review）：无 runId 的 chat.error（会话级，如「会话不存在」）不再返回 [] 静默丢弃
      // ——译成连接级错误帧（runId 缺省），ChatView.handleError 的 no-runId 分支（原为不可达死代码）
      // 现在真正消费；run 级错误挂 runId 走 runId 过滤。
      if (!runId) {
        const message = String(payload.errorMessage ?? payload.errorKind ?? '')
        return [{ type: 'error', message }]
      }
      // #560: run 级 error 读归约后的 currentRun——errorMessage/errorKind 已由 SDK readNonemptyString
      // 归一（trim 后空串 → undefined）；errorKind=timeout → timeout 细分终态。
      // **不走 isReplayedFinal 网**：SDK acceptedFinalMessageIdentities 只在 completed/yielded 记
      // 终态身份（规格 §2.4/§2.6「去重网只兜重放 final」），error 事件 consult 该网会在「带与 delta
      // 快照相同 message」时误判重放、吞掉真实 error 帧。重复 error 的帧在 handleError 幂等
      //（activeRunId 已清则无操作），多产无害。
      const run = this.reducer.reduce(frame)
      if (!run) return [] // 归约器未认可（无 runId/非法 state 已在上方过滤，防御兜底）
      const status = run.currentRun.status
      if (status === 'timeout') {
        const message = run.currentRun.errorMessage ?? run.currentRun.errorKind ?? ''
        return [{ type: 'error', runId, message: `${message}（超时）`.trim() }]
      }
      if (status === 'yielded') return [{ type: 'done', runId }]
      const message = run.currentRun.errorMessage ?? run.currentRun.errorKind ?? ''
      return [{ type: 'error', runId, message }]
    }
    return []
  }

  private translateDelta(runId: string, payload: Record<string, unknown>): ChatFrame[] {
    if (payload.replace) {
      const snapshot = extractMessageText(payload.message)
      // #565: 结构化 thinking 块（replace 快照 content[]）随帧携带；无块（null）不挂字段
      const thinking = extractThinking(payload.message)
      if (snapshot) {
        // replace=true + 快照：整段替换（前缀/非前缀均正确）。前端按 replace 标志 set 而非 append
        this.sent.set(runId, snapshot)
        return [
          {
            type: 'text',
            runId,
            delta: snapshot,
            replace: true,
            ...(thinking !== null ? { thinking } : {}),
          },
        ]
      }
      if (thinking !== null) {
        // #565: thinking-only replace 快照（思考先于正文的模型输出）：无文本可渲染——发 delta=''
        // 增量帧携带思考（delta='' 不改变前端 raw 累积，仅覆盖 thinking；sent 不更新）。
        return [{ type: 'text', runId, delta: '', thinking }]
      }
      // #459-T3 #464：replace 快照无文本但含媒体块（纯图片 run 的流式快照）→ 产 attachment 帧，
      // 不回退 deltaText（媒体块不在 deltaText 增量字段里）。
      const media = extractMessageAttachments(payload.message)
      if (media.length) return [{ type: 'attachment', runId, media }]
      // 无快照 → 退回 deltaText 增量（追加），对齐 r13:127「若无 message，发 deltaText」
      const delta = typeof payload[DELTA_TEXT] === 'string' ? (payload[DELTA_TEXT] as string) : ''
      if (!delta) return []
      this.sent.set(runId, (this.sent.get(runId) ?? '') + delta)
      return [{ type: 'text', runId, delta }]
    }
    const delta = typeof payload[DELTA_TEXT] === 'string' ? (payload[DELTA_TEXT] as string) : ''
    if (!delta) return []
    if (this.sent.size >= this.MAX_SENT_ENTRIES && !this.sent.has(runId)) {
      // P2：有界防御——条目超上限且是全新 run，不增长（等价于该 run 无已发文本，final 走 replace）
    } else {
      this.sent.set(runId, (this.sent.get(runId) ?? '') + delta)
    }
    return [{ type: 'text', runId, delta }]
  }

  private translateFinal(runId: string, payload: Record<string, unknown>, run: SessionProjectionRun): ChatFrame[] {
    // #560: yielded 细分——SDK 语义「yielded=true && stopReason='end_turn'」= 让出给后续执行者，
    // 终态文本不属本 run 权威渲染（下一个 run 承接），不补 tail/replace 直接 done。
    if (run.status === 'yielded') return [{ type: 'done', runId }]
    const out: ChatFrame[] = []
    // #560: 终态 message 来源从 payload.message 换成归约后的 currentRun.message（SDK updateRun 已把
    //「delta 期快照 → final 权威 message」归一，含「final 无 message 时沿用 delta 快照」的保留逻辑）——
    // 替换散在 delta-replace 快照与 final 提取两处的 message 归一化（规格 §2.2）。
    // 局部提升：文本/思考/附件三路共用同一 message 来源（防多点漂移，code-review）
    const rawMessage = run.message ?? payload.message
    const message = extractMessageText(rawMessage)
    // #565: 结构化 thinking 块提取（final 权威 content[]）——随产出的 text 帧携带（handleText 以
    // ?? 覆盖内联剥离结果）；null = 无结构化块，帧不挂字段（增量帧/无块帧保持现状）。
    const structThinking = extractThinking(rawMessage)
    const sent = this.sent.get(runId) ?? ''
    // final.message 可能含此前未在 delta 投递的尾部文本 → 先补 text 再收尾（r13:128-129）
    if (message && message.startsWith(sent) && message.length > sent.length) {
      const tail = message.slice(sent.length)
      this.sent.set(runId, sent + tail)
      out.push({
        type: 'text',
        runId,
        delta: tail,
        ...(structThinking !== null ? { thinking: structThinking } : {}),
      })
    } else if (message && !message.startsWith(sent)) {
      // F9: 非前缀 final（空白规范化 / markdown 改写 / 重复 delta 使 sent 翻倍）——权威最终文本与
      // 流式累积不一致。若只发 done，权威文本被静默丢弃、UI 停在未规范化的流式态。发整段 replace
      // 帧（协议支持 replace 快照；前端按 replace 标志 set 而非 append），纠正流式投影。
      this.sent.set(runId, message)
      out.push({
        type: 'text',
        runId,
        delta: message,
        replace: true,
        ...(structThinking !== null ? { thinking: structThinking } : {}),
      })
    }
    // #459-T3 #464：final.message 含 image/audio/video 块（browser 截图/AI 工具产出多媒体）→
    // 产 attachment 帧（权威最终媒体，与 text 帧独立通道）。纯媒体 run（无文本）也经此渲染。
    const media = extractMessageAttachments(rawMessage)
    if (media.length) out.push({ type: 'attachment', runId, media })
    // #560: error/timeout 细分——译成 error 帧而非 done（规格 §2.1 三分支坍成「读 currentRun.status
    // 一个 switch」的 error 分支）。尾部/媒体已先行补发（权威内容不丢，同 done 收尾路径）。
    // final+stopReason='error' 的 errorMessage 常缺失（SDK 只从 error 事件字段归一）→ 兜底文案防
    // 空错误帧（handleError 会把空 message 显示为空条）。
    if (run.status === 'error' || run.status === 'timeout') {
      const message = run.errorMessage ?? run.errorKind ?? 'run 执行失败'
      return [...out, { type: 'error', runId, message }]
    }
    // #565: done 帧携带结构化 thinking——final 权威文本与流式累积相等/无文本（thinking-only）时
    // 本分支未产 text 帧（tail/replace 已带 thinking 时无需重复）；思考常只在 final 的 content[]
    // 才出现（delta 增量是纯文本串），经 done 帧独立通道携带（消费端 handleDone 在 finalizeLast
    // 前写入，terminal 重解析为空时保留——不谎报文本变更，不经 handleText 的 raw 逻辑）。
    // #569: 归约权威 message 透出（外来可见 final 局部插入的数据通道；本 run 消费端不读）。
    // 仅本终态路径（final 事件）产 done 帧时携带——aborted/yielded 分支的 done 帧不带（非 final
    // 终态，无 final 权威 message 可透出；E1b thinking-only 形状走本路径，message 一并携带）。
    out.push({
      type: 'done',
      runId,
      ...(run.message !== undefined ? { message: run.message } : {}),
      ...(structThinking !== null && !out.some((f) => f.type === 'text') ? { thinking: structThinking } : {}),
    })
    // #560: 终态手动 sent.delete 删除——SDK 终态 identity 记入 acceptedFinalMessageIdentities
    //（规格 §2.3）。_sent 条目转冷条目，靠容量上限 + reset 兜底清理。
    return out
  }

  // 待审批事件 payload → 前端审批卡帧；无稳定审批 id 返回 null（无法 resolve，不出卡）。
  // kind 缺省时从事件名族派生（exec/plugin）；sessionKey 透传自 request.sessionKey
  // （issue #154 实测校准：systemRunPlan 实测为 null，command/sessionKey 在 payload.request 下）。
  // agentId（#405-T1）：request.agentId 恒下发（#394 实测，string 才取 0 信任）为首选；
  // request 缺失走 systemRunPlan 回退路径读 runPlan.agentId（host=node 时存在，本部署恒 null）。
  private approvalCard(event: string, payload: Record<string, unknown>): ChatFrame | null {
    const approvalId = typeof payload.id === 'string' ? payload.id : ''
    if (!approvalId) return null
    const req = asRecord(payload.request)
    const runPlan = asRecord(payload.systemRunPlan)
    let command = ''
    let sessionKey: string | null = null
    let agentId: string | null = null
    if (Object.keys(req).length > 0) {
      command = typeof req.command === 'string' ? req.command : ''
      sessionKey = typeof req.sessionKey === 'string' ? req.sessionKey : null
      agentId = typeof req.agentId === 'string' ? req.agentId : null
    } else {
      command =
        (typeof runPlan.rawCommand === 'string' ? runPlan.rawCommand : '') ||
        (typeof runPlan.command === 'string' ? runPlan.command : '') ||
        (typeof payload.command === 'string' ? payload.command : '')
      sessionKey = typeof runPlan.sessionKey === 'string' ? runPlan.sessionKey : null
      agentId = typeof runPlan.agentId === 'string' ? runPlan.agentId : null
    }
    return {
      type: 'approval',
      id: approvalId,
      kind: typeof payload.kind === 'string' && payload.kind ? (payload.kind as string) : event.split('.')[0],
      command,
      sessionKey,
      agentId,
    }
  }

  // 网关 resolved 事件 payload → 前端 approvalResolved 帧；无 id 返回 null（不伪造，跳过）。
  private approvalResolved(payload: Record<string, unknown>): ChatFrame | null {
    const approvalId = typeof payload.id === 'string' ? payload.id : ''
    if (!approvalId) return null
    return {
      type: 'approvalResolved',
      id: approvalId,
      decision: typeof payload.decision === 'string' ? payload.decision : '',
    }
  }

  // 工具生命周期事件 payload → 工具帧。字段在 data 子对象下：name/toolCallId/args（start）、
  // result/isError/meta（result）。phase 映射：start→running / update→跳过（前端已有 start 行，
  // 避免重复行 codex #162 P2）/ result→done|error；未知 phase → []（0 信任，不猜测）。
  private translateTool(payload: Record<string, unknown>, phase: string): ChatFrame[] {
    if (phase !== 'start' && phase !== 'result') return []
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    if (!runId) return []
    const data = asRecord(payload.data)
    const name = typeof data.name === 'string' ? data.name : ''
    if (!name) return []
    const isError = phase === 'result' ? Boolean(data.isError) : false
    return [
      {
        type: 'tool',
        runId,
        name,
        state: phase === 'start' ? 'running' : isError ? 'error' : 'done',
        id: typeof data.toolCallId === 'string' ? data.toolCallId : null,
        title: data.title ?? null,
        input: phase === 'start' ? (data.args ?? null) : null,
        result: phase === 'result' ? (data.result ?? null) : null,
        isError,
      },
    ]
  }
}
