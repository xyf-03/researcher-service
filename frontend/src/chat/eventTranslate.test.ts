// seam: chat/eventTranslate —— ChatEventTranslator 纯函数翻译（#369 M5 前端接线）。
// 移植 backend/chat/tests/test_event_translate.py 契约断言（delta/final/aborted/error/replace 快照/
// final 尾部/tool phase/approval 卡/approvalResolved）。无 I/O 纯函数，直测模块边界。

import { describe, expect, it } from 'vitest'
import {
  ChatEventTranslator,
  attachmentToMediaBlock,
  extractMessageAttachments,
  extractMessageText,
  extractThinking,
  type GatewayEventFrame,
  type SessionProjectionReducer,
  type SessionProjectionRun,
  type SessionProjectionRunTransition,
} from './eventTranslate'
function chat(state: string, runId = 'r1', extra: Record<string, unknown> = {}): GatewayEventFrame {
  return { type: 'event', event: 'chat', payload: { runId, state, ...extra } }
}

// #560: 直通假归约器——把终态 payload 原样映射为归约结果（等价「SDK 归一后的理想归约」）。
// 既有终态用例（aborted→done / error→error 帧 / final tail-replace）经它断言「经 projection 归约后
// 的等价 ChatFrame」（规格 §5：终态相关用例改为断言归约后产物）；errorMessage 模拟 SDK
// readNonemptyString 归一（trim 后空 → undefined）。
class PassthroughProjection implements SessionProjectionReducer {
  reduce(event: GatewayEventFrame): SessionProjectionRunTransition | null {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    const state = payload.state
    if (!runId || (state !== 'final' && state !== 'aborted' && state !== 'error')) return null
    const run: SessionProjectionRun = { runId, status: state === 'aborted' ? 'aborted' : state === 'error' ? 'error' : 'completed' }
    if (payload.message !== undefined) run.message = payload.message
    if (typeof payload.errorMessage === 'string' && payload.errorMessage.trim()) {
      run.errorMessage = payload.errorMessage.trim()
    }
    if (typeof payload.errorKind === 'string' && payload.errorKind.trim()) {
      run.errorKind = payload.errorKind.trim()
    }
    return { currentRun: run, isReplayedFinal: false }
  }
  reset(): void {}
}

function makeTranslator(): ChatEventTranslator {
  return new ChatEventTranslator(new PassthroughProjection())
}

// #560: 假归约器——测试注入证明「终态判定/终态 message/去重读 currentRun 而非手写 payload 判读」。
// 由测试直接构造 currentRun 结果（status/message/errorMessage/isReplayedFinal 逐用例可控）。
class FakeSessionProjection implements SessionProjectionReducer {
  results = new Map<string, { run?: SessionProjectionRun; transition?: { isReplayedFinal?: boolean } }>()
  reduce(event: GatewayEventFrame): SessionProjectionRunTransition | null {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    const entry = this.results.get(runId)
    if (!entry?.run) return null
    return {
      currentRun: entry.run,
      isReplayedFinal: entry.transition?.isReplayedFinal ?? false,
    }
  }
  reset(): void {
    this.results.clear()
  }
}

function agentTool(phase: string, data: Record<string, unknown> = {}): GatewayEventFrame {
  return {
    type: 'event',
    event: 'agent',
    payload: { runId: 'r1', stream: 'tool', data: { phase, ...data } },
  }
}

function approvalRequested(extra: Record<string, unknown> = {}): GatewayEventFrame {
  return { type: 'event', event: 'exec.approval.requested', payload: { id: 'ap-1', kind: 'exec', ...extra } }
}

describe('ChatEventTranslator', () => {
  it('delta(deltaText) → text 增量', () => {
    const t = makeTranslator()
    expect(t.translate(chat('delta', 'r1', { deltaText: '你好' }))).toEqual([
      { type: 'text', runId: 'r1', delta: '你好' },
    ])
  })

  it('final → done；含未投递尾部先补 text 再 done', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    expect(t.translate(chat('final', 'r1', { message: '你好世界' }))).toEqual([
      { type: 'text', runId: 'r1', delta: '世界' },
      // #569: done 帧携带归约权威 message（外来局部插入数据通道；本 run 消费端不读）
      { type: 'done', runId: 'r1', message: '你好世界' },
    ])
  })

  it('F9: 非前缀 final（空白规范化）→ 整段 replace 帧 + done（不静默丢权威文本）', () => {
    const t = makeTranslator()
    // 流式双空格 → final 规范化单空格（message 非 sent 前缀）
    t.translate(chat('delta', 'r1', { deltaText: 'Hello  world' }))
    expect(t.translate(chat('final', 'r1', { message: 'Hello world' }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'Hello world', replace: true },
      { type: 'done', runId: 'r1', message: 'Hello world' },
    ])
  })

  it('F9: 重复 delta 使 sent 翻倍 → final 前缀不匹配 → replace 纠正', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'abc' }))
    t.translate(chat('delta', 'r1', { deltaText: 'abc' })) // 同内容重复 → sent='abcabc'
    expect(t.translate(chat('final', 'r1', { message: 'abc' }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'abc', replace: true },
      { type: 'done', runId: 'r1', message: 'abc' },
    ])
  })

  // ---- #459-T3 #464：流式消息 image/audio/video 块 → attachment 帧（独立于 text 帧的媒体通道）----
  it('final 含 image 块（browser 截图）→ attachment 帧 + done（无文本 tail）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '这是截图' }))
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: '这是截图' }, { type: 'image', mimeType: 'image/png', content: 'iVBOR' }],
    }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'attachment', runId: 'r1', media: [{ type: 'image', mimeType: 'image/png', src: 'iVBOR' }] },
      { type: 'done', runId: 'r1', message },
    ])
  })

  it('final 纯图片（无文本）→ 仅 attachment 帧 + done（纯图片 run 也渲染）', () => {
    const t = makeTranslator()
    const message = { role: 'assistant', content: [{ type: 'image', mimeType: 'image/png', content: 'AAA' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'attachment', runId: 'r1', media: [{ type: 'image', mimeType: 'image/png', src: 'AAA' }] },
      { type: 'done', runId: 'r1', message },
    ])
  })

  it('final 含 audio + video 块 → attachment 帧携两媒体 + done', () => {
    const t = makeTranslator()
    const message = {
      role: 'assistant',
      content: [
        { type: 'audio', mimeType: 'audio/mpeg', content: 'QUJD' },
        { type: 'video', mimeType: 'video/mp4', content: 'REVG' },
      ],
    }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      {
        type: 'attachment',
        runId: 'r1',
        media: [
          { type: 'audio', mimeType: 'audio/mpeg', src: 'QUJD' },
          { type: 'video', mimeType: 'video/mp4', src: 'REVG' },
        ],
      },
      { type: 'done', runId: 'r1', message },
    ])
  })

  it('final 纯文本（无媒体块）→ 不产 attachment 帧（回归无差）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    const message = { role: 'assistant', content: [{ type: 'text', text: '你好' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([{ type: 'done', runId: 'r1', message }])
  })

  // ---- #565: 结构化 thinking 块随 text 帧携带（方案 A：翻译层提取、随帧携带）----
  // 结构化块只在 replace 快照 / final 消息的 content[] 出现（delta 增量字段是纯文本串，无 content[]），
  // 故增量帧恒不挂 thinking（undefined），handleText 对 undefined 走内联路（splitThinking）现状。
  it('#565: delta replace 快照含 thinking 块 → replace 帧带 thinking', () => {
    const t = makeTranslator()
    expect(
      t.translate(
        chat('delta', 'r1', {
          replace: true,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '推理' }, { type: 'text', text: '快照正文' }] },
        }),
      ),
    ).toEqual([
      { type: 'text', runId: 'r1', delta: '快照正文', replace: true, thinking: '推理' },
    ])
  })

  it('#565: delta replace 快照无 thinking 块 → replace 帧不带 thinking（回归无差）', () => {
    const t = makeTranslator()
    expect(t.translate(chat('delta', 'r1', { message: 'The dog', replace: true }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'The dog', replace: true },
    ])
  })

  // thinking-only replace 快照（思考先于正文的模型输出，text 块未出现）：无文本可渲染——发
  // delta='' 增量帧携带思考（delta='' 不改变前端 raw 累积，仅覆盖 thinking；sent 不更新）
  it('#565: delta replace 快照 thinking-only（无 text 块）→ delta=\'\' 帧带 thinking', () => {
    const t = makeTranslator()
    expect(
      t.translate(
        chat('delta', 'r1', {
          replace: true,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '先想后答' }] },
        }),
      ),
    ).toEqual([{ type: 'text', runId: 'r1', delta: '', thinking: '先想后答' }])
  })

  it('#565: final 含 thinking 块（尾部补发）→ tail 帧带 thinking + done', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '正文' }))
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: '最终推理' }, { type: 'text', text: '正文尾部' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'text', runId: 'r1', delta: '尾部', thinking: '最终推理' },
      { type: 'done', runId: 'r1', message },
    ])
  })

  it('#565: final 非前缀（F9 replace 纠正）含 thinking → replace 帧带 thinking', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '旧' }))
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: '推理' }, { type: 'text', text: '新正文' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'text', runId: 'r1', delta: '新正文', replace: true, thinking: '推理' },
      { type: 'done', runId: 'r1', message },
    ])
  })

  // final 权威文本与 sent 相等（流式 deltaText 已发完，F9 无漂移）→ 不产 text 帧（tail/replace
  // 无变化）；但思考常在 final 的 content[] 才出现（delta 增量是纯文本串）——结构化 thinking 经
  // done 帧独立通道携带（消费端 handleDone 在 finalizeLast 前写入；不谎报文本变更的 replace 帧）
  it('#565: final 含 thinking 块且文本与 sent 相等 → done 帧带 thinking', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'ok' }))
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: 'ok' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'done', runId: 'r1', thinking: '思考', message },
    ])
  })

  it('#565: final 无文本（thinking-only 消息，E1b abort 形状）→ done 帧带 thinking', () => {
    const t = makeTranslator()
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: '推理' }, { type: 'toolCall', name: 'exec' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'done', runId: 'r1', thinking: '推理', message },
    ])
  })

  // final 已产 tail 帧（已带 thinking）→ done 不重复挂（幂等，文本变化仍走 text 帧）
  it('#565: final 相等含 thinking 但已产 text 帧 → done 帧不带 thinking（不重复）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '正文' }))
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: '最终推理' }, { type: 'text', text: '正文尾部' }] }
    expect(t.translate(chat('final', 'r1', { message }))).toEqual([
      { type: 'text', runId: 'r1', delta: '尾部', thinking: '最终推理' },
      { type: 'done', runId: 'r1', message },
    ])
  })

  // F9 现有相等回归：message 为 string 时无结构化块 → 仍只发 done（不挂 thinking 字段，行为不变）
  it('#565: final 与 sent 相等且无 thinking 块 → 仅 done（回归无差）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'ok' }))
    expect(t.translate(chat('final', 'r1', { message: 'ok' }))).toEqual([
      { type: 'done', runId: 'r1', message: 'ok' },
    ])
  })

  it('#565: final 无 thinking 块（tail 补发）→ tail 帧不带 thinking（回归无差）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    expect(t.translate(chat('final', 'r1', { message: '你好世界' }))).toEqual([
      { type: 'text', runId: 'r1', delta: '世界' },
      { type: 'done', runId: 'r1', message: '你好世界' },
    ])
  })

  // #569: done 帧扩展——外来 run final 的归约权威 message（currentRun.message）透出到 done 帧，
  // 供 handleDone 外来分支局部插入（数据通道）。翻译层无外来概念（纯函数），有归约 message 即带；
  // 消费端只在外来分支读该字段，本 run 分支沿用 tail 补发逻辑不读。
  it('#569: final 归约 message 透出到 done 帧（外来可见 final 局部插入的数据通道）', () => {
    const t = makeTranslator()
    const message = { role: 'assistant', content: [{ type: 'text', text: '外来结果' }] }
    expect(t.translate(chat('final', 'foreign-1', { message }))).toEqual([
      { type: 'text', runId: 'foreign-1', delta: '外来结果' },
      { type: 'done', runId: 'foreign-1', message },
    ])
  })

  // #569: 归约无 message（final 未带权威 message 且无 delta 快照）→ done 帧不带 message 字段
  //（外来分支无可插入内容，行为同现状）。
  it('#569: final 归约无 message → done 帧不带 message（外来分支无可插入，回归无差）', () => {
    const t = makeTranslator()
    expect(t.translate(chat('final', 'foreign-1'))).toEqual([{ type: 'done', runId: 'foreign-1' }])
  })

  it('#565: delta 增量帧不挂 thinking（undefined）', () => {
    const t = makeTranslator()
    const [frame] = t.translate(chat('delta', 'r1', { deltaText: 'x' }))
    expect(frame).toEqual({ type: 'text', runId: 'r1', delta: 'x' })
    expect('thinking' in frame).toBe(false)
  })

  it('delta replace 快照含媒体无文本 → attachment 帧（不回退 deltaText）', () => {
    const t = makeTranslator()
    expect(
      t.translate(
        chat('delta', 'r1', {
          replace: true,
          message: { role: 'assistant', content: [{ type: 'image', mimeType: 'image/png', content: 'SNAP' }] },
        }),
      ),
    ).toEqual([
      { type: 'attachment', runId: 'r1', media: [{ type: 'image', mimeType: 'image/png', src: 'SNAP' }] },
    ])
  })

  it('F9: final 与 sent 完全相等 → 仅 done（无漂移不 replace）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'ok' }))
    expect(t.translate(chat('final', 'r1', { message: 'ok' }))).toEqual([
      { type: 'done', runId: 'r1', message: 'ok' },
    ])
  })

  it('final.message 为 dict{content:[{type:text,text}]} 时从 content[].text 提取（实测校准）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    const msg = { role: 'assistant', content: [{ type: 'text', text: '你好世界' }], timestamp: 1785148522491 }
    expect(t.translate(chat('final', 'r1', { message: msg }))).toEqual([
      { type: 'text', runId: 'r1', delta: '世界' },
      { type: 'done', runId: 'r1', message: msg },
    ])
  })

  it('delta replace=true + message 快照 → replace 帧（整段替换，前缀/非前缀均正确）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'The cat' }))
    expect(t.translate(chat('delta', 'r1', { message: 'The dog', replace: true }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'The dog', replace: true },
    ])
  })

  it('delta replace=true 无快照 → 退回 deltaText 增量', () => {
    const t = makeTranslator()
    expect(t.translate(chat('delta', 'r1', { deltaText: 'x', replace: true }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'x' },
    ])
  })

  it('final 无 message → 仅 done（不重复发已投递文本）', () => {
    const t = makeTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    expect(t.translate(chat('final', 'r1'))).toEqual([{ type: 'done', runId: 'r1' }])
  })

  it('error → error 帧（errorMessage 优先，退 errorKind）', () => {
    const t = makeTranslator()
    expect(t.translate(chat('error', 'r1', { errorMessage: '模型超时' }))).toEqual([
      { type: 'error', runId: 'r1', message: '模型超时' },
    ])
    expect(t.translate(chat('error', 'r1', { errorKind: 'RATE_LIMIT' }))).toEqual([
      { type: 'error', runId: 'r1', message: 'RATE_LIMIT' },
    ])
  })

  it('aborted → done（视作收尾，非错误）', () => {
    const t = makeTranslator()
    expect(t.translate(chat('aborted'))).toEqual([{ type: 'done', runId: 'r1' }])
  })

  it('未知 state / 缺 runId / 非 event 帧 / 非 chat 事件 → []', () => {
    const t = makeTranslator()
    expect(t.translate(chat('streaming'))).toEqual([])
    expect(t.translate({ type: 'event', event: 'chat', payload: { state: 'delta', deltaText: 'x' } })).toEqual([])
    expect(t.translate({ type: 'res', id: 'x', ok: true } as unknown as GatewayEventFrame)).toEqual([])
    expect(t.translate({ type: 'event', event: 'health.changed', payload: {} })).toEqual([])
  })

  it('delta message 变体（非 replace）→ []；replace 无快照无 deltaText → []', () => {
    const t = makeTranslator()
    expect(t.translate(chat('delta', 'r1', { message: '消息级 delta' }))).toEqual([])
    expect(t.translate(chat('delta', 'r1', { replace: true }))).toEqual([])
  })

  // ---- T06 权限审批 ----
  it('exec.approval.requested → approval 卡（request.command 优先）', () => {
    const t = makeTranslator()
    const frame = approvalRequested({ request: { command: 'rm -rf /tmp/x', sessionKey: 'sk-1' } })
    expect(t.translate(frame)).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: 'sk-1', agentId: null },
    ])
  })

  it('approval 卡 command 取值链：request 缺失退 systemRunPlan.rawCommand → command → 顶层 command', () => {
    const t = makeTranslator()
    expect(t.translate(approvalRequested({ systemRunPlan: { rawCommand: 'ls -la' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'ls -la', sessionKey: null, agentId: null },
    ])
    expect(t.translate(approvalRequested({ systemRunPlan: { command: 'pwd' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'pwd', sessionKey: null, agentId: null },
    ])
    expect(t.translate(approvalRequested({ command: 'top' }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'top', sessionKey: null, agentId: null },
    ])
  })

  it('approval 卡 kind 缺省 → 从事件名族派生（plugin.approval.requested → plugin）', () => {
    const t = makeTranslator()
    const frame = { type: 'event', event: 'plugin.approval.requested', payload: { id: 'ap-2', command: 'x' } }
    expect(t.translate(frame)).toEqual([
      { type: 'approval', id: 'ap-2', kind: 'plugin', command: 'x', sessionKey: null, agentId: null },
    ])
  })

  it('approval 卡缺 id → []（无法 resolve，不出卡）；缺 command 容忍为空', () => {
    const t = makeTranslator()
    expect(t.translate({ type: 'event', event: 'exec.approval.requested', payload: { kind: 'exec' } })).toEqual([])
    expect(t.translate(approvalRequested({ request: { sessionKey: 'sk' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: '', sessionKey: 'sk', agentId: null },
    ])
  })

  it('approval 卡 agentId 透传：request.agentId（#394 实测恒下发，string 才取）', () => {
    const t = makeTranslator()
    expect(t.translate(approvalRequested({ request: { command: 'x', agentId: 'sub-1' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'x', sessionKey: null, agentId: 'sub-1' },
    ])
    // 缺省 → null（主会话审批）；非 string（0 信任防御）→ null
    expect(t.translate(approvalRequested({ request: { command: 'x' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'x', sessionKey: null, agentId: null },
    ])
    expect(t.translate(approvalRequested({ request: { command: 'x', agentId: 42 } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'x', sessionKey: null, agentId: null },
    ])
  })

  it('approval 卡 agentId 回退路径：request 缺失时读 systemRunPlan.agentId（host=node 时存在）', () => {
    const t = makeTranslator()
    expect(t.translate(approvalRequested({ systemRunPlan: { rawCommand: 'ls', agentId: 'sub-2' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'ls', sessionKey: null, agentId: 'sub-2' },
    ])
    // 回退路径同样防御：agentId 缺省/非 string → null
    expect(t.translate(approvalRequested({ systemRunPlan: { rawCommand: 'ls', agentId: false } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'ls', sessionKey: null, agentId: null },
    ])
  })

  // ---- T08 工具 ----
  it('tool start → running 帧（data.name/toolCallId/args → name/id/input）', () => {
    const t = makeTranslator()
    expect(t.translate(agentTool('start', { name: 'wiki.search', toolCallId: 'call-1', args: { query: '对比学习' } }))).toEqual([
      { type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running', id: 'call-1', title: null, input: { query: '对比学习' }, result: null, isError: false },
    ])
  })

  it('tool result → done 帧；isError=true → error 帧', () => {
    const t = makeTranslator()
    expect(t.translate(agentTool('result', { name: 'wiki.search', toolCallId: 'call-2', result: { count: 3 }, isError: false }))).toEqual([
      { type: 'tool', runId: 'r1', name: 'wiki.search', state: 'done', id: 'call-2', title: null, input: null, result: { count: 3 }, isError: false },
    ])
    expect(t.translate(agentTool('result', { name: 'bash', toolCallId: 'call-4', result: { exitCode: 1 }, isError: true }))).toEqual([
      { type: 'tool', runId: 'r1', name: 'bash', state: 'error', id: 'call-4', title: null, input: null, result: { exitCode: 1 }, isError: true },
    ])
  })

  it('tool update → []（跳过中间增量）；非 tool stream → []；缺 runId/name → []', () => {
    const t = makeTranslator()
    expect(t.translate(agentTool('update', { name: 'bash', toolCallId: 'call-3' }))).toEqual([])
    expect(t.translate({ type: 'event', event: 'agent', payload: { runId: 'r1', stream: 'item', data: { kind: 'command' } } })).toEqual([])
    expect(t.translate({ type: 'event', event: 'agent', payload: { stream: 'tool', data: { phase: 'start' } } })).toEqual([])
    expect(t.translate(agentTool('start'))).toEqual([])
  })

  // ---- approval resolved ----
  it('exec/plugin.approval.resolved → approvalResolved 帧（透传权威 decision，未知值不默认批准）', () => {
    const t = makeTranslator()
    expect(t.translate({ type: 'event', event: 'plugin.approval.resolved', payload: { id: 'ap-1', decision: 'deny' } })).toEqual([
      { type: 'approvalResolved', id: 'ap-1', decision: 'deny' },
    ])
    expect(t.translate({ type: 'event', event: 'exec.approval.resolved', payload: { id: 'ap-2', decision: 'allow-once' } })).toEqual([
      { type: 'approvalResolved', id: 'ap-2', decision: 'allow-once' },
    ])
    expect(t.translate({ type: 'event', event: 'plugin.approval.resolved', payload: { id: 'ap-1', decision: 'expired' } })[0]).toEqual(
      { type: 'approvalResolved', id: 'ap-1', decision: 'expired' },
    )
    expect(t.translate({ type: 'event', event: 'plugin.approval.resolved', payload: { decision: 'approve' } })).toEqual([])
  })

  it('P2-1: 无 runId 的 chat.error → 连接级错误帧（不静默丢弃，handleError no-runId 分支可达）', () => {
    const t = makeTranslator()
    // 会话级错误（如「会话不存在」）无 runId——旧实现返回 [] 保证不可见
    expect(
      t.translate({ type: 'event', event: 'chat', payload: { state: 'error', errorMessage: '会话不存在' } }),
    ).toEqual([{ type: 'error', message: '会话不存在' }])
    // run 级错误仍挂 runId（走 runId 过滤）
    expect(
      t.translate({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'error', errorMessage: 'failed' } }),
    ).toEqual([{ type: 'error', runId: 'r1', message: 'failed' }])
  })

  // ---- #560: SDK SessionProjection 减负——终态判定/终态 message/去重读注入归约器的 currentRun ----
  // 实证用例（规格 §4.3-4.5）：假归约器注入证明「判定来源是 currentRun 而非手写 payload 判读」、
  // timeout/yielded 细分、重放去重跳过渲染。

  it('#560 §4.3: 注入归约器后 final 的 message 来自 currentRun.message（delta 快照被 final 权威覆盖）', () => {
    const proj = new FakeSessionProjection()
    const t = new ChatEventTranslator(proj)
    t.translate(chat('delta', 'r1', { deltaText: 'Hello' }))
    // 归约器模拟「SDK updateRun 归一」：currentRun.message 是 final 权威（delta 快照已被覆盖）
    proj.results.set('r1', { run: { runId: 'r1', status: 'completed', message: 'Hello world' } })
    expect(t.translate(chat('final', 'r1', { message: 'stale' }))).toEqual([
      { type: 'text', runId: 'r1', delta: ' world' },
      // #569: done 帧携带归约权威 message（currentRun.message，非 payload）
      { type: 'done', runId: 'r1', message: 'Hello world' },
    ])
  })

  it('#560 §4.3: error 事件的 errorMessage 经归约器归一（trim 后空 → 回退 errorKind，非手写取舍）', () => {
    const proj = new FakeSessionProjection()
    const t = new ChatEventTranslator(proj)
    // 归约器模拟 readNonemptyString 归一：payload 的 errorMessage 空白被 trim → undefined；
    // errorKind 也经归一（真实 SDK 把两者都归一到 currentRun）
    proj.results.set('r1', { run: { runId: 'r1', status: 'error', errorKind: 'RATE_LIMIT' } })
    expect(t.translate(chat('error', 'r1', { errorMessage: '   ', errorKind: 'RATE_LIMIT' }))).toEqual([
      { type: 'error', runId: 'r1', message: 'RATE_LIMIT' },
    ])
    // currentRun.errorMessage 权威优先（与 payload 不一致时以归约结果为准）
    proj.results.set('r2', { run: { runId: 'r2', status: 'error', errorMessage: '归一化文案' } })
    expect(t.translate(chat('error', 'r2', { errorMessage: '原始文案' }))).toEqual([
      { type: 'error', runId: 'r2', message: '归一化文案' },
    ])
  })

  it('#560 §4.5: timeout 细分——error + errorKind=timeout → error 帧带超时标记', () => {
    const proj = new FakeSessionProjection()
    const t = new ChatEventTranslator(proj)
    proj.results.set('r1', { run: { runId: 'r1', status: 'timeout', errorMessage: 'request timed out' } })
    expect(t.translate(chat('error', 'r1', { errorKind: 'timeout' }))).toEqual([
      { type: 'error', runId: 'r1', message: 'request timed out（超时）' },
    ])
  })

  it('#560 §4.5: yielded 细分——final + yielded → done 帧（SDK 语义：yielded=true && stopReason=end_turn）', () => {
    const proj = new FakeSessionProjection()
    const t = new ChatEventTranslator(proj)
    proj.results.set('r1', { run: { runId: 'r1', status: 'yielded', message: '让出给下个 agent' } })
    expect(t.translate(chat('final', 'r1', { yielded: true, stopReason: 'end_turn' }))).toEqual([
      { type: 'done', runId: 'r1' },
    ])
  })

  it('#560 §4.4: 重放去重——isReplayedFinal=true 时同一 final 再次到达 → 跳过渲染（[]）', () => {
    const proj = new FakeSessionProjection()
    const t = new ChatEventTranslator(proj)
    // 模拟「previousRun 已终态 + hasSessionProjectionAcceptedFinal 命中」——resume 重放/断线重发
    proj.results.set('r1', {
      run: { runId: 'r1', status: 'completed', message: 'done' },
      transition: { isReplayedFinal: true },
    })
    expect(t.translate(chat('final', 'r1', { message: 'done' }))).toEqual([])
    // error/aborted 事件不走重放网（SDK acceptedFinalMessageIdentities 只记 completed/yielded）——
    // isReplayedFinal=true 也不拦截，恒产帧（handleError/handleDone 幂等，多产无害）
    proj.results.set('r2', {
      run: { runId: 'r2', status: 'error', errorKind: 'RATE_LIMIT' },
      transition: { isReplayedFinal: true },
    })
    expect(t.translate(chat('error', 'r2', { errorKind: 'RATE_LIMIT' }))).toEqual([
      { type: 'error', runId: 'r2', message: 'RATE_LIMIT' },
    ])
    expect(t.translate(chat('aborted', 'r3'))).toEqual([{ type: 'done', runId: 'r3' }])
  })

  it('#560: final + stopReason=error → error 帧而非 done（SDK 归约为 status=error；尾部/媒体先行补发，权威内容不丢）', () => {
    const proj = new FakeSessionProjection()
    const t = new ChatEventTranslator(proj)
    t.translate(chat('delta', 'r1', { deltaText: '部分文本' }))
    proj.results.set('r1', { run: { runId: 'r1', status: 'error', message: '部分文本尾部', errorMessage: 'tool failed' } })
    expect(t.translate(chat('final', 'r1', { message: '部分文本尾部', stopReason: 'error' }))).toEqual([
      { type: 'text', runId: 'r1', delta: '尾部' },
      { type: 'error', runId: 'r1', message: 'tool failed' },
    ])
  })

  it('P2-2: reset 清空 sent 累积（断线重连边界，防 resume 重放双重追加）', () => {
    const t = makeTranslator()
    // 流式累积 sent['r1']='abc'
    t.translate({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: 'abc' } })
    // 断线重连（生命周期边界）→ reset
    t.reset()
    // 网关 resume 从头重放 delta + final → 不清空会双重追加（sent='abc' 时 final tail 只补 ' def'，
    // 渲染端把重放 delta 再 append → 'abcabc def' 翻倍）；reset 后 final 对空 sent 发完整 'abc def'
    const out = t.translate({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: 'abc def' } })
    expect(out).toEqual([
      { type: 'text', runId: 'r1', delta: 'abc def' }, // 完整文本（非 ' def' 尾部残差）
      { type: 'done', runId: 'r1', message: 'abc def' },
    ])
  })

  it('P2-2: 有界——sent 超上限时全新 run 不增长（终态前断线的 run 不无界泄漏）', () => {
    const t = makeTranslator()
    // 私有字段（测试同模块访问）；上限 500
    const MAX = (t as unknown as { MAX_SENT_ENTRIES: number }).MAX_SENT_ENTRIES
    for (let i = 0; i < MAX; i++) {
      t.translate({ type: 'event', event: 'chat', payload: { runId: `r${i}`, state: 'delta', deltaText: 'x' } })
    }
    const sent = (t as unknown as { sent: Map<string, string> }).sent
    expect(sent.size).toBe(MAX)
    // 再进全新 run → 不增长
    t.translate({ type: 'event', event: 'chat', payload: { runId: 'overflow', state: 'delta', deltaText: 'x' } })
    expect(sent.size).toBe(MAX)
    expect(sent.has('overflow')).toBe(false)
  })
})

// E1: extractMessageText 是内容提取单一实现（流式 final/delta 与 loadHistory 历史复用）。
// history 消息 content 多态（ADR 0003）：user=string / assistant=数组。
describe('extractMessageText（E1: content 多态，ChatView 历史复用）', () => {
  it('string message 直返', () => {
    expect(extractMessageText('你好')).toBe('你好')
  })
  it('dict content 为 string（user 历史消息）直返', () => {
    expect(extractMessageText({ role: 'user', content: '我的问题' })).toBe('我的问题')
  })
  it('dict content 为数组（assistant 历史）拼 type=text，跳过 thinking', () => {
    expect(
      extractMessageText({
        role: 'assistant',
        content: [{ type: 'thinking', text: '内心' }, { type: 'text', text: '回答' }, { type: 'text', text: '续' }],
      }),
    ).toBe('回答续')
  })
  it('None/空/无 content → 空串（不渲染空泡）', () => {
    expect(extractMessageText(null)).toBe('')
    expect(extractMessageText({ role: 'assistant' })).toBe('')
    expect(extractMessageText({})).toBe('')
  })
})

// #565: extractThinking —— 结构化 thinking 块提取单一实现（history 全量 + 流式 replace/final 复用，
// 与 extractMessageText 并列：只读 content[] 中 type==='thinking' 块的 thinking 字段（非 text）、
// 逐块 trim、丢空串、多块 '\n' join、全空/无块/content 非数组/message 非对象 → null（区别于 ''））。
// 与内联 <thinking> 标签路（splitThinking）双路并存、各司其职（对齐官方 stripThinkingTags +
// extractThinking 双函数分工）。
describe('extractThinking（#565: 结构化 thinking 块提取）', () => {
  it('trim + 多块 \n join（跳过 text 块，不读 text 字段兜底）', () => {
    expect(
      extractThinking({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '  想A  ' },
          { type: 'text', text: '正文' },
          { type: 'thinking', thinking: '想B' },
        ],
      }),
    ).toBe('想A\n想B')
  })
  it('全空/无 thinking 块/content 非数组/message 为 string 或 null → null', () => {
    expect(extractThinking({ role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] })).toBeNull()
    expect(extractThinking({ role: 'assistant', content: [{ type: 'thinking', thinking: '' }] })).toBeNull()
    expect(extractThinking({ role: 'assistant', content: [{ type: 'text', text: 'x' }] })).toBeNull()
    expect(extractThinking({ role: 'assistant' })).toBeNull()
    expect(extractThinking({ role: 'user', content: '字符串' })).toBeNull()
    expect(extractThinking('字符串')).toBeNull()
    expect(extractThinking(null)).toBeNull()
  })
  it('thinking 字段非 string（缺省/null/数字）→ 跳过该块；混入有效块时跳过不拦截', () => {
    expect(
      extractThinking({
        role: 'assistant',
        content: [{ type: 'thinking' }, { type: 'thinking', thinking: null }, { type: 'thinking', thinking: 42 }],
      }),
    ).toBeNull()
    expect(
      extractThinking({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: null }, { type: 'thinking', thinking: '有效' }],
      }),
    ).toBe('有效')
  })
})

// #459-T3 #464：extractMessageAttachments 是附件块提取单一实现（历史 loadHistory 与流式
// final/delta 复用，与 extractMessageText 并列——文本与附件走独立数据通道，互不污染）。
// 附件块渲染数据（type/mime/src=纯 base64）供 img/audio/video 标签；src 重建 dataURL 在组件侧。
describe('extractMessageAttachments（#459-T3 #464: image/audio/video 块 → 渲染数据）', () => {
  it('assistant content 含 image 块 → 产出 image 媒体（src=纯 base64）', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'image', mimeType: 'image/png', content: 'iVBORw0KGgo=' }],
      }),
    ).toEqual([{ type: 'image', mimeType: 'image/png', src: 'iVBORw0KGgo=' }])
  })
  it('audio/video 块 → 各产出对应媒体', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [
          { type: 'audio', mimeType: 'audio/mpeg', content: 'QUJD' },
          { type: 'video', mimeType: 'video/mp4', content: 'REVG' },
        ],
      }),
    ).toEqual([
      { type: 'audio', mimeType: 'audio/mpeg', src: 'QUJD' },
      { type: 'video', mimeType: 'video/mp4', src: 'REVG' },
    ])
  })
  it('文本 + 附件混合：附件入媒体通道，文本块不混入', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [
          { type: 'text', text: '这是截图：' },
          { type: 'image', mimeType: 'image/png', content: 'AAA' },
        ],
      }),
    ).toEqual([{ type: 'image', mimeType: 'image/png', src: 'AAA' }])
  })
  it('非 media 块（text/thinking/toolCall）→ 空数组（不丢进媒体通道）', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'thinking', text: '内心' }, { type: 'text', text: '回答' }, { type: 'toolCall', name: 'exec' }],
      }),
    ).toEqual([])
  })
  it('mimeType 前缀与块 type 不一致 → 按块 type 归类（0 信任，不猜测）', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'image', mimeType: 'application/octet-stream', content: 'AAA' }],
      }),
    ).toEqual([{ type: 'image', mimeType: 'application/octet-stream', src: 'AAA' }])
  })
  it('0 信任：content 非 string（缺失/对象/数字）→ 跳过该块', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [
          { type: 'image', mimeType: 'image/png' }, // 无 content
          { type: 'image', mimeType: 'image/png', content: { data: 'x' } }, // content 非 string
          { type: 'image', mimeType: 'image/png', content: 123 }, // content 数字
          { type: 'image', mimeType: 'image/png', content: '' }, // 空 content
        ],
      }),
    ).toEqual([])
  })
  it('string message / 无 content / null → 空数组（无附件）', () => {
    expect(extractMessageAttachments('你好')).toEqual([])
    expect(extractMessageAttachments({ role: 'user', content: '问题' })).toEqual([])
    expect(extractMessageAttachments(null)).toEqual([])
    expect(extractMessageAttachments({})).toEqual([])
  })
  it('mimeType 缺失/非 string → 回退 type/ 前缀（img/audio/video src 须完整 dataURL mime）', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'image', content: 'AAA' }], // 无 mimeType
      }),
    ).toEqual([{ type: 'image', mimeType: 'image/*', src: 'AAA' }])
  })

  // ---- #568: history 附件元数据增强——同形状条件透传（有才带上、缺则不带，0 信任）----
  it('#568: 块带 sizeBytes/durationMs/width/height/label → 条件透传进 MediaBlock', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{
          type: 'image', mimeType: 'image/png', content: 'AAA',
          sizeBytes: 1024, durationMs: 500, width: 1280, height: 720, label: '截图',
        }],
      }),
    ).toEqual([{
      type: 'image', mimeType: 'image/png', src: 'AAA',
      sizeBytes: 1024, durationMs: 500, width: 1280, height: 720, label: '截图',
    }])
  })
  it('#568: 非法元数据值（负数/非 number/空 label）→ 条件透传不带（回退现状形状）', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{
          type: 'video', mimeType: 'video/mp4', content: 'REVG',
          sizeBytes: -1, durationMs: '500', width: 0, height: -720, label: '',
        }],
      }),
    ).toEqual([{ type: 'video', mimeType: 'video/mp4', src: 'REVG' }])
  })
  // ---- #568: document 型 + attachment/url 形态（纯防御：面板 history 未实测，条件透传保证无形态则零影响）----
  it('#568: document 型块（content base64）→ type document + fileName/sizeBytes', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'document', mimeType: 'application/pdf', fileName: 'report.pdf', content: 'JVBER', sizeBytes: 2048 }],
      }),
    ).toEqual([{ type: 'document', mimeType: 'application/pdf', fileName: 'report.pdf', src: 'JVBER', sizeBytes: 2048 }])
  })
  it('#568: attachment 形态块（{type:attachment, attachment:{kind,url,...}}）→ 从子对象提取', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{
          type: 'attachment',
          attachment: { kind: 'image', url: 'https://img.example.com/x.png', mimeType: 'image/png', label: '外链图', sizeBytes: 512, width: 640, height: 480 },
        }],
      }),
    ).toEqual([{
      type: 'image', mimeType: 'image/png', src: 'https://img.example.com/x.png',
      label: '外链图', sizeBytes: 512, width: 640, height: 480,
    }])
  })
  it('#568: url 形态块（{type:document, url,...}）→ src 直存完整 url 不拼 base64', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'document', url: 'https://files.example.com/report.pdf', label: '报告', sizeBytes: 4096 }],
      }),
    ).toEqual([{ type: 'document', mimeType: 'document/*', src: 'https://files.example.com/report.pdf', label: '报告', sizeBytes: 4096 }])
  })
  it('#568: attachment 形态缺 kind / url 形态缺 url → 跳过该块（0 信任）', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [
          { type: 'attachment', attachment: { url: 'https://x/y.png' } }, // 无 kind
          { type: 'attachment' }, // 无 attachment 子对象
          { type: 'document', label: '无 url' }, // url 形态无 url
        ],
      }),
    ).toEqual([])
  })
  // ---- #568 安全修复（security review）：url 形态只收完整 http(s)——其他 scheme/相对/畸形 url 一律跳过 ----
  it('#568(security): url 形态非 http(s)（javascript:/file:/data:/相对 url）→ 跳过该块', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [
          { type: 'image', url: 'javascript:alert(1)' },
          { type: 'document', url: 'file:///etc/passwd' },
          { type: 'audio', url: 'data:audio/mpeg;base64,QUJD' },
          { type: 'video', url: '//evil.com/x.mp4' }, // 协议相对
          { type: 'image', url: '/relative.png' }, // 相对路径
        ],
      }),
    ).toEqual([])
  })
  it('#568(security): attachment 形态 url 非 http(s) → 跳过该块', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'attachment', attachment: { kind: 'image', url: 'javascript:alert(1)' } }],
      }),
    ).toEqual([])
  })
  it('#568(security): attachment 形态 url 为完整 http(s)（含 mimeType 缺失回退）→ 保留', () => {
    expect(
      extractMessageAttachments({
        role: 'assistant',
        content: [{ type: 'attachment', attachment: { kind: 'image', url: 'http://img.example.com/x.png' } }],
      }),
    ).toEqual([{ type: 'image', mimeType: 'image/*', src: 'http://img.example.com/x.png' }])
  })
})

// #459-T3 #464：attachmentToMediaBlock——发送 echo 路径（useChatConnection.send）与历史/流式
// extractMessageAttachments 共用同一 MediaBlock 投影（code-review：消除两路派生逻辑双写 drift）。
describe('attachmentToMediaBlock（#459-T3 #464: 发送侧 Attachment → MediaBlock echo 投影）', () => {
  it('image 附件 → MediaBlock（type/mime/src/fileName 全带）', () => {
    expect(
      attachmentToMediaBlock({ type: 'image', mimeType: 'image/png', fileName: 'shot.png', content: 'iVBOR' }),
    ).toEqual({ type: 'image', mimeType: 'image/png', src: 'iVBOR', fileName: 'shot.png' })
  })
  it('audio/video 附件 → 对应 MediaBlock（无 fileName 省略）', () => {
    expect(attachmentToMediaBlock({ type: 'audio', mimeType: 'audio/mpeg', content: 'QUJD' })).toEqual({
      type: 'audio', mimeType: 'audio/mpeg', src: 'QUJD',
    })
    expect(attachmentToMediaBlock({ type: 'video', mimeType: 'video/mp4', content: 'REVG' })).toEqual({
      type: 'video', mimeType: 'video/mp4', src: 'REVG',
    })
  })
  it('非 media type / 缺失 type → null（不 echo）', () => {
    expect(attachmentToMediaBlock({ type: 'application', mimeType: 'application/pdf', content: 'AAA' })).toBeNull()
    expect(attachmentToMediaBlock({ mimeType: 'image/png', content: 'AAA' })).toBeNull()
  })
  it('content 非 string / 空 → null（无法渲染，跳过）', () => {
    expect(attachmentToMediaBlock({ type: 'image', mimeType: 'image/png', content: { data: 'x' } })).toBeNull()
    expect(attachmentToMediaBlock({ type: 'image', mimeType: 'image/png', content: '' })).toBeNull()
    expect(attachmentToMediaBlock({ type: 'image', mimeType: 'image/png' })).toBeNull()
  })
  it('mimeType 缺失 → 回退 type/ 前缀', () => {
    expect(attachmentToMediaBlock({ type: 'image', content: 'AAA' })).toEqual({
      type: 'image', mimeType: 'image/*', src: 'AAA',
    })
  })
  // ---- #568: 发送 echo 路接通——Attachment 带 4 元数据 → 透传进 MediaBlock（§2.1 数据已确证）----
  it('#568: Attachment 带 sizeBytes/durationMs/width/height → 条件透传', () => {
    expect(
      attachmentToMediaBlock({ type: 'image', mimeType: 'image/png', fileName: 'shot.png', content: 'iVBOR', sizeBytes: 1024, width: 640, height: 480 }),
    ).toEqual({
      type: 'image', mimeType: 'image/png', src: 'iVBOR', fileName: 'shot.png', sizeBytes: 1024, width: 640, height: 480,
    })
  })
  it('#568: Attachment 非法元数据值（负数）→ 不带（回退现状形状）', () => {
    expect(
      attachmentToMediaBlock({ type: 'image', mimeType: 'image/png', content: 'iVBOR', sizeBytes: -5, width: 0 }),
    ).toEqual({ type: 'image', mimeType: 'image/png', src: 'iVBOR' })
  })
  it('#568: document 附件 → document MediaBlock（发送 echo 路防御）', () => {
    expect(
      attachmentToMediaBlock({ type: 'document', mimeType: 'application/pdf', fileName: 'doc.pdf', content: 'JVBER', sizeBytes: 2048 }),
    ).toEqual({
      type: 'document', mimeType: 'application/pdf', fileName: 'doc.pdf', src: 'JVBER', sizeBytes: 2048,
    })
  })
})
