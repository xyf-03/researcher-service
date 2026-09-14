// PHASE 2 retry-run handoff —— useChatConnection 的 run 认领状态机单元测试。
// 不 mount 组件：直接实例化 useChatConnection(status)，用 MockGatewayChat 驱动 openGateway/首连 +
// fireFrame 触达 handle*（text/attachment/done）。覆盖：
//   A 正常单 run（ack→delta/media→final）行为不变
//   B 本 run 空 final → gateway retry run 认领（media 进 pipeline，无 foreign 污染）
//   C retry run 复用相同 media path 不被旧 run dedupe 污染（resolvedMediaPaths 按 runId 分桶）
//   D 真 foreign run（pending active 期间陌生 runId）仍被丢弃
//   E empty final 无 retry → 明确失败提示 + 空白占位删除 + pending 清理
//   F 连续三次请求状态完全复位（run2 空 final→retry handoff 不污染 run3）
//   G foreign empty final（runId !== myRunId）不得开启 retryPending，后续陌生 run 不得被认领
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useFileTabsStore } from '@/stores/fileTabs'
import { buildAttachments } from '@/chat/attachments'
import { useChatConnection, type ChatStatus } from './useChatConnection'

vi.mock('@/api/chat', () => ({ getBootstrapToken: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, apiFetch: vi.fn() }
})
vi.mock('@/chat/gatewayChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/chat/gatewayChat')>()
  return {
    ...actual, // #564: createRequestId 保留真实实现（useChatConnection 生成 outbox 幂等 id 用）
    createGatewayChat: vi.fn(),
  }
})

type MockHandlers = {
  onReady: () => void
  onFrame: (frame: unknown) => void
  onClose: (code: number, reason: string, retry: boolean, pairingRequired?: boolean) => void
  onError: (message: string) => void
}

const { MockGatewayChat } = vi.hoisted(() => {
  class MockGatewayChat {
    static last: MockGatewayChat | null = null
    static instances: MockGatewayChat[] = []
    handlers: MockHandlers
    listSessions = vi.fn()
    createSession = vi.fn()
    deleteSession = vi.fn()
    getHistory = vi.fn()
    send = vi.fn()
    rewind = vi.fn() // #694 对话回退（sessions.rewind）
    forkEntry = vi.fn() // #697 对话 fork（sessions.fork）
    listBranches = vi.fn() // #698 分支菜单（sessions.branches.list）
    switchBranch = vi.fn() // #698 分支切换（sessions.branches.switch）
    sessionControlAvailable = vi.fn(() => true) // #694 会话控制能力（默认 9.4+ 网关可用）
    listCommands = vi.fn()
    resolveApproval = vi.fn()
    listPendingApprovals = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    closeSocket = vi.fn()
    constructor(handlers: MockHandlers) {
      this.handlers = handlers
      MockGatewayChat.instances.push(this)
      MockGatewayChat.last = this
    }
    fireReady(): void {
      this.handlers.onReady()
    }
    fireFrame(frame: unknown): void {
      this.handlers.onFrame(frame)
    }
    fireClose(code: number, reason = '', retry = true, pairingRequired?: boolean): void {
      this.handlers.onClose(code, reason, retry, pairingRequired)
    }
    fireError(message: string): void {
      this.handlers.onError(message)
    }
  }
  return { MockGatewayChat }
})

import { getBootstrapToken } from '@/api/chat'
import { createGatewayChat } from '@/chat/gatewayChat'
import { apiFetch } from '@/api/client'

const IMG_PATH = '/home/node/.openclaw/workspace/test.png'
const IMG_MEDIA = [{ type: 'image', mimeType: 'image/png', src: IMG_PATH }]

function setup(opts: { withoutActionError?: boolean } = {}): { status: ChatStatus & Record<string, ReturnType<typeof vi.fn>>; conn: ReturnType<typeof useChatConnection>; chat: ReturnType<typeof useChatStore> } {
  const status: ChatStatus & Record<string, ReturnType<typeof vi.fn>> = {
    onConnecting: vi.fn(),
    onError: vi.fn(),
    onClearError: vi.fn(),
    // #694 动作类失败通道（宿主注入；ChatView 接 ElMessage）。withoutActionError 用于验证缺省回退 onError。
    ...(opts.withoutActionError ? {} : { onActionError: vi.fn<(message: string) => void>() }),
    // #694 回退编排的 composer 协同（宿主注入）：缺省「草稿全程未变」→ 回填恒执行；指纹/回填
    // 断言由各用例覆盖（改写 mockReturnValueOnce/mock.calls）。
    onRewindDraftFingerprint: vi.fn(() => 'draft-stable'),
    onEntryBackfill: vi.fn(),
  }
  const conn = useChatConnection(status)
  const chat = useChatStore()
  chat.setSelectedContainer('demo')
  chat.setSelectedSession('sk-1')
  return { status, conn, chat }
}

// 首连：openGateway（mock bootstrap token）→ fireReady → onReady 就绪 → syncSessions/loadHistory
// 铺底（空历史）完成。返回当前 gateway。注意必须先 await flushPromises 让 loadHistory 落地——否则其
// 内部 resetForSession 会在测试进行中清空 send() 推入的消息（ChatView.test.ts mountReady 同款）。
async function connect(conn: ReturnType<typeof useChatConnection>): Promise<InstanceType<typeof MockGatewayChat>> {
  const ready = conn.openGateway()
  await flushPromises() // getBootstrapToken → createGatewayChat + start → 挂起等 onReady
  const gw = MockGatewayChat.last!
  gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
  gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
  gw.listCommands.mockResolvedValue([])
  gw.listPendingApprovals.mockResolvedValue([])
  gw.fireReady()
  await ready
  await flushPromises() // syncSessions → listSessions → loadHistory 铺底完成
  return gw
}

// 发送一条用户消息并等 ack 返回 runId（myRunId 就绪）。返回该 runId。
async function sendAndAck(conn: ReturnType<typeof useChatConnection>, chat: ReturnType<typeof useChatStore>, gw: InstanceType<typeof MockGatewayChat>, runId: string): Promise<void> {
  chat.setInput('帮我生成图片')
  gw.send.mockResolvedValue(runId)
  conn.send(false)
  await flushPromises() // gateway.send ack → myRunId = runId
}

// 三组 describe（retry-run handoff / 轮次折叠 #664 T1 / 执行时长 #665 T2）共享的 mock 环境
//（#665 审查 S1：第三份逐字样板收敛）。fake timers（含 Date——墙钟差精确断言依赖）+ 每用例
// 独立 pinia + MockGatewayChat 工厂 + apiFetch/Blob/URL stub。在 describe 内首行调用
//（vitest 钩子注册进当前 suite，同款描述内作用域语义不变）。
function setupConnTestEnv() {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    MockGatewayChat.instances = []
    MockGatewayChat.last = null
    vi.clearAllMocks()
    useAuthStore().$patch({ token: 'jwt-test' })
    ;(getBootstrapToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('boot-1')
    ;(createGatewayChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { handlers: MockHandlers }) => new MockGatewayChat(params.handlers),
    )
    // jsdom 的 Blob 无 stream()，真 Response 构造会抛 object.stream is not a function——
    // mock 成 resolveAttachment 消费的最小形状（resp.ok + resp.blob()）
    ;(apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    })
    const origURL = globalThis.URL
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(origURL), {
        createObjectURL: vi.fn(() => 'blob:mock-media'),
        revokeObjectURL: vi.fn(),
      }),
    )
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
}

describe('useChatConnection retry-run handoff', () => {
  setupConnTestEnv()

  it('A: 正常单 run——ack → delta/media → final 行为不变', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '第一张图片已生成', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-A', media: IMG_MEDIA })
    await flushPromises() // resolveAttachment：files/raw → blob → objectURL
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages.length).toBe(2)
    const last = chat.messages[1]
    expect(last.role).toBe('assistant')
    expect(last.text).toBe('第一张图片已生成')
    expect(last.media.length).toBe(1)
    expect(last.media[0].src).toBe('blob:mock-media')
    expect(last.streaming).toBe(false)
  })

  it('B: 本 run 空 final → retry run 认领，media 进 pipeline，无 foreign 污染', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    // 本 run 空 final（首帧即终态、无内容，runId === myRunId）→ retryPending 开启
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    // gateway 自动重试：新 runId run-B 到达
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: '重试生成的图片', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-B', media: IMG_MEDIA })
    await flushPromises()
    gw.fireFrame({ type: 'done', runId: 'run-B' })
    await flushPromises()

    expect(chat.messages.length).toBe(2)
    const last = chat.messages[1]
    expect(last.text).toBe('重试生成的图片')
    expect(last.media.length).toBe(1)
    expect(last.media[0].src).toBe('blob:mock-media')
    expect(last.streaming).toBe(false)
    expect(status.onError).not.toHaveBeenCalled() // 无失败提示、无 foreign 污染
    // run-B 未被加入 foreignRunIds：后续同 runId 的帧仍正常（已 finalize，此处仅验证未报错）
  })

  it('C: retry run 复用相同 media path——不被旧 run 的 resolvedMediaPaths dedupe 污染', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)

    // run1 正常完成并 resolve 图片路径 X
    await sendAndAck(conn, chat, gw, 'run-1')
    gw.fireFrame({ type: 'text', runId: 'run-1', delta: '第一张', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-1', media: IMG_MEDIA })
    await flushPromises()
    gw.fireFrame({ type: 'done', runId: 'run-1' })
    await flushPromises()
    expect(chat.messages[1].media.length).toBe(1)

    // 第二次请求：本 run 空 final → retry run-3 引用同一图片路径 X
    await sendAndAck(conn, chat, gw, 'run-2')
    gw.fireFrame({ type: 'done', runId: 'run-2' })
    await flushPromises()
    gw.fireFrame({ type: 'text', runId: 'run-3', delta: '第二张', replace: false })
    gw.fireFrame({ type: 'attachment', runId: 'run-3', media: IMG_MEDIA })
    await flushPromises()
    gw.fireFrame({ type: 'done', runId: 'run-3' })
    await flushPromises()

    expect(chat.messages.length).toBe(4)
    const last = chat.messages[3]
    expect(last.text).toBe('第二张')
    expect(last.media.length).toBe(1) // per-runId dedupe：run-3 有自己的 Set，X 不被 run-1 记录跳过
    expect(last.media[0].src).toBe('blob:mock-media')
  })

  it('D: 真 foreign run——pending 正常 active 时陌生 runId 仍被丢弃', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '正常回复', replace: false }) // activeRunId=run-A
    // 突然出现 B（真 foreign，非 retry 条件）——不得污染 A 的占位
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: 'foreign 文本', replace: false })
    await flushPromises()

    expect(chat.messages[1].text).toBe('正常回复') // B 的 delta 未 append
    expect(chat.messages[1].media.length).toBe(0)
  })

  it('E: empty final 无 retry——明确失败提示 + 空白占位删除 + pending 清理', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    // 推进 RETRY_HANDOFF_MS(2000)——无 retry run 到达
    await vi.advanceTimersByTimeAsync(2000)

    expect(status.onError).toHaveBeenCalledWith('消息未生成成功，请稍后重试')
    expect(chat.messages.length).toBe(1) // 空白 assistant 占位被 pop，只剩 user
    expect(chat.messages[0].role).toBe('user')
    // pending 已清理：下一次 send 正常发起（不残留 retryPending）
    await sendAndAck(conn, chat, gw, 'run-B')
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: '重试成功', replace: false })
    await flushPromises()
    const last = chat.messages[chat.messages.length - 1] // 第二次 send 的 assistant 占位（索引非 1）
    expect(last.text).toBe('重试成功')
  })

  it('F: 连续三次请求——run2 空 final→retry handoff 不污染 run1/run3', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)

    // run1 正常
    await sendAndAck(conn, chat, gw, 'run-1')
    gw.fireFrame({ type: 'text', runId: 'run-1', delta: 'r1', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-1' })
    await flushPromises()
    expect(chat.messages[1].text).toBe('r1')

    // run2 空 final → retry handoff（认领 run-2r）
    await sendAndAck(conn, chat, gw, 'run-2')
    gw.fireFrame({ type: 'done', runId: 'run-2' })
    await flushPromises()
    gw.fireFrame({ type: 'text', runId: 'run-2r', delta: 'r2 retry', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-2r' })
    await flushPromises()
    expect(chat.messages[3].text).toBe('r2 retry')

    // run3 正常（状态无污染）
    await sendAndAck(conn, chat, gw, 'run-3')
    gw.fireFrame({ type: 'text', runId: 'run-3', delta: 'r3', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-3' })
    await flushPromises()
    expect(chat.messages[5].text).toBe('r3')
    expect(status.onError).not.toHaveBeenCalled()
  })

  it('G: foreign empty final（runId !== myRunId）不得开启 retry handoff', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    // foreign empty final B（B !== myRunId=A，且 B 从未被认领）——只 armPendingGrace，不开启 retryPending
    gw.fireFrame({ type: 'done', runId: 'run-B' })
    await flushPromises()
    // 后续陌生 run C 到达：若 retryPending 被误开启，C 会被认领；正确实现下 C 应被 foreign 丢弃
    gw.fireFrame({ type: 'text', runId: 'run-C', delta: '不应被认领', replace: false })
    await flushPromises()

    expect(chat.messages[1].text).toBe('') // 占位仍空：C 的 delta 被丢弃，未污染占位
    expect(chat.messages[1].media.length).toBe(0)
    // 本 run 自身的首帧（runId === myRunId）仍可正常认领（B3 语义未破坏）
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '本 run 首帧', replace: false })
    await flushPromises()
    expect(chat.messages[1].text).toBe('本 run 首帧')
  })
})

// T1 轮次折叠（#664）——行为接缝：直实例化 composable + mock 网关驱动帧（贴 retry-run handoff 先例）。
// 覆盖：done 自动折叠（有轨迹）/ error·断线·8s 宽限三路收尾不折叠 / 手动开合 mutation +
// 自动折叠一次性（done 后手动展开不再被自动收起）。只测外部行为（store 投影），不测闭包内部态。
describe('useChatConnection 轮次折叠（#664 T1）', () => {
  setupConnTestEnv()

  // 发送并流式注入一轮带轨迹的内容（replace 快照带结构化思考 + 一条工具行），不发 done
  async function sendAndStreamTrace(
    conn: ReturnType<typeof useChatConnection>,
    chat: ReturnType<typeof useChatStore>,
    gw: InstanceType<typeof MockGatewayChat>,
    runId: string,
  ): Promise<void> {
    await sendAndAck(conn, chat, gw, runId)
    gw.fireFrame({ type: 'text', runId, delta: '中间思考与正文', replace: true, thinking: '思考内容' })
    gw.fireFrame({ type: 'tool', runId, name: 'exec', state: 'done', id: 't1', title: null, input: 'ls', result: '' })
  }

  it('done 帧到达后有轨迹 → 最后一条 assistant 消息折叠态置 true；正文与附件数据不变', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')
    expect(chat.messages[1].traceFolded).toBeFalsy() // 流式中未折叠

    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBe(true) // done 独占折叠信号
    expect(chat.messages[1].text).toBe('中间思考与正文') // 正文数据不变
    expect(chat.messages[1].thinking).toBe('思考内容') // 思考数据不变
    expect(chat.messages[1].tools).toHaveLength(1) // 工具行数据不变
  })

  it('done 帧到达后无轨迹（纯文本回复）→ 不置折叠态', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '纯文本回复', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 无轨迹：无折叠条可言
  })

  it('error 帧收尾（有轨迹）→ 不折叠（保持展开）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'error', runId: 'run-A', message: 'run 失败' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 异常收尾保持展开
  })

  it('断线 onClose 收尾（有轨迹）→ 不折叠（保持展开）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')

    gw.fireClose(1006) // 意外断线（非授权门）
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 断线收尾保持展开
  })

  it('8s 宽限收尾 → 不折叠（外来 done-first 落定占位走共享收尾）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    // 外来 done-first（runId !== myRunId）→ 只武装 8s 宽限
    gw.fireFrame({ type: 'done', runId: 'run-foreign' })
    await flushPromises()
    expect(chat.messages[1].streaming).toBe(true) // 宽限内占位仍在
    await vi.advanceTimersByTimeAsync(8000) // 宽限 fire：finalizeLast 落定占位

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].traceFolded).toBeFalsy() // 宽限收尾（共享 finalize 路）不置折叠态
  })

  it('手动开合 mutation 生效；done 后手动展开不再被自动收起（自动折叠一次性）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndStreamTrace(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    expect(chat.messages[1].traceFolded).toBe(true)

    chat.toggleTraceFold(chat.messages[1]) // 手动展开
    expect(chat.messages[1].traceFolded).toBe(false)
    // 推进时钟 + 后续迟到帧（同一 runId 的 done 不会二次到达；此处防任何延迟自动收起）
    await vi.advanceTimersByTimeAsync(10000)
    expect(chat.messages[1].traceFolded).toBe(false) // 手动展开不被自动覆盖

    chat.toggleTraceFold(chat.messages[1]) // 再手动收起（可再收起）
    expect(chat.messages[1].traceFolded).toBe(true)
  })
})

// T2 执行时长（#665）——行为接缝：直实例化 composable + mock 网关驱动帧 + fake timers（同上两先例）。
// 覆盖：send 起算墙钟、done 落定精确时长（fake Date 差值）、error 收尾不落定、retry-run handoff
// 与原请求同轮连续计时（不重置）、断线 resume 续帧含中断间隔（墙钟连续）、离线重发路径同样起算。
// 只测外部行为（store 投影 turnDurationMs），不测闭包内部态。
describe('useChatConnection 执行时长（#665 T2）', () => {
  setupConnTestEnv()

  it('send 后推进 T 毫秒到 done → 落定 turnDurationMs 精确等于 T（折叠信号不变）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '流式正文', replace: true, thinking: '思考' })
    gw.fireFrame({ type: 'tool', runId: 'run-A', name: 'exec', state: 'done', id: 't1', title: null, input: 'ls', result: '' })
    await vi.advanceTimersByTimeAsync(42_000) // fake Date 同步推进：执行 42s 后 done
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].turnDurationMs).toBe(42_000) // 墙钟差精确 = T
    expect(chat.messages[1].traceFolded).toBe(true) // 折叠信号（#664）不变
  })

  it('error 收尾 → 不落定时长（异常轮无「已执行」可言）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '正文', replace: false })
    await vi.advanceTimersByTimeAsync(5_000)
    gw.fireFrame({ type: 'error', runId: 'run-A', message: 'run 失败' })
    await flushPromises()

    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].turnDurationMs).toBeUndefined() // 时长信号独占 done（同折叠信号）
  })

  it('空 final → retry-run handoff 认领的重试 run 的 done 落定时长从原 send 起算（计时不重置）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A') // 原请求 send（计时起点）

    // 本 run 空 final（retryPending 开启）——不落定不清起点
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(500) // t+500ms：gateway 自动重试的新 runId 到达
    gw.fireFrame({ type: 'text', runId: 'run-B', delta: '重试正文', replace: false })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(41_500) // t+42s：retry run done
    gw.fireFrame({ type: 'done', runId: 'run-B' })
    await flushPromises()

    expect(chat.messages[1].text).toBe('重试正文')
    expect(chat.messages[1].turnDurationMs).toBe(42_000) // 含空 final 后的 handoff 间隙（同一轮连续计时）
  })

  it('断线 resume 续帧后 done → 时长含中断间隔（墙钟连续）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '前半', replace: false })
    await flushPromises()
    gw.fireClose(1006) // 意外断线：finalizeLast + 记 resumeRun（不动计时起点）
    await flushPromises()

    await vi.advanceTimersByTimeAsync(30_000) // 30s 中断间隔
    // 协议机自动重连（B5）：同一 GatewayChat 实例的 onReady 再次触发——everConnected 已 true 且
    // resumeRun 在案 → 保留占位 armResumeWait 等续帧（手动 openGateway 是新连接新 run 语境，
    // 会清 resumeRun 走 loadHistory，非本用例模拟的路径）
    gw.fireReady()
    await flushPromises()

    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '后半', replace: false }) // resume 续帧复活占位
    await flushPromises()
    await vi.advanceTimersByTimeAsync(12_000)
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()

    expect(chat.messages[1].text).toBe('前半后半') // 续帧照常追加（B5 语义不变）
    expect(chat.messages[1].turnDurationMs).toBe(42_000) // 含 30s 中断：send→done 墙钟
  })

  it('离线重发（outbox resendOutbox）路径同样起算计时', async () => {
    // 预置 outbox 残留（「已点发送但网关没回执」的刷新场景）——首连 syncSessions 铺底后自动重发
    sessionStorage.setItem(
      'openclaw.panel.outbox.v1:demo',
      JSON.stringify({
        version: 1,
        sessions: { 'sk-1': [{ id: 'oid-1', text: '离线期间的消息', createdAt: Date.now() }] },
      }),
    )
    const { conn, chat } = setup()
    // 不用 connect() helper：resendOutbox 在 onReady 链内同步触发，gateway.send 的 mock（ack 返
    // runId）须在 fireReady 前就位，否则重发的 fire-and-forget .then 打在 undefined 上
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.send.mockResolvedValue('run-resend') // 重发 ack
    gw.fireReady()
    await ready
    await flushPromises() // syncSessions → loadHistory（空历史）→ resendOutbox（乐观 echo）

    expect(chat.messages[0].text).toBe('离线期间的消息') // user echo
    expect(chat.messages[1].role).toBe('assistant') // 占位
    await vi.advanceTimersByTimeAsync(7_000) // 重发后执行 7s 到 done
    gw.fireFrame({ type: 'text', runId: 'run-resend', delta: '重发的回复', replace: false })
    gw.fireFrame({ type: 'done', runId: 'run-resend' })
    await flushPromises()

    expect(chat.messages[1].turnDurationMs).toBe(7_000) // 重发路径同款 send 起算
  })
})

// T3 历史轮默认折叠（#666）——行为接缝：直实例化 composable + mock 网关驱动帧（贴上三例）。
// 覆盖：历史翻译（loadHistory）有轨迹 assistant → 默认折叠、时长为空；无轨迹不置折叠态；
// 外来可见 final 局部插入（done 帧携带消息本体）同构默认折叠；切会话离开再回来（重新翻译）
// 恢复默认折叠。只测外部行为（store 投影 traceFolded/turnDurationMs），不测闭包内部态。
describe('useChatConnection 历史轮默认折叠（#666 T3）', () => {
  setupConnTestEnv()

  // 历史消息夹具：对齐网关 history DTO content 多态（user=string / assistant=content[]，
  // ADR 0003）——translateHistoryMessage 的输入形状。含：思考+工具轨迹 / 纯工具轨迹 /
  // 无轨迹纯文本 assistant / user 消息。
  const HISTORY = [
    { role: 'user', content: '问题一' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '历史思考' },
        { type: 'text', text: '历史正文' },
        { type: 'toolCall', toolCallId: 'tc1', name: 'exec', arguments: { command: 'ls' } },
        { type: 'toolCall', toolCallId: 'tc2', name: 'read', arguments: { file_path: '/a.ts' } },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', toolCallId: 'tc3', name: 'exec', arguments: { command: 'pwd' } }],
    },
    { role: 'assistant', content: [{ type: 'text', text: '纯文本回复' }] },
  ]

  // 首连接入带历史的会话（connect() helper 的空历史换成本组夹具；sk-1 为选中会话）
  async function connectWithHistory(
    conn: ReturnType<typeof useChatConnection>,
    history: unknown[] = HISTORY,
  ): Promise<InstanceType<typeof MockGatewayChat>> {
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: history, hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises() // syncSessions → loadHistory 铺底完成
    return gw
  }

  it('历史翻译：含 thinking/toolCall 块的 assistant 消息 → 折叠态默认已折叠、时长数据为空', async () => {
    const { conn, chat } = setup()
    await connectWithHistory(conn)

    const traced = chat.messages[1]
    expect(traced.traceFolded).toBe(true) // 思考+工具轨迹 → 默认折叠
    expect(traced.turnDurationMs).toBeUndefined() // 历史轮无时长数据（条面回退计数文案）
    expect(traced.text).toBe('历史正文') // 正文数据不变
    expect(traced.thinking).toBe('历史思考') // 思考数据不变
    expect(traced.tools).toHaveLength(2) // 工具行数据不变
    expect(chat.messages[2].traceFolded).toBe(true) // 纯工具轨迹同样默认折叠
  })

  it('历史翻译：无轨迹的历史 assistant 消息不置折叠态（渲染层不渲染折叠条）', async () => {
    const { conn, chat } = setup()
    await connectWithHistory(conn)

    expect(chat.messages[3].text).toBe('纯文本回复')
    expect(chat.messages[3].traceFolded).toBeFalsy() // 无轨迹：无折叠条可言
    expect(chat.messages[0].traceFolded).toBeFalsy() // user 消息恒不折叠
  })

  it('外来可见 final 局部插入（done 帧携带消息本体）的有轨迹消息同构默认折叠', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    // 空闲期外来 run 首帧 → foreignRunIds 记录（贴 #569 用例形态）
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    await flushPromises()
    gw.fireFrame({
      type: 'done',
      runId: 'foreign-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '外来思考' },
          { type: 'text', text: '外来正文' },
          { type: 'toolCall', toolCallId: 'tc1', name: 'exec', arguments: {} },
        ],
      },
    })
    await flushPromises()

    expect(chat.messages).toHaveLength(1) // 局部插入一条（非整段重拉，#569 语义不变）
    expect(chat.messages[0].text).toBe('外来正文')
    expect(chat.messages[0].traceFolded).toBe(true) // 与历史消息同构转换 → 同样默认折叠
    expect(chat.messages[0].turnDurationMs).toBeUndefined() // 外来插入无计时起点 → 无时长
  })

  it('切会话离开再回来（历史重新翻译）→ 恢复默认折叠（手动展开随投影重建被覆盖）', async () => {
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-1', title: '', updated_at: '' },
      { session_key: 'sk-2', title: '', updated_at: '' },
    ])
    gw.getHistory.mockImplementation((key: string) =>
      Promise.resolve(
        key === 'sk-1'
          ? { messages: HISTORY, hasMore: false, nextOffset: null }
          : { messages: [], hasMore: false, nextOffset: null },
      ),
    )
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()

    expect(chat.selectedSession).toBe('sk-1')
    expect(chat.messages[1].traceFolded).toBe(true) // 首次铺底：默认折叠
    chat.toggleTraceFold(chat.messages[1]) // 手动展开
    expect(chat.messages[1].traceFolded).toBe(false)

    conn.pickSession('sk-2')
    await flushPromises()
    expect(chat.messages).toHaveLength(0) // sk-2 空历史
    conn.pickSession('sk-1') // 切回：loadHistory 重新翻译（投影重建）
    await flushPromises()

    expect(chat.messages[1].traceFolded).toBe(true) // 恢复默认折叠（无需额外持久化）
    expect(chat.messages[1].turnDurationMs).toBeUndefined()
  })
})

// issue #535：历史会话内容被吞——进入会话只拉首 50 条，翻到顶部即截断，最早的消息不可见。
// 期望：进入会话自动把整个 session 历史拉全（循环分页直到 hasMore=false），不留隐藏历史。
describe('历史拉全（issue #535）', () => {
  setupConnTestEnv()

  it('进入会话自动拉全整个 session 历史（非首 50 条截断）', async () => {
    const TOTAL = 130
    // 最旧在前（旧→新，同网关 history 排序）；text 兼作分页锚点 id
    const all = Array.from({ length: TOTAL }, (_, i) => ({
      role: 'user',
      text: `msg-${String(i).padStart(3, '0')}`,
    }))
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    // mock 网关 chat.history 分页协议（对齐 loadHistory/loadMoreHistory 现契约）：
    // 无锚点 → 最新 limit 条（loadHistory 传 50）；带锚点 → 锚点之前更旧一页；页内旧→新。
    // 分页请求现不带 limit → 网关默认页大小 50。
    gw.getHistory.mockImplementation((key: string, limit?: number, messageId?: string) => {
      expect(key).toBe('sk-1')
      const idx = messageId !== undefined ? all.findIndex((m) => m.text === messageId) : all.length
      const n = limit ?? 50
      const start = Math.max(0, idx - n)
      return Promise.resolve({
        messages: all.slice(start, idx),
        hasMore: start > 0,
        nextOffset: start > 0 ? all[start]!.text : null,
      })
    })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises() // syncSessions → loadHistory（应拉全 130 条）

    expect(chat.messages).toHaveLength(TOTAL) // 整个 session 拉全，非首 50 条截断
    expect(chat.messages[0]!.text).toBe('msg-000') // 最旧一条在顶
    expect(chat.historyHasMore).toBe(false) // 无隐藏历史 → 顶部「加载更多」不出现
  })

  // Codex PR #678 P1：网关 chat.history 把数值 offset 与字符串 messageId 当两个独立参数
  //（docs.openclaw.ai/gateway/protocol）。nextOffset 为 number 时须原样以 number 续传（getHistory
  // 内部映射为 offset）；String() 化会走错协议字段（messageId），offset 分页会话第二页起拉错/拉不到。
  it('numeric nextOffset 以 number 类型续传（不被 stringify 成 messageId）', async () => {
    const TOTAL = 130
    const all = Array.from({ length: TOTAL }, (_, i) => ({ role: 'user', text: `msg-${i}` }))
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    // mock 网关为「只认数值 offset」的偏移分页：第三参数是 number 才当偏移；被 String() 化的
    // string 按协议不识别 → 当作无锚点返回最新页。调用上限兜底防修复前死循环。
    let calls = 0
    gw.getHistory.mockImplementation((key: string, limit?: number, cursor?: string | number) => {
      expect(key).toBe('sk-1')
      calls++
      if (calls > 20) return Promise.resolve({ messages: [], hasMore: false, nextOffset: null })
      const n = limit ?? 50
      const idx = typeof cursor === 'number' ? cursor : all.length
      const start = Math.max(0, idx - n)
      return Promise.resolve({
        messages: all.slice(start, idx),
        hasMore: start > 0,
        nextOffset: start > 0 ? start : null, // number offset
      })
    })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()

    expect(chat.messages).toHaveLength(TOTAL) // number offset 正确续传 → 拉全整个 session
    expect(chat.messages[0]!.text).toBe('msg-0')
    expect(chat.historyHasMore).toBe(false)
  })

  // Codex PR #678 P2：异常网关忽略 cursor、反复回同一页且 hasMore:true（如不认该锚点）——
  // 无前进守卫会死循环、内存重复追加、永不释放 loading。检测 cursor 不前进即停。
  it('cursor 不前进（hasMore:true 但 nextOffset 重复）时终止分页并释放 loading', async () => {
    const page = [{ role: 'user', text: 'm' }]
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    let calls = 0
    gw.getHistory.mockImplementation(() => {
      calls++
      if (calls > 5) return Promise.resolve({ messages: [], hasMore: false, nextOffset: null }) // 兜底防红死循环
      return Promise.resolve({ messages: page, hasMore: true, nextOffset: 'X' }) // 同一锚点重复返回
    })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()

    // 首页 + 发现锚点不前进即停 = 2 次；修复前会一直请求直到兜底（6 次）
    expect(gw.getHistory.mock.calls.length).toBe(2)
    expect(chat.historyLoading).toBe(false) // loading 释放（不死等）
  })

  // Codex PR #678 P2：syncSessions 原先 await 整个 loadHistory 循环后才 restorePendingApprovals——
  // 长 transcript 下离线期间的审批请求被卡住（330s stuck-session abort 窗口被耗尽，run 被 abort
  // 才轮到卡片）。修复后审批补拉与全量历史下载并行启动。
  it('恢复路径：审批补拉不被长历史拉取阻塞', async () => {
    const { conn } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    // loadHistory 挂起（模拟长历史/慢网关）：getHistory 返回手动控制 resolve 的 promise。
    // resolve 存对象属性——局部变量在闭包内赋值会被 TS 控制流 narrow 成 never（TS2349），属性访问不会。
    const deferred: { resolve?: (v: { messages: never[]; hasMore: boolean; nextOffset: null }) => void } = {}
    gw.getHistory.mockImplementation(
      () => new Promise((r) => { deferred.resolve = r }),
    )
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await flushPromises() // 推进到 loadHistory 首次 getHistory 挂起点

    expect(gw.listPendingApprovals).toHaveBeenCalled() // 审批补拉已启动，不等历史拉完
    deferred.resolve?.({ messages: [], hasMore: false, nextOffset: null }) // 放行历史，防悬挂
    await ready
    await flushPromises()
  })
})

// #694 对话回退的入口前置：transcript entryId 提取（#693 spec §1.2）。
// 网关 chat.history 每条消息带 __openclaw 元数据（官方 Control UI 取 __openclaw.id 作 data-entry-id）；
// 面板单点 choke point = translateHistoryMessage——三条历史路径（loadHistory / loadMoreHistory /
// 外来 final 局部插入）自动全覆盖。无 entryId 的消息不显示任何消息级操作入口（回退/fork）。
describe('#694 transcript entryId 提取', () => {
  setupConnTestEnv()

  const withEntry = (text: string, id: unknown) => ({ role: 'user', text, __openclaw: { id } })

  it('历史消息保留网关条目 id（__openclaw.id）；缺字段/非 string → undefined（0 信任）', async () => {
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({
      messages: [
        withEntry('有 id 的用户消息', 'entry-1'),
        { role: 'assistant', text: '回复', __openclaw: { id: 'entry-2' } },
        { role: 'user', text: '无 __openclaw' },
        withEntry('id 非 string', 42),
        { role: 'user', text: '空 id', __openclaw: { id: '' } },
      ],
      hasMore: false,
      nextOffset: null,
    })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()

    expect(chat.messages.map((m) => m.entryId)).toEqual(['entry-1', 'entry-2', undefined, undefined, undefined])
  })

  it('分页（loadMoreHistory）拉回的更旧页同样带 entryId', async () => {
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValueOnce({
      messages: [withEntry('新页消息', 'entry-new')],
      hasMore: true,
      nextOffset: 'entry-new',
    })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()

    gw.getHistory.mockResolvedValueOnce({
      messages: [withEntry('更旧页消息', 'entry-old')],
      hasMore: false,
      nextOffset: null,
    })
    await conn.loadMoreHistory()

    expect(chat.messages.map((m) => m.entryId)).toEqual(['entry-old', 'entry-new'])
  })

  it('外来 run 可见 final 局部插入（#569 路径）与历史同构带 entryId', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    // 空闲期外来 run 首帧（记入 foreignRunIds）→ 该 run 的 done 携带权威 message → 局部插入
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    gw.fireFrame({
      type: 'done',
      runId: 'foreign-1',
      message: { role: 'assistant', content: [{ type: 'text', text: '外来回复' }], __openclaw: { id: 'entry-f' } },
    })
    await flushPromises()

    const inserted = chat.messages.find((m) => m.text === '外来回复')
    expect(inserted?.entryId).toBe('entry-f')
  })

  // #703 P1：本地乐观 echo 的 user 消息没有 entryId（网关只在 chat.history 里给条目身份）——
  // 「刚发出的那条」在切会话/重连前点不了回退，恰是回退的主用例。ack = 已落库，此刻回读最新
  // 一页历史，按持久化幂等键（`<clientRunId>:user`）把条目 id 补回本地消息。
  it('ack 后回读最新一页历史：按 `<runId>:user` 命中 → 条目 id 补回本地乐观 user 消息', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    // 照实模拟真网关：ack 的 runId 就是客户端外注的幂等键（openclaw dist `clientRunId = p.idempotencyKey`），
    // 落库用户条目的 __openclaw.idempotencyKey = `${clientRunId}:user`——本用例按同一关系造历史。
    // 故此处不走 sendAndAck（它把 ack 固定成 'run-A'，会覆盖掉这条模拟）。
    gw.send.mockImplementation((_s: string, _t: string, _a: unknown, key: string) => Promise.resolve(key))
    gw.getHistory.mockImplementation(async () => {
      const sendKey = gw.send.mock.calls.at(-1)?.[3] as string
      return {
        messages: [
          { role: 'user', text: '帮我生成图片', __openclaw: { id: 'entry-p1', idempotencyKey: `${sendKey}:user` } },
          { role: 'assistant', text: '', __openclaw: { id: 'entry-p2' } },
        ],
        hasMore: false,
        nextOffset: null,
      }
    })

    chat.setInput('帮我生成图片')
    conn.send(false)
    await flushPromises() // ack（返回发送键）→ 回读

    const read = gw.getHistory.mock.calls.at(-1)!
    expect(read[0]).toBe('sk-1')
    expect(read[1]).toBeGreaterThan(0) // 拉一页
    expect(read[2]).toBeUndefined() // 不传锚点 = 最新一页（刚落库的条目就在这里）
    expect(chat.messages[0].sendKey).toBe(gw.send.mock.calls[0][3]) // 发送键随乐观 echo 落位
    expect(chat.messages[0].entryId).toBe('entry-p1') // 刚从「不可回退」变为可回退
  })

  it('回读未命中（键不匹配）→ entryId 保持缺省（fail-closed，入口不渲染，等下次历史加载）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    gw.getHistory.mockResolvedValue({
      messages: [{ role: 'user', text: '别的轮次', __openclaw: { id: 'entry-x', idempotencyKey: 'run-other:user' } }],
      hasMore: false,
      nextOffset: null,
    })

    await sendAndAck(conn, chat, gw, 'run-A')
    await flushPromises()

    expect(chat.messages[0].entryId).toBeUndefined()
  })

  it('回读失败（网关报错）→ 静默降级：不报错、不改 transcript', async () => {
    const { conn, chat, status } = setup()
    const gw = await connect(conn)
    gw.getHistory.mockRejectedValue(new Error('history unavailable'))

    await sendAndAck(conn, chat, gw, 'run-A')
    await flushPromises()

    expect(chat.messages[0].entryId).toBeUndefined()
    expect(status.onError).not.toHaveBeenCalled()
    expect(status.onActionError).not.toHaveBeenCalled() // 回读失败静默降级：动作类通道也不打扰
  })

  it('回读前已切会话 → 连回读 RPC 都不发（结果无处可用；切回来时由历史加载自然补上）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    let resolveSend: ((v: string) => void) | undefined
    gw.send.mockImplementation(() => new Promise((r) => { resolveSend = r }))
    chat.setInput('帮我生成图片')
    conn.send(false)
    await flushPromises()

    chat.setSelectedSession('sk-2') // ack 未回就切走
    resolveSend?.('run-A')
    await flushPromises()

    expect(gw.getHistory).toHaveBeenCalledTimes(1) // 仅首连铺底那次；切走后不回读
  })

  it('回读期间切会话 → 迟到回读结果作废（不跨会话写 entryId）', async () => {
    const { conn, chat } = setup()
    const gw = await connect(conn)
    let resolveSend: ((v: string) => void) | undefined
    let resolveHistory: ((v: unknown) => void) | undefined
    gw.send.mockImplementation(() => new Promise((r) => { resolveSend = r }))
    gw.getHistory.mockImplementationOnce(() => new Promise((r) => { resolveHistory = r })) // 回读挂起
    chat.setInput('帮我生成图片')
    conn.send(false)
    await flushPromises()
    resolveSend?.('run-A')
    await flushPromises() // 回读已发出、响应未回
    const sendKey = gw.send.mock.calls[0][3] as string

    chat.setSelectedSession('sk-2') // 回读期间切走
    resolveHistory?.({
      messages: [{ role: 'user', text: '帮我生成图片', __openclaw: { id: 'entry-p1', idempotencyKey: `${sendKey}:user` } }],
      hasMore: false,
      nextOffset: null,
    })
    await flushPromises()

    expect(chat.messages.some((m) => m.entryId === 'entry-p1')).toBe(false)
  })
})

// #694 对话回退编排（#693 spec §1.4）：rewind RPC → 放弃在途 run → 全量重拉历史重建 transcript
// → 草稿指纹守卫 → 回填 composer。失败/断线不改 transcript。
describe('#694 对话回退编排', () => {
  setupConnTestEnv()

  const HISTORY = [
    { role: 'user', text: '第一问', __openclaw: { id: 'entry-1' } },
    { role: 'assistant', text: '第一答', __openclaw: { id: 'entry-2' } },
    { role: 'user', text: '第二问', __openclaw: { id: 'entry-3' } },
    { role: 'assistant', text: '第二答', __openclaw: { id: 'entry-4' } },
  ]

  // 首连铺底完整历史；返回网关替身（后续按需改写 getHistory 的后续应答）。
  async function connectWithHistory(conn: ReturnType<typeof useChatConnection>): Promise<InstanceType<typeof MockGatewayChat>> {
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: HISTORY, hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()
    return gw
  }

  it('回退成功：RPC 参数 → 全量重拉历史重建 transcript → 被剪消息文本与图片附件回填 composer', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    expect(chat.messages).toHaveLength(4) // 铺底：4 条历史
    chat.setHistoryState(true, 'anchor-x', false) // 假装还有更旧页（验证重建后分页态被重置）

    // 回退到「第一问」之前：网关侧只留前缀（本用例留空 transcript 语义不必要，留 entry-1 前的空集）
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.rewind.mockResolvedValue({
      editorText: '第一问',
      editorAttachments: [{ mimeType: 'image/png', data: 'AAAA' }],
    })

    await conn.rewind('entry-1')

    expect(gw.rewind).toHaveBeenCalledWith('sk-1', 'entry-1')
    expect(gw.getHistory).toHaveBeenCalledTimes(2) // 首连 1 次 + 回退后全量重拉 1 次
    expect(chat.messages).toHaveLength(0) // transcript 重建为新活跃路径（被剪历史消失）
    expect(chat.historyHasMore).toBe(false) // 分页态随重建重置（非旧 transcript 的残留锚点）
    expect(chat.historyAnchor).toBeNull()
    expect(status.onEntryBackfill).toHaveBeenCalledWith('第一问', [
      // #703 P2：回填附件带解码后字节数（缺 sizeBytes 时下游退化为按 base64 字符数计费 → 误判超限）
      { type: 'image', mimeType: 'image/png', content: 'AAAA', sizeBytes: 3 },
    ])
  })

  it('无被剪内容（editorText 空 + 无附件）→ 仍按空结果回填（composer 清空语义与官方一致）', async () => {
    const { conn, status } = setup()
    const gw = await connectWithHistory(conn)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.rewind.mockResolvedValue({ editorText: '', editorAttachments: [] })

    await conn.rewind('entry-1')

    expect(status.onEntryBackfill).toHaveBeenCalledWith('', [])
  })

  it('重建期间在途 run 被放弃：其迟到帧不得写入已重建的 transcript', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    // 在途 run（正常 UI 下入口被 busy 门隐藏；此处直调编排验证放弃语义——pickSession 先例）
    await sendAndAck(conn, chat, gw, 'run-A')
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '正在回答' })
    await flushPromises()
    const before = chat.messages.length

    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.rewind.mockResolvedValue({ editorText: '第一问', editorAttachments: [] })
    await conn.rewind('entry-1')

    expect(chat.messages).toHaveLength(0) // 重建后为空活跃路径
    gw.fireFrame({ type: 'text', runId: 'run-A', delta: '迟到增量' })
    gw.fireFrame({ type: 'done', runId: 'run-A' })
    await flushPromises()
    expect(chat.messages).toHaveLength(0) // 迟到帧被 abandonedRunIds 丢弃，不重建出幽灵消息
    expect(before).toBeGreaterThan(0) // 前置条件：回退前确有在途消息
  })

  it('草稿指纹守卫：RPC 期间用户改了草稿 → 跳过回填（新草稿原地保留），transcript 照常回退', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    vi.mocked(status.onRewindDraftFingerprint!).mockReturnValueOnce('draft-A').mockReturnValueOnce('draft-B') // RPC 前后草稿变了
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.rewind.mockResolvedValue({ editorText: '第一问', editorAttachments: [] })

    await conn.rewind('entry-1')

    expect(status.onEntryBackfill).not.toHaveBeenCalled() // 不覆盖用户新草稿
    expect(chat.messages).toHaveLength(0) // transcript 回退不受守卫影响
  })

  it('回退失败：明确错误提示（动作类通道），transcript 不动（不重拉、不重建）', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    gw.rewind.mockRejectedValue(new Error('message entry is not on the active path: entry-1'))

    await conn.rewind('entry-1')

    // 动作类失败走 onActionError（宿主做瞬时提示）——不进连接横幅，避免「加载失败 + 回退失败」错配
    expect(status.onActionError).toHaveBeenCalledWith('回退失败：message entry is not on the active path: entry-1')
    expect(status.onError).not.toHaveBeenCalled()
    expect(gw.getHistory).toHaveBeenCalledTimes(1) // 只有首连那次
    expect(chat.messages).toHaveLength(4) // 原 transcript 原样
    expect(status.onEntryBackfill).not.toHaveBeenCalled()
  })

  it('宿主未注入动作类通道 → 回退失败回到 onError（任何宿主下都不静默丢错误）', async () => {
    const { conn, status } = setup({ withoutActionError: true })
    const gw = await connectWithHistory(conn)
    gw.rewind.mockRejectedValue(new Error('boom'))

    await conn.rewind('entry-1')

    expect(status.onError).toHaveBeenCalledWith('回退失败：boom')
  })

  it('前置守卫：断线 / 无 entryId / 无会话 → 不发起 RPC（不产生必然失败的请求）', async () => {
    const { conn, status } = setup()
    const gw = await connectWithHistory(conn)

    await conn.rewind('') // 无 entryId
    gw.fireClose(1006) // 断线
    await flushPromises()
    await conn.rewind('entry-1')

    expect(gw.rewind).not.toHaveBeenCalled()
    expect(status.onEntryBackfill).not.toHaveBeenCalled()
  })

  it('在途回退单飞：窗口期内再触发（同条目 / 另一条目）一律忽略，落地后解锁', async () => {
    const { conn, status } = setup()
    const gw = await connectWithHistory(conn)
    const resolvers: Array<(v: { editorText: string; editorAttachments: never[] }) => void> = []
    gw.rewind.mockImplementation(() => new Promise((r) => { resolvers.push(r) }))
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    const fill = { editorText: '第一问', editorAttachments: [] as never[] }

    const first = conn.rewind('entry-1')
    const dup = conn.rewind('entry-1') // 同条目：在途
    // #703 P2：另一条目同样忽略——两次在途回退会在网关侧竞争同一活跃路径（乐观并发冲突），
    // 面板侧两次重建 + 两次回填的落地序又由网络决定（可能回填的不是最后一次意图），
    // 且任一 finally 都会清掉共享标记让锁形同虚设。破坏性 RPC + 重建管线 = 单飞。
    const other = conn.rewind('entry-3')
    await flushPromises()
    expect(gw.rewind).toHaveBeenCalledTimes(1)
    expect(gw.rewind).toHaveBeenCalledWith('sk-1', 'entry-1')

    for (const r of resolvers) r(fill)
    await Promise.all([first, dup, other])
    expect(status.onError).not.toHaveBeenCalled()
    expect(status.onActionError).not.toHaveBeenCalled() // 被吞的重复触发不得冒出「假失败」提示

    // 落地即解锁：后续意图照常发起（锁不吞掉窗口期之后的新回退）
    gw.rewind.mockResolvedValue(fill)
    await conn.rewind('entry-3')
    expect(gw.rewind).toHaveBeenCalledTimes(2)
    expect(gw.rewind).toHaveBeenLastCalledWith('sk-1', 'entry-3')
  })

  it('回退后分页态安全：旧 transcript 的在途分页响应不污染新 transcript', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    chat.setHistoryState(true, 'older', false) // 旧 transcript 仍有更旧页
    // 在途分页响应挂起（模拟慢网关：回退重建先落地，旧分页后到）
    const deferred: { resolve?: (v: { messages: unknown[]; hasMore: boolean; nextOffset: string }) => void } = {}
    gw.getHistory.mockImplementationOnce(() => new Promise((r) => { deferred.resolve = r }))
    const paging = conn.loadMoreHistory()

    // 回退触发全量重建（getHistory 的后续应答 = 新活跃路径）
    gw.getHistory.mockResolvedValue({ messages: [HISTORY[0]], hasMore: false, nextOffset: null })
    gw.rewind.mockResolvedValue({ editorText: '第二问', editorAttachments: [] })
    await conn.rewind('entry-3')
    expect(chat.messages.map((m) => m.text)).toEqual(['第一问'])

    // 旧分页响应此刻才到（historyGen 已被重建取代）→ 丢弃，不得 prepend 进新 transcript
    deferred.resolve?.({ messages: [{ role: 'user', text: '更旧消息' }], hasMore: true, nextOffset: 'older-2' })
    await paging
    await flushPromises()

    expect(chat.messages.map((m) => m.text)).toEqual(['第一问'])
    expect(chat.historyHasMore).toBe(false) // 分页态仍是新 transcript 的（未被旧响应覆写）
  })

  // ---- Codex #703 review 修复的回归 ----

  it('回退重建期间切容器（两容器同名会话）→ 旧容器的回退结果不写进新容器草稿（containerGen 守卫）', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    // 重建的历史请求挂起 → 期间切容器。loadHistory 自己在 await 后比对 containerGen 并丢弃迟到响应，
    // 但**回退续体**若只看 sessionKey（两容器常有同名 main 会话）就会放行旧容器的回退结果 → 写进
    // 新容器的 composer（随后发错容器）。
    const deferred: { resolve?: (v: { messages: unknown[]; hasMore: boolean; nextOffset: null }) => void } = {}
    gw.getHistory.mockImplementationOnce(() => new Promise((r) => { deferred.resolve = r }))
    gw.rewind.mockResolvedValue({ editorText: '旧容器的第一问', editorAttachments: [] })
    const pending = conn.rewind('entry-1')
    await flushPromises() // RPC 已回 → 进入重建管线，历史请求在途

    const switching = conn.selectContainer('demo2')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw)
    gw2.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.listPendingApprovals.mockResolvedValue([])
    gw2.fireReady()
    await switching
    await flushPromises()
    expect(chat.selectedSession).toBe('sk-1') // 前置：新容器同名会话——守卫的判别力就在此处

    deferred.resolve?.({ messages: [], hasMore: false, nextOffset: null }) // 旧连接的重建响应迟到
    await pending
    await flushPromises()

    expect(status.onEntryBackfill).not.toHaveBeenCalled() // 旧容器回退结果不得落进新容器 composer
    expect(status.onError).not.toHaveBeenCalled()
    expect(status.onActionError).not.toHaveBeenCalled() // 陈旧回退不得弹「假失败」（动作类通道）
  })

  it('回退重建不清文件 tab（同会话内的 transcript 重建，用户没离开会话）', async () => {
    const { conn } = setup()
    const gw = await connectWithHistory(conn)
    const ft = useFileTabsStore()
    ft.tabs.push({ path: 'notes/a.md', state: 'loaded', content: 'x', lineMarks: [], binary: false, oversized: false })
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.rewind.mockResolvedValue({ editorText: '第一问', editorAttachments: [] })

    await conn.rewind('entry-1')

    expect(ft.tabs.map((t) => t.path)).toEqual(['notes/a.md']) // 回退不动文件面板
  })

  it('切会话仍清文件 tab（放宽只针对回退，不放宽会话切换）', async () => {
    const { conn } = setup()
    await connectWithHistory(conn)
    const ft = useFileTabsStore()
    ft.tabs.push({ path: 'notes/a.md', state: 'loaded', content: 'x', lineMarks: [], binary: false, oversized: false })

    conn.pickSession('sk-2')
    await flushPromises()

    expect(ft.tabs).toHaveLength(0)
  })

  it('回退回填的图片附件带解码后字节数——上限内但 base64 超长的图重发不被误拒', async () => {
    const { conn, status } = setup()
    const gw = await connectWithHistory(conn)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    // 解码后 716799B（≤ MAX_ATTACHMENT_BYTES=716800）；base64 长度 955732 > 上限——缺 sizeBytes 时
    // 下游 attachmentByteCount 退化为「按字符数当字节数」，一条本可正常发出的图会被误判超限。
    const data = 'A'.repeat(955732)
    gw.rewind.mockResolvedValue({ editorText: '第一问', editorAttachments: [{ mimeType: 'image/png', data }] })

    await conn.rewind('entry-1')

    const [text, attachments] = vi.mocked(status.onEntryBackfill!).mock.calls[0]!
    expect(text).toBe('第一问')
    expect(attachments[0]).toMatchObject({ type: 'image', mimeType: 'image/png', sizeBytes: 716799 })
    expect(buildAttachments(attachments).rejected).toHaveLength(0) // 端到端语义：可原样重发
  })
})

// Codex #703 review（5185814928）发现的复现/回归：回退与「离线残留 / 在途窗口 / 会话元数据」三个
// 语境的交互。三条发现均不在 #694 已声明的编排契约内（CONTEXT.md「会话控制能力」只覆盖
// 「回退窗口内再次回退」，未覆盖窗口内 send、outbox 残留、会话列表元数据）。
describe('#694 回退与离线/在途语境的交互（Codex #703 review）', () => {
  setupConnTestEnv()

  const HISTORY = [
    { role: 'user', text: '第一问', __openclaw: { id: 'entry-1' } },
    { role: 'assistant', text: '第一答', __openclaw: { id: 'entry-2' } },
  ]

  async function connectWithHistory(conn: ReturnType<typeof useChatConnection>): Promise<InstanceType<typeof MockGatewayChat>> {
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: HISTORY, hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()
    return gw
  }

  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  function outboxItems(container: string, sessionKey: string): unknown[] {
    const raw = sessionStorage.getItem(`openclaw.panel.outbox.v1:${container}`) ?? '{}'
    const blob = JSON.parse(raw) as { sessions?: Record<string, unknown[]> }
    return blob.sessions?.[sessionKey] ?? []
  }

  it('P1-a 回退成功后作废本会话 outbox 残留——被回退的消息不得在下次重连时重发', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)

    // 前置：一条「已点发送但网关没回执 / run 未起来」的文本消息留在队里（#564 失败留队语义）。
    chat.setInput('被回退的消息')
    gw.send.mockRejectedValue(new Error('网关未受理'))
    conn.send(false)
    await flushPromises()
    expect(outboxItems('demo', 'sk-1')).toHaveLength(1) // 前置：确实残留

    // 回退剪掉活跃路径上的那条消息——outbox 里的同一条必须随之作废。
    gw.rewind.mockResolvedValue({ editorText: '第一问', editorAttachments: [] })
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    await conn.rewind('entry-1')

    expect(outboxItems('demo', 'sk-1')).toEqual([])

    // 症状复现面：下一次握手（重连）走 syncSessions → resendOutbox，会把残留消息重发到回退后的分支。
    gw.send.mockReset()
    gw.send.mockResolvedValue('run-replay')
    gw.fireReady() // 重连就绪
    await flushPromises()
    expect(gw.send).not.toHaveBeenCalled() // 绝不可重发
    expect(chat.messages.some((m) => m.text === '被回退的消息')).toBe(false)
  })

  it('P1-b 回退在途（RPC 未回）时禁止发送——窗口内落下的新消息不得被后续 abandonActiveRun 吞掉', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)

    const inflight = deferred<{ editorText: string; editorAttachments: never[] }>()
    gw.rewind.mockReturnValue(inflight.promise)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })

    const rewinding = conn.rewind('entry-1')
    await flushPromises() // RPC 已发出、尚未应答——窗口期开始

    // 用户在该窗口内按了发送（composer 的 disabled 门只看 connecting/streaming/disconnected，全为假）。
    chat.setInput('回退期间的新消息')
    gw.send.mockResolvedValue('run-new')
    const accepted = conn.send(false)

    inflight.resolve({ editorText: '第一问', editorAttachments: [] })
    await rewinding

    expect(accepted).toBe(false) // 窗口内拒发
    expect(gw.send).not.toHaveBeenCalled() // 窗口内不落 RPC（发送即被服务器端竞速吞掉的根源）
  })

  it('P2 回退成功后刷新会话元数据——标题/更新时间取网关权威快照', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    expect(chat.sessions[0]).toMatchObject({ title: '', updated_at: '' })

    gw.rewind.mockResolvedValue({ editorText: '', editorAttachments: [] })
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-1', title: '回退后的标题', updated_at: '2026-09-12T09:00:00.000Z' },
    ])

    await conn.rewind('entry-1')

    expect(chat.sessions.find((s) => s.session_key === 'sk-1')).toMatchObject({
      title: '回退后的标题',
      updated_at: '2026-09-12T09:00:00.000Z',
    })
  })

  it('P1-c-2 重连同步失败 → 投影保持非权威（fail-closed），待下次权威加载才恢复', async () => {
    const { conn } = setup()
    const gw = await connectWithHistory(conn)
    expect(conn.transcriptSynced.value).toBe(true) // 首连铺底后权威

    gw.fireClose(1006, '', true)
    await flushPromises()

    // 重连握手完成，但同步 RPC 失败（listSessions 拒绝）——不恢复权威（可见的是断线前旧条目）
    gw.listSessions.mockRejectedValue(new Error('网关列表拉取失败'))
    gw.fireReady()
    await flushPromises()
    expect(conn.transcriptSynced.value).toBe(false) // fail-closed

    // 自愈路径：切会话触发权威 loadHistory 成功 → 恢复权威
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-1', title: '', updated_at: '' },
      { session_key: 'sk-2', title: '', updated_at: '' },
    ])
    conn.pickSession('sk-2')
    await flushPromises()
    expect(conn.transcriptSynced.value).toBe(true)
  })
})

// #697 对话 fork 编排（#693 spec 前端线）：sessions.fork RPC → prependSession 占位置顶 → 标准
// pickSession 切到新会话（resetForSession + 全量 loadHistory）→ 三重守卫后播种 composer →
// refreshSessions 权威刷新。与 rewind 的关键差异（grilling 决议）：
//  - 源会话零动：不作废 outbox、不清 run/resume（fork 不剪源 transcript，待发残留仍属合法旧代）；
//  - 无草稿指纹守卫（await 期间用户草稿属源会话，切换时按既有机制存回源 key，新会话草稿为空）；
//  - resendOutbox 不加 forkBusy 栅栏（源会话待发消息合法，重连照常重发）。
describe('#697 对话 fork 编排', () => {
  setupConnTestEnv()

  const HISTORY = [
    { role: 'user', text: '第一问', __openclaw: { id: 'entry-1' } },
    { role: 'assistant', text: '第一答', __openclaw: { id: 'entry-2' } },
    { role: 'user', text: '第二问', __openclaw: { id: 'entry-3' } },
    { role: 'assistant', text: '第二答', __openclaw: { id: 'entry-4' } },
  ]

  async function connectWithHistory(conn: ReturnType<typeof useChatConnection>): Promise<InstanceType<typeof MockGatewayChat>> {
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: HISTORY, hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await ready
    await flushPromises()
    return gw
  }

  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  function outboxItems(container: string, sessionKey: string): unknown[] {
    const raw = sessionStorage.getItem(`openclaw.panel.outbox.v1:${container}`) ?? '{}'
    const blob = JSON.parse(raw) as { sessions?: Record<string, unknown[]> }
    return blob.sessions?.[sessionKey] ?? []
  }

  it('成功：RPC 原样透传 → 新会话 prepend 置顶 + 原地切换 + 新 transcript 铺底 + 播种 composer + 元数据刷新', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    // fork 切点 = entry-3（第二问）之前：新会话 transcript = 第一问答；被点的第二问播种 composer
    const forkPrefix = [HISTORY[0], HISTORY[1]]
    gw.getHistory.mockResolvedValue({ messages: forkPrefix, hasMore: false, nextOffset: null })
    gw.forkEntry.mockResolvedValue({
      sessionKey: 'sk-fork-1',
      editorText: '第二问',
      editorAttachments: [{ mimeType: 'image/png', data: 'AAAA' }],
    })
    // refreshSessions 权威列表已含新会话（网关侧 fork 已落定）；C1 保留选中
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-fork-1', title: '', updated_at: '' },
      { session_key: 'sk-1', title: '', updated_at: '' },
    ])

    await conn.fork('entry-3')

    expect(gw.forkEntry).toHaveBeenCalledWith('sk-1', 'entry-3')
    expect(chat.sessions.map((s) => s.session_key)).toEqual(['sk-fork-1', 'sk-1']) // 置顶 + 源行保留
    expect(chat.selectedSession).toBe('sk-fork-1') // 原地切换
    expect(gw.getHistory).toHaveBeenLastCalledWith('sk-fork-1', expect.anything()) // 新会话权威铺底
    expect(chat.messages.map((m) => m.text)).toEqual(['第一问', '第一答']) // 切点前缀
    expect(status.onEntryBackfill).toHaveBeenCalledWith('第二问', [
      { type: 'image', mimeType: 'image/png', content: 'AAAA', sizeBytes: 3 },
    ])
    expect(gw.listSessions).toHaveBeenCalledTimes(2) // 成功后 refreshSessions 权威刷新
  })

  it('源会话零动：fork 成功后源会话 outbox 待发残留仍在（不被作废——与 rewind 的代际作废语义相反）', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    // 前置：一条留在 outbox 的源会话待发消息（#564 失败留队）
    chat.setInput('源会话的待发消息')
    gw.send.mockRejectedValueOnce(new Error('网关未受理'))
    conn.send(false)
    await flushPromises()
    expect(outboxItems('demo', 'sk-1')).toHaveLength(1)

    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.forkEntry.mockResolvedValue({ sessionKey: 'sk-fork-1', editorText: '', editorAttachments: [] })
    await conn.fork('entry-1')

    expect(outboxItems('demo', 'sk-1')).toHaveLength(1) // 源会话残留不随 fork 作废
  })

  it('失败（网关拒绝）：明确提示（动作类通道）且零状态变更——列表/选中/transcript/草稿全原样', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    chat.setInput('源会话草稿')
    gw.forkEntry.mockRejectedValue(new Error('Fork is unavailable while the agent is working.'))

    await conn.fork('entry-3')

    expect(status.onActionError).toHaveBeenCalledWith('分叉失败：Fork is unavailable while the agent is working.')
    expect(status.onError).not.toHaveBeenCalled()
    expect(gw.getHistory).toHaveBeenCalledTimes(1) // 只有首连铺底那次（不重拉不重建）
    expect(chat.messages).toHaveLength(4) // 源 transcript 原样
    expect(chat.selectedSession).toBe('sk-1')
    expect(chat.sessions.map((s) => s.session_key)).toEqual(['sk-1']) // 无占位行
    expect(chat.input).toBe('源会话草稿') // 草稿不动
    expect(status.onEntryBackfill).not.toHaveBeenCalled()
  })

  it('RPC 成功但新会话历史拉取失败 → 不回切（网关侧 fork 已发生不可回滚），走既有 loadHistory 失败路径', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    gw.forkEntry.mockResolvedValue({ sessionKey: 'sk-fork-1', editorText: '第二问', editorAttachments: [] })
    gw.getHistory.mockRejectedValue(new Error('history unavailable'))
    // 权威列表已含新会话——refreshSessions 不把选中回退到源会话
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-fork-1', title: '', updated_at: '' },
      { session_key: 'sk-1', title: '', updated_at: '' },
    ])

    await conn.fork('entry-3')

    expect(chat.selectedSession).toBe('sk-fork-1') // 不假装没 fork 过
    expect(chat.sessions.some((s) => s.session_key === 'sk-fork-1')).toBe(true) // 列表保留新会话
  })

  it('导航在途用户切走 → 静默放弃播种（不弹假错误），切换保留', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    gw.forkEntry.mockResolvedValue({ sessionKey: 'sk-fork-1', editorText: '第二问', editorAttachments: [] })
    // fork 的 loadHistory 挂起；期间用户手动切到 sk-2
    const d = deferred<{ messages: unknown[]; hasMore: boolean; nextOffset: null }>()
    gw.getHistory.mockImplementationOnce(() => d.promise)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    const pending = conn.fork('entry-3')
    await flushPromises()
    conn.pickSession('sk-2')
    await flushPromises()
    expect(chat.selectedSession).toBe('sk-2')

    d.resolve({ messages: [], hasMore: false, nextOffset: null }) // fork 的历史响应迟到
    await pending
    await flushPromises()

    expect(chat.selectedSession).toBe('sk-2') // 不被迟到的 fork 续体拉回
    expect(status.onEntryBackfill).not.toHaveBeenCalled()
    expect(status.onActionError).not.toHaveBeenCalled() // 用户主动离开，不弹假错误
  })

  it('RPC 在途切容器 → 迟到的成功结果不导航不播种（containerGen 守卫），不弹假失败', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    const d = deferred<{ sessionKey: string; editorText: string; editorAttachments: never[] }>()
    gw.forkEntry.mockReturnValue(d.promise)
    const pending = conn.fork('entry-3')
    await flushPromises()

    const switching = conn.selectContainer('demo2')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    gw2.listSessions.mockResolvedValue([{ session_key: 'main', title: '', updated_at: '' }])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.listPendingApprovals.mockResolvedValue([])
    gw2.fireReady()
    await switching
    await flushPromises()

    d.resolve({ sessionKey: 'sk-fork-1', editorText: '第二问', editorAttachments: [] })
    await pending
    await flushPromises()

    expect(chat.selectedSession).not.toBe('sk-fork-1') // 不把用户拽去旧容器的新会话
    expect(status.onEntryBackfill).not.toHaveBeenCalled()
    expect(status.onActionError).not.toHaveBeenCalled() // 陈旧结果不弹假失败
  })

  it('在途 fork 单飞：窗口期内再触发一律忽略，落地后解锁', async () => {
    const { conn, status } = setup()
    const gw = await connectWithHistory(conn)
    const d = deferred<{ sessionKey: string; editorText: string; editorAttachments: never[] }>()
    gw.forkEntry.mockReturnValue(d.promise)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })

    const first = conn.fork('entry-1')
    const dup = conn.fork('entry-1')
    const other = conn.fork('entry-3')
    await flushPromises()
    expect(gw.forkEntry).toHaveBeenCalledTimes(1)

    d.resolve({ sessionKey: 'sk-fork-1', editorText: '', editorAttachments: [] })
    await Promise.all([first, dup, other])
    expect(status.onActionError).not.toHaveBeenCalled() // 被吞的重复触发不弹假失败

    // 落地即解锁
    gw.forkEntry.mockResolvedValue({ sessionKey: 'sk-fork-2', editorText: '', editorAttachments: [] })
    await conn.fork('entry-3')
    expect(gw.forkEntry).toHaveBeenCalledTimes(2)
  })

  it('rewind / fork 互斥：回退在途时 fork 被拦，fork 在途时回退被拦（同动 transcript，网关侧乐观并发冲突）', async () => {
    const { conn } = setup()
    const gw = await connectWithHistory(conn)
    // 回退在途（rewindBusy 置位）→ fork 不发
    const dRewind = deferred<{ editorText: string; editorAttachments: never[] }>()
    gw.rewind.mockReturnValue(dRewind.promise)
    const rewinding = conn.rewind('entry-1')
    await flushPromises()
    expect(conn.rewindBusy.value).toBe(true)
    await conn.fork('entry-3')
    expect(gw.forkEntry).not.toHaveBeenCalled()
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    dRewind.resolve({ editorText: '', editorAttachments: [] })
    await rewinding

    // fork 在途（forkBusy 置位）→ rewind 不发
    const dFork = deferred<{ sessionKey: string; editorText: string; editorAttachments: never[] }>()
    gw.forkEntry.mockReturnValue(dFork.promise)
    const forking = conn.fork('entry-3')
    await flushPromises()
    expect(conn.forkBusy.value).toBe(true)
    await conn.rewind('entry-1')
    expect(gw.rewind).toHaveBeenCalledTimes(1) // 只有前一次
    dFork.resolve({ sessionKey: 'sk-fork-1', editorText: '', editorAttachments: [] })
    await forking
  })

  it('fork 在途禁止发送（forkBusy 栅栏对齐 rewindBusy 语义）', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    const d = deferred<{ sessionKey: string; editorText: string; editorAttachments: never[] }>()
    gw.forkEntry.mockReturnValue(d.promise)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })

    const forking = conn.fork('entry-1')
    await flushPromises()
    chat.setInput('fork 期间的新消息')
    gw.send.mockResolvedValue('run-new')
    const accepted = conn.send(false)
    expect(accepted).toBe(false)
    expect(gw.send).not.toHaveBeenCalled()

    d.resolve({ sessionKey: 'sk-fork-1', editorText: '', editorAttachments: [] })
    await forking
  })

  it('forkBusy 不栅栏 resendOutbox——源会话待发残留重连照常重发（与 rewindBusy 语义相反）', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithHistory(conn)
    // 前置：源会话待发残留
    chat.setInput('源会话的待发消息')
    gw.send.mockRejectedValueOnce(new Error('网关未受理'))
    conn.send(false)
    await flushPromises()
    expect(outboxItems('demo', 'sk-1')).toHaveLength(1)

    // fork 在途时断线重连（RPC 未回）
    const d = deferred<{ sessionKey: string; editorText: string; editorAttachments: never[] }>()
    gw.forkEntry.mockReturnValue(d.promise)
    gw.getHistory.mockResolvedValue({ messages: HISTORY, hasMore: false, nextOffset: null })
    const forking = conn.fork('entry-1')
    await flushPromises()
    expect(conn.forkBusy.value).toBe(true)

    gw.fireClose(1006)
    await flushPromises()
    gw.send.mockReset()
    gw.send.mockResolvedValue('run-replay')
    gw.fireReady() // 重连就绪 → syncSessions → resendOutbox
    await flushPromises()

    expect(gw.send).toHaveBeenCalledWith('sk-1', '源会话的待发消息', undefined, expect.any(String)) // 照常重发（幂等 key 复用）

    d.resolve({ sessionKey: 'sk-fork-1', editorText: '', editorAttachments: [] })
    await forking
  })

  it('前置守卫：断线 / 无 entryId / 无会话 → 不发起 RPC', async () => {
    const { conn } = setup()
    const gw = await connectWithHistory(conn)

    await conn.fork('') // 无 entryId
    gw.fireClose(1006)
    await flushPromises()
    await conn.fork('entry-1')

    expect(gw.forkEntry).not.toHaveBeenCalled()
  })

  // review P2：fork 成功后的入口恢复依赖「投影权威」由新会话铺底置真——直接断言，别靠间接推断。
  it('fork 成功切入新会话后 transcriptSynced 恢复 true（新会话权威铺底，入口可再点）', async () => {
    const { conn } = setup()
    const gw = await connectWithHistory(conn)
    expect(conn.transcriptSynced.value).toBe(true) // 前置：源会话权威
    gw.getHistory.mockResolvedValue({ messages: [HISTORY[0]], hasMore: false, nextOffset: null })
    gw.forkEntry.mockResolvedValue({ sessionKey: 'sk-fork-1', editorText: '', editorAttachments: [] })
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-fork-1', title: '', updated_at: '' },
      { session_key: 'sk-1', title: '', updated_at: '' },
    ])

    await conn.fork('entry-3')

    expect(conn.transcriptSynced.value).toBe(true)
  })

  // review P2：同容器变体（此前只测了切容器）——RPC 在途切会话走同一条 selectedSession 守卫。
  it('RPC 在途同容器切会话 → 迟到的成功结果不导航不播种不弹错（新会话留待下次列表同步可见）', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithHistory(conn)
    const d = deferred<{ sessionKey: string; editorText: string; editorAttachments: never[] }>()
    gw.forkEntry.mockReturnValue(d.promise)
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    // 权威列表含用户切往的 sk-2（stale 分支的 fail-soft refreshSessions 会重拉——真实网关列表
    // 必含在列会话，C1 保留选中；mock 若不含会错误触发 C1 兜底重置选中，非本用例研究对象）
    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-1', title: '', updated_at: '' },
      { session_key: 'sk-2', title: '', updated_at: '' },
    ])
    const pending = conn.fork('entry-3')
    await flushPromises()

    conn.pickSession('sk-2') // 同容器切到另一会话
    await flushPromises()
    expect(chat.selectedSession).toBe('sk-2')

    d.resolve({ sessionKey: 'sk-fork-1', editorText: '第二问', editorAttachments: [] })
    await pending
    await flushPromises()

    expect(chat.selectedSession).toBe('sk-2') // 不被迟到的 fork 续体拉走
    expect(status.onEntryBackfill).not.toHaveBeenCalled() // 播种不落进 sk-2 的 composer
    expect(status.onActionError).not.toHaveBeenCalled() // 用户主动离开，不弹假错误
  })
})

// #698 分支菜单编排（#693 spec §1.4）：branches.list 随 syncSessions/pickSession 与 loadHistory
// 并行预拉（fire-and-forget，restorePendingApprovals 先例）；失败静默降级（按钮不渲染即降级语义）；
// branches.switch 复用 #694 rewind 重建管线（abandon + loadHistory 全量重建 + branches 重拉），
// busy 复用 rewindBusy（#706：同族破坏性 RPC + 重建管线，发送在途被拒）；branchesGen 请求代丢弃
// 乱序迟到响应（historyGen 同型论证）。
describe('#698 分支菜单编排', () => {
  setupConnTestEnv()

  const BRANCHES = [
    { leafEntryId: 'leaf-1', headline: 'A 方向', messageCount: 4, active: true },
    { leafEntryId: 'leaf-2', headline: 'B 方向', messageCount: 2, active: false },
  ]

  async function connectWithBranches(conn: ReturnType<typeof useChatConnection>): Promise<InstanceType<typeof MockGatewayChat>> {
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.listBranches.mockResolvedValue(BRANCHES)
    gw.switchBranch.mockResolvedValue(undefined)
    gw.fireReady()
    await ready
    await flushPromises()
    return gw
  }

  it('并行预拉：首连 syncSessions 后 branches 入 store；切会话随 pickSession 再拉', async () => {
    const { conn, chat } = setup()
    const gw = await connectWithBranches(conn)
    expect(gw.listBranches).toHaveBeenCalledWith('sk-1')
    expect(chat.branches).toEqual(BRANCHES)

    gw.listSessions.mockResolvedValue([
      { session_key: 'sk-1', title: '', updated_at: '' },
      { session_key: 'sk-2', title: '', updated_at: '' },
    ])
    conn.pickSession('sk-2')
    await flushPromises()
    expect(gw.listBranches).toHaveBeenLastCalledWith('sk-2')
  })

  it('预拉失败 → 静默降级：不报错误条、不崩（length 门下按钮不渲染即降级语义）', async () => {
    const { conn, chat, status } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    gw.listBranches.mockRejectedValue(new Error('gateway boom'))
    gw.fireReady()
    await ready
    await flushPromises()
    expect(chat.branches).toEqual([])
    expect(status.onError).not.toHaveBeenCalled()
  })

  it('switch 成功：RPC(leafEntryId) → transcript 全量重建 → branches 重拉为新状态', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithBranches(conn)
    expect(chat.branches).toHaveLength(2)
    // 切换后：新活跃路径历史 + 新分支列表（leaf-2 成为 active）
    gw.getHistory.mockResolvedValue({
      messages: [{ role: 'user', text: 'B 方向的第一问', __openclaw: { id: 'entry-b1' } }],
      hasMore: false, nextOffset: null,
    })
    gw.listBranches.mockResolvedValue([
      { leafEntryId: 'leaf-1', headline: 'A 方向', messageCount: 4, active: false },
      { leafEntryId: 'leaf-2', headline: 'B 方向', messageCount: 3, active: true },
    ])

    await conn.switchBranch('leaf-2')

    expect(gw.switchBranch).toHaveBeenCalledWith('sk-1', 'leaf-2')
    expect(chat.messages.map((m) => m.text)).toEqual(['B 方向的第一问']) // transcript 重建为新活跃路径
    expect(gw.listBranches).toHaveBeenCalledTimes(2) // 预拉 1 次 + 切换后重拉 1 次
    expect(chat.branches.find((b) => b.active)?.leafEntryId).toBe('leaf-2') // 分支列表已是新状态
    expect(status.onError).not.toHaveBeenCalled()
  })

  it('switch 失败：明确错误提示（动作类通道），transcript 与 branches 均不动（不假装切成功）', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithBranches(conn)
    gw.switchBranch.mockRejectedValue(new Error('branch is no longer switchable'))
    const historyCallsBefore = gw.getHistory.mock.calls.length

    await conn.switchBranch('leaf-2')

    expect(status.onActionError).toHaveBeenCalledWith('切换分支失败：branch is no longer switchable')
    expect(gw.getHistory.mock.calls.length).toBe(historyCallsBefore) // 不重拉历史
    expect(gw.listBranches).toHaveBeenCalledTimes(1) // 只有预拉那次，不重拉
    expect(chat.branches).toEqual(BRANCHES) // 本地状态原样（active 仍是 leaf-1）
  })

  it('switch 在途（rewindBusy 窗口）：发送被拒 + 重入被吞（继承 #706 门语义）', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithBranches(conn)
    const deferred: { resolve?: () => void } = {}
    gw.switchBranch.mockImplementation(() => new Promise((r) => { deferred.resolve = r }))

    const first = conn.switchBranch('leaf-2')
    await flushPromises()
    expect(conn.rewindBusy.value).toBe(true) // busy 复用同一 ref（send() 守卫/composer 置灰自动继承）
    conn.switchBranch('leaf-1') // 重入：吞掉
    chat.setInput('在途想说的话')
    conn.send(false) // 发送：被拒
    await flushPromises()
    expect(gw.send).not.toHaveBeenCalled()
    expect(gw.switchBranch).toHaveBeenCalledTimes(1)
    expect(status.onActionError).not.toHaveBeenCalled() // 被吞的重入不得冒「假失败」

    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    deferred.resolve?.()
    await first
    expect(conn.rewindBusy.value).toBe(false) // 落地解锁
  })

  it('前置守卫：断线 / 无 leafEntryId / 无会话 → 不发起 RPC', async () => {
    const { conn } = setup()
    const gw = await connectWithBranches(conn)
    await conn.switchBranch('')
    gw.fireClose(1006)
    await flushPromises()
    await conn.switchBranch('leaf-2')
    expect(gw.switchBranch).not.toHaveBeenCalled()
  })

  // P1 回归（review 发现）：rewind 成功后的 branches 重拉是无条件的（#693 spec §1.4 / #698 AC14）
  // ——草稿指纹守卫只拦 composer 回填，不得连带短路 branches 重拉（回退剪出新分叉点后分支数
  // 可能从 1 变 2，按钮该出现却没出现直到下次切会话）。
  it('rewind 成功且草稿已变（守卫触发、不回填）→ branches 仍被重拉（草稿守卫不拦 branches refresh）', async () => {
    const { conn, chat, status } = setup()
    const gw = await connectWithBranches(conn)
    expect(gw.listBranches).toHaveBeenCalledTimes(1) // 前置：首连预拉已入
    expect(chat.branches).toHaveLength(2)
    // RPC 前后草稿指纹不同：守卫触发，跳过回填
    vi.mocked(status.onRewindDraftFingerprint!).mockReturnValueOnce('draft-A').mockReturnValueOnce('draft-B')
    gw.rewind.mockResolvedValue({ editorText: '第一问', editorAttachments: [] })
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    // 重拉应答 = 回退后的新分支状态（leaf-1 仍 active 但条数变了）
    gw.listBranches.mockResolvedValue([{ leafEntryId: 'leaf-1', headline: 'A 方向', messageCount: 3, active: true }])

    await conn.rewind('entry-1')

    expect(status.onRewindBackfill).not.toHaveBeenCalled() // 守卫行为不变：新草稿原地保留，不回填旧 editorText
    expect(chat.messages).toHaveLength(0) // transcript 重建行为不变
    expect(gw.listBranches).toHaveBeenCalledTimes(2) // ← 修复前：停在 1（被草稿守卫的 early return 短路）
    expect(chat.branches).toEqual([{ leafEntryId: 'leaf-1', headline: 'A 方向', messageCount: 3, active: true }]) // 重拉落地为新状态（发生在 rewind 成功后的 rebuild 流程内）
  })

  it('branchesGen 请求代：同会话并发两次 listBranches 乱序返回 → 只留最新代（旧响应不覆盖新状态）', async () => {
    const { conn, chat } = setup()
    const ready = conn.openGateway()
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([{ session_key: 'sk-1', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.listPendingApprovals.mockResolvedValue([])
    // 首连预拉挂起（慢网关）
    const first: { resolve?: (v: typeof BRANCHES) => void } = {}
    gw.listBranches.mockImplementationOnce(() => new Promise((r) => { first.resolve = r }))
    gw.fireReady()
    await ready
    await flushPromises()
    // switch 成功后的重拉（第 2 代）先落地
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.switchBranch.mockResolvedValue(undefined)
    gw.listBranches.mockResolvedValueOnce([{ leafEntryId: 'leaf-2', headline: 'B', active: true }])
    await conn.switchBranch('leaf-2')
    expect(chat.branches.map((b) => b.leafEntryId)).toEqual(['leaf-2'])
    // 旧代（首连预拉）此刻才到 → 丢弃，不覆盖 switch 后的新状态
    first.resolve?.(BRANCHES)
    await flushPromises()
    expect(chat.branches.map((b) => b.leafEntryId)).toEqual(['leaf-2'])
  })
})
