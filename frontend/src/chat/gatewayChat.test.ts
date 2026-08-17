// seam: chat/gatewayChat —— createGatewayChat（#369 M5 前端接线 Facade）。
// mock 官方 GatewayProtocolClient + 面板隧道 createPanelTunnelSocket，断言：
// 构造（bootstrapToken/connect params/事件路由/close 决策）+ RPC 参数与响应校准
// （sessions.list/create/delete、chat.history/send、commands.list、exec.approval.resolve）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// 假协议机：捕获 options（含 onEvent/onClose/resolveClose/buildConnectPlan），request/start/stop 可控。
// vi.hoisted：vi.mock 工厂被 hoist 到文件顶部执行，须经 vi.hoisted 共享类定义。
const { MockGatewayProtocolClient, MockGatewayProtocolRequestError, MockShouldPauseReconnect, MockLifecycle } = vi.hoisted(() => {
  // 官方包不导出 GatewayProtocolClientOptions 顶层类型；mock 只消费下面几个回调/字段
  type MockOpts = {
    onEvent?: (e: unknown) => void
    onHello?: () => void
    onConnectHello?: (h: unknown, c: unknown) => void
    onClose?: (c: { code: number; reason: string }, d: unknown) => void
    onConnectFailure?: (error: Error, context: { generation: number; nonce: null; challengeTs: null; plan?: unknown }) => unknown
    resolveClose?: (c: Record<string, unknown>) => { retry: boolean; notify?: boolean; reconnectDelayMs?: number }
    onConnectError?: (e: Error) => void
    onRequestTiming?: (t: { errorCode?: string }) => void
    onActivity?: () => void
    buildConnectPlan?: (p: unknown) => unknown | Promise<unknown>
    buildConnectParams?: (p: unknown) => unknown
    createSocket?: (h: unknown) => unknown
    handshake?: unknown
    requestTimeoutMs?: number
  }
  // 简化实现：details.code 在真实网关错误详情里是 ConnectErrorDetailCodes 之一。
  // #567: AUTH_TOKEN_MISMATCH 单列对齐真实 SDK（shouldPauseGatewayReconnect 源码：
  // tokenMismatchIsTerminal === true && !deviceTokenRetryPending）——deviceTokenRetryPending=true
  // 时返 false（允许 retry，走官方单次重发通道）；其余码仍在 NON_RECOVERABLE 集合。
  const MockShouldPauseReconnect = (params: { details?: unknown; tokenMismatchIsTerminal?: boolean; deviceTokenRetryPending?: boolean; protocolMismatchIsTerminal?: boolean; clientVersionMismatchIsTerminal?: boolean }): boolean => {
    const code = (params.details as { code?: string } | undefined)?.code
    if (code === 'AUTH_TOKEN_MISMATCH') {
      return params.tokenMismatchIsTerminal === true && !params.deviceTokenRetryPending
    }
    return [
      'PAIRING_REQUIRED',
      'AUTH_BOOTSTRAP_TOKEN_INVALID',
      'AUTH_DEVICE_TOKEN_MISMATCH',
      'AUTH_SCOPE_MISMATCH',
    ].includes(code ?? '')
  }
  class MockGatewayProtocolRequestError extends Error {
    code: string
    gatewayCode: string
    details?: unknown
    constructor(error: { code?: string; message?: string; gatewayCode?: string; details?: unknown }) {
      super(error.message ?? '')
      this.code = error.code ?? ''
      this.gatewayCode = error.gatewayCode ?? ''
      this.details = error.details
    }
  }
  class MockGatewayProtocolClient {
    static last: MockGatewayProtocolClient | null = null
    opts: MockOpts
    request: ReturnType<typeof vi.fn> = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    closeSocket = vi.fn()
    connected = false
    connecting = false
    constructor(opts: MockOpts) {
      this.opts = opts
      MockGatewayProtocolClient.last = this
    }
    emitEvent(frame: unknown): void {
      this.opts.onEvent?.(frame)
    }
    fireHello(): void {
      this.opts.onHello?.()
    }
    fireRequestTiming(timing: { errorCode?: string }): void {
      this.opts.onRequestTiming?.(timing)
    }
    fireActivity(): void {
      this.opts.onActivity?.()
    }
    close(context: { code: number; reason: string; connectFailure?: { error: Error; reconnectDelayMs?: number } }): void {
      const decision = this.opts.resolveClose?.(context)
      this.opts.onClose?.(context, decision)
    }
    fireConnectHello(hello: unknown, plan: unknown): void {
      this.opts.onConnectHello?.(hello, { generation: 1, nonce: null, challengeTs: null, plan })
    }
    // #567: connect 阶段被网关 reject（协议机在 sendConnectPlan 的 request reject 时同步触发，
    // context 带本次 connect 的 plan——真实协议机时序：onConnectFailure → socket.close(1008) →
    // resolveClose → onClose）。返回 onConnectFailure 决策（真实协议机用其 closeCode/closeReason
    // 关 socket，缺失时 ?? 默认 {closeCode:1008, closeReason:'connect failed'}）。
    fireConnectFailure(error: Error, plan: unknown): unknown {
      return this.opts.onConnectFailure?.(error, { generation: 1, nonce: null, challengeTs: null, plan })
    }
    connectError(message: string): void {
      this.opts.onConnectError?.(new Error(message))
    }
  }
  return {
    MockGatewayProtocolClient,
    MockGatewayProtocolRequestError,
    MockShouldPauseReconnect,
    // 官方 GatewayBrowserDeviceAuthLifecycle 的假实现（经 vi.mock('./deviceAuth') 注入）：
    // buildPlan 默认「首连用 bootstrap token + 设备签名块」；已配对重连（deviceToken）由测试
    // mockResolvedValueOnce 覆盖。acceptHello/clearStoredToken 仅断言调用，不真落存储。
    MockLifecycle: {
      // buildPlan 默认行为（首连 bootstrap + 设备签名块）在 beforeEach 设 mockImplementation，测试用
      // mockResolvedValueOnce 覆盖（如已配对重连返回 deviceToken auth）。
      buildPlan: vi.fn(),
      acceptHello: vi.fn(async () => {}),
      clearStoredToken: vi.fn(async () => {}),
    },
  }
})

// 部分 mock 官方包：协议机类与重连判定用假实现（close 决策可控），SessionProjection 套件
//（createSessionProjection/reduceSessionProjectionRunEvent/hasSessionProjectionAcceptedFinal）保留
// 真实 SDK 实现（#560 projection 接线测试须测真实归约语义——假归约器会让接线测试失去意义）。
vi.mock('@openclaw/gateway-client/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openclaw/gateway-client/browser')>()
  return {
    ...actual,
    GatewayProtocolClient: MockGatewayProtocolClient,
    GatewayProtocolRequestError: MockGatewayProtocolRequestError,
    shouldPauseGatewayReconnect: MockShouldPauseReconnect,
  }
})

vi.mock('./tunnelSocket', () => ({
  createPanelTunnelSocket: vi.fn((container: string, jwt: string, handlers: unknown) => ({
    isOpen: () => false,
    send: vi.fn(),
    close: vi.fn(),
    // 供测试断言 createSocket 透传了 handlers
    __container: container,
    __jwt: jwt,
    __handlers: handlers,
  })),
}))

// #377: gatewayChat 默认 createDeviceAuthLifecycle() 取官方 lifecycle —— mock 成可控假实现
// （buildPlan/acceptHello/clearStoredToken 可断言；配对编排断言「approve → 重连」）。
// hasStoredDeviceTokenFor：真网关适配凭证选择「首连 token / 重连 deviceToken」的判断来源——
// mock 默认未配对（false），已配对重连测试 mockResolvedValueOnce(true)。
vi.mock('./deviceAuth', () => ({
  createDeviceAuthLifecycle: () => MockLifecycle,
  hasStoredDeviceTokenFor: vi.fn(),
}))

// approve 端点（#371-1）：gatewayChat 配对编排经 REST 调后端 approve。
vi.mock('@/api/chat', () => ({
  approvePairing: vi.fn(),
}))

import { createGatewayChat } from './gatewayChat'
import { approvePairing } from '@/api/chat'
import { hasStoredDeviceTokenFor } from './deviceAuth'

function makeHandlers() {
  return {
    onReady: vi.fn(),
    onFrame: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  }
}

function makeGateway(handlers = makeHandlers()) {
  const gw = createGatewayChat({ container: 'alpha', jwt: 'jwt-1', bootstrapToken: 'boot-1', handlers })
  const client = MockGatewayProtocolClient.last!
  return { gw, client, handlers }
}

beforeEach(() => {
  vi.clearAllMocks()
  MockGatewayProtocolClient.last = null
  // 默认未配对（首连）：gatewayChat 传 token 参数 → mock buildPlan 输出 auth:{token} + 设备签名块
  //（真网关 2026.7.1 实测适配，pairingSmoke.test.ts 同款）。已配对重连由测试 mockResolvedValueOnce 覆盖。
  // clearAllMocks 保留 implementation，这里显式重置防测试间 mockImplementation 泄漏。
  MockLifecycle.buildPlan.mockImplementation(async (params) => ({
    clientId: params.client.id,
    role: params.role,
    identity: { deviceId: 'dev-1', publicKey: 'pk-1', sign: vi.fn() },
    selectedAuth: {},
    scopes: [...params.defaultScopes],
    auth: params.token ? { token: params.token } : {},
    device: { id: 'dev-1', publicKey: 'pk-1', signature: 'sig-1', signedAt: 123, nonce: params.nonce ?? '' },
  }))
  // 凭证选择判断：默认未配对（首连 token）；已配对重连测试 mockResolvedValueOnce(true)。
  vi.mocked(hasStoredDeviceTokenFor).mockReset().mockResolvedValue(false)
})

describe('createGatewayChat（#369 隧道 Facade）', () => {
  it('构造：buildConnectPlan 经 lifecycle（首连 token + 设备签名块）→ buildConnectParams 透传 auth/device', async () => {
    const handlers = makeHandlers()
    const gw = createGatewayChat({ container: 'alpha', jwt: 'jwt-1', bootstrapToken: 'boot-1', handlers })
    const client = MockGatewayProtocolClient.last!
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 0 })
    // #377 + 真网关适配：凭证选择交给官方 lifecycle——未配对（hasStoredDeviceTokenFor=false）首连传
    // token 参数（真网关 2026.7.1 认 auth.token 字段，bootstrapToken 字段被当 setup code 拒）
    expect(MockLifecycle.buildPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({ id: 'openclaw-control-ui' }),
        role: 'operator',
        defaultScopes: ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin'],
        token: 'boot-1',
        nonce: 'n',
      }),
    )
    expect(plan).toMatchObject({
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin'],
      caps: ['tool-events'],
      auth: { token: 'boot-1' },
      device: { id: 'dev-1', signature: 'sig-1' },
    })
    const params = client.opts.buildConnectParams!(plan)
    expect(params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      client: expect.objectContaining({ id: 'openclaw-control-ui' }),
      auth: { token: 'boot-1' },
      device: expect.objectContaining({ id: 'dev-1', signature: 'sig-1' }),
    })
    expect((params as { caps: string[] }).caps).toEqual(['tool-events'])
    gw.start()
    expect(client.start).toHaveBeenCalledTimes(1)
    gw.stop()
    expect(client.stop).toHaveBeenCalledTimes(1)
  })

  it('createSocket 用容器名 + JWT 建面板隧道（容器名进 URL、token 进 subprotocol）', () => {
    const { client } = makeGateway()
    const socket = client.opts.createSocket!({} as never) as unknown as {
      __container: string
      __jwt: string
      __handlers: unknown
    }
    expect(socket.__container).toBe('alpha')
    expect(socket.__jwt).toBe('jwt-1')
    expect(socket.__handlers).toBeTruthy() // open/message/close/error handlers 透传给隧道 socket
  })

  it('onHello → handlers.onReady', () => {
    const { client, handlers } = makeGateway()
    client.fireHello()
    expect(handlers.onReady).toHaveBeenCalledTimes(1)
  })

  it('onEvent → 事件翻译路由到 handlers.onFrame（chat delta → text 帧）', () => {
    const { client, handlers } = makeGateway()
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: '你好' } })
    expect(handlers.onFrame).toHaveBeenCalledWith({ type: 'text', runId: 'r1', delta: '你好' })
  })

  // ---- #560: SDK SessionProjection 接线（真实 SDK 归约器，部分 mock 保留原实现）----
  // 实证用例（规格 §4.3-4.5）：onHello 重建 projection、终态 message 归一、重放去重、timeout 细分。
  it('#560 §4.3: 归约器接管终态 message 归一——delta 快照被 final 权威 message 覆盖', () => {
    const { client, handlers } = makeGateway()
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: 'He' } })
    // delta 后 final 带权威 message（含未投递尾部）→ tail 补发（来源 currentRun.message）
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: 'Hello' } })
    expect(handlers.onFrame).toHaveBeenNthCalledWith(2, { type: 'text', runId: 'r1', delta: 'llo' })
    // #569: done 帧携带归约权威 message（外来局部插入数据通道；本 run 消费端不读）
    expect(handlers.onFrame).toHaveBeenNthCalledWith(3, { type: 'done', runId: 'r1', message: 'Hello' })
  })

  // #569: 外来 run final 的归约 message 透出到 done 帧（外来局部插入的数据通道）+ 重放被去重网拦截。
  // 归约器对每个 run 独立归约（外来 run 同样经 reduceSessionProjectionRunEvent），重放网对外来 run
  // 同样生效——同一外来 run 的 final 二次到达被 hasSessionProjectionAcceptedFinal 拦截（只插入一次）。
  it('#569: 外来 run final 归约 message 透出到 done 帧 + 重放二次到达被拦截', () => {
    const { client, handlers } = makeGateway()
    const finalMsg = { role: 'assistant', content: [{ type: 'text', text: '外来最终结果' }] }
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'foreign-1', state: 'delta', deltaText: '外来' } })
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'foreign-1', state: 'final', message: finalMsg } })
    expect(handlers.onFrame).toHaveBeenCalledWith({ type: 'done', runId: 'foreign-1', message: finalMsg })
    // resume 重放：同一外来 run 的 final 再次到达 → 去重网拦截，不产帧（本 run 分支亦无插入）
    const before = handlers.onFrame.mock.calls.length
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'foreign-1', state: 'final', message: finalMsg } })
    expect(handlers.onFrame.mock.calls.length).toBe(before)
  })

  it('#560 §4.4: 重放去重——同一 run 的 final 重复到达（resume 重放）第二次被 hasSessionProjectionAcceptedFinal 拦截', () => {
    const { client, handlers } = makeGateway()
    // 真实 SDK：final 带 id（__openclaw）→ identity=id:role:id，非指纹
    const finalMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: '最终回答' }],
      __openclaw: { id: 'msg-1', role: 'assistant', seq: 5 },
    }
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: '最终回答' } })
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: finalMsg } })
    const before = handlers.onFrame.mock.calls.length
    // resume 重放：同一 run 的 final 再次到达（无 delta 重发）→ 投影已记住终态 identity →
    // hasSessionProjectionAcceptedFinal 拦截（若无去重网，此帧会再产一个 done）
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: finalMsg } })
    expect(handlers.onFrame.mock.calls.length).toBe(before) // 重放 final 被拦截，不产帧
  })

  it('#560 §4.5: timeout 细分——error + errorKind=timeout → error 帧带超时标记（此前无此区分）', () => {
    const { client, handlers } = makeGateway()
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'error', errorKind: 'timeout' } })
    expect(handlers.onFrame).toHaveBeenLastCalledWith({ type: 'error', runId: 'r1', message: 'timeout（超时）' })
  })

  it('#560 回归（review H1/H2）: delta 后首次 error → 恒产 error 帧（不走重放网，不误吞）', () => {
    const { client, handlers } = makeGateway()
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: '部分文本' } })
    // 首次 error：SDK identity 判定可能命中 delta 快照指纹，但 error 不走重放网 → 恒产 error 帧
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'error', errorMessage: 'boom' } })
    expect(handlers.onFrame).toHaveBeenLastCalledWith({ type: 'error', runId: 'r1', message: 'boom' })
  })

  it('#560 回归（review H1/H2）: delta 后 aborted → 恒产 done 帧（不走重放网，气泡正常收尾）', () => {
    const { client, handlers } = makeGateway()
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: '部分文本' } })
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'aborted' } })
    expect(handlers.onFrame).toHaveBeenLastCalledWith({ type: 'done', runId: 'r1' })
  })

  it('#560: onHello 重建 projection（新连接生命周期边界——旧 run 终态身份作废，重放不再被误拦）', () => {
    const { client, handlers } = makeGateway()
    const finalMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'A' }],
      __openclaw: { id: 'msg-1', role: 'assistant', seq: 5 },
    }
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: 'A' } })
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: finalMsg } })
    client.fireHello() // 连接生命周期边界 → projection 重建
    // 新连接同 runId 的 final 重新渲染（旧投影的 acceptedFinalMessageIdentities 已作废）
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: 'B' } })
    client.emitEvent({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: 'B' } })
    expect(handlers.onFrame).toHaveBeenCalledWith({ type: 'done', runId: 'r1', message: 'B' })
  })

  it('close 决策：4401/4404/4403 → retry:false + notify；4402 → retry:true；其他 → retry:true', () => {
    const { client, handlers } = makeGateway()
    client.close({ code: 4401, reason: 'Unauthorized' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4401, 'Unauthorized', false, false)
    client.close({ code: 4404, reason: 'container denied' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4404, 'container denied', false, false)
    client.close({ code: 4403, reason: 'must change password' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4403, 'must change password', false, false)
    client.close({ code: 4402, reason: 'gateway down' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'gateway down', true, false)
    client.close({ code: 1006, reason: 'abnormal' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(1006, 'abnormal', true, false)
    // 各 code 的 retry 决策
    const decisions: boolean[] = []
    for (const code of [4401, 4404, 4403, 4402, 1006]) {
      decisions.push(client.opts.resolveClose!({ code, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }).retry)
    }
    expect(decisions).toEqual([false, false, false, true, true])
  })

  it('D2: give-up（连续失败超阈值）→ onClose 透传 retry:false（UI 如实提示手动重连）', () => {
    const { client, handlers } = makeGateway()
    for (let i = 0; i < 5; i++) client.close({ code: 4402, reason: 'down' })
    // 第 5 次 close：resolveClose 达阈值返回 retry:false → onClose 第三个参数 false
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'down', false, false)
  })

  it('F1: connect 阶段被拒（PAIRING_REQUIRED / AUTH 错误）→ retry:false（防 #369 空转重连）', () => {
    const { client } = makeGateway()
    const connError = new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'gateway connect failed',
      gatewayCode: 'ERR_PAIRING_REQUIRED',
      details: { code: 'PAIRING_REQUIRED' },
    })
    const decision = client.opts.resolveClose!({
      code: 1000, // tunnelSocket 把 connect 失败码 1008 映射为 1000
      reason: 'closed(1008)',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: true,
      connectFailure: { error: connError },
    })
    expect(decision.retry).toBe(false)
    expect(decision.notify).toBe(true)
  })

  it('F1: connect 被拒但错误非非恢复类（如网关启动中）→ 仍 retry（交退避自愈）', () => {
    const { client } = makeGateway()
    const connError = new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'gateway starting',
      gatewayCode: '',
      details: { code: 'SOMETHING_ELSE' },
    })
    const decision = client.opts.resolveClose!({
      code: 1013,
      reason: 'gateway starting',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: true,
      connectFailure: { error: connError },
    })
    expect(decision.retry).toBe(true)
    expect(decision.reconnectDelayMs).toBeUndefined()
  })

  it('F2: resolveClose 省略 reconnectDelayMs（交协议机指数退避，防退避/尝试上限成死代码）', () => {
    const { client } = makeGateway()
    const ctx = {
      code: 4402,
      reason: '',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: false,
    }
    const d1 = client.opts.resolveClose!(ctx)
    expect(d1.retry).toBe(true)
    expect(d1.reconnectDelayMs).toBeUndefined()
    const d2 = client.opts.resolveClose!({ ...ctx, code: 1006 })
    expect(d2.retry).toBe(true)
    expect(d2.reconnectDelayMs).toBeUndefined()
  })

  it('F2: 连续失败达阈值 → 停止自动重连转手动（give-up 防无限空转）；hello 重置计数', () => {
    const { client } = makeGateway()
    const ctx = {
      code: 4402,
      reason: '',
      generation: 0,
      socketOpened: true,
      helloReceived: false,
      connectRequestSent: false,
    }
    const retries: boolean[] = []
    for (let i = 0; i < 5; i++) retries.push(client.opts.resolveClose!(ctx).retry)
    expect(retries).toEqual([true, true, true, true, false])
    client.fireHello() // 重连成功 → 重置计数，可再次退避重试
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
  })

  it('P1-6: 稳定连接（hello 后存活超阈值）断开不计失败预算；crash-loop（hello 即崩）计数累积', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { client } = makeGateway()
      const ctx = {
        code: 4402,
        reason: '',
        generation: 0,
        socketOpened: true,
        helloReceived: true, // 已 hello
        connectRequestSent: true,
      }
      // 场景 A：hello 后存活超过 30s 稳定阈值再断（如看门狗自发 closeSocket / 网络抖动）→ 不计费
      client.fireHello()
      vi.advanceTimersByTime(31_000)
      expect(client.opts.resolveClose!(ctx).retry).toBe(true) // 稳定断开不消耗预算
      // 场景 B：crash-loop——hello 后立即崩（<30s 阈值），连续 5 次仍累积到 give-up
      for (let i = 0; i < 4; i++) {
        client.fireHello()
        vi.advanceTimersByTime(1_000) // 存活 1s 即崩
        expect(client.opts.resolveClose!(ctx).retry).toBe(true)
      }
      client.fireHello()
      vi.advanceTimersByTime(1_000)
      expect(client.opts.resolveClose!(ctx).retry).toBe(false) // 第 5 次 → give-up（crash-loop 不再无限空转）
    } finally {
      vi.useRealTimers()
    }
  })

  it('R4-9: 稳定连接后连续重连失败（无 hello）达阈值 give-up（stable 基准本次连接，非历史 lastHelloAt）', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { client } = makeGateway()
      const ctxHello = { code: 1006, reason: '', generation: 0, socketOpened: true, helloReceived: true, connectRequestSent: true }
      const ctxNoHello = { code: 4402, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }
      // 稳定连接：hello + 存活 30s+ → 断开不计费（P1-6 不变）
      client.fireHello()
      vi.advanceTimersByTime(31_000)
      expect(client.opts.resolveClose!(ctxHello).retry).toBe(true)
      // 此后容器永久不可达：连续重连失败（无 hello）→ 修复前 lastHelloAt 历史让 stable 恒 true、永不计费；
      // 修复后 stable 基准本次连接（retry 重置），无 hello 的 close 累积到 give-up。
      const retries: boolean[] = []
      for (let i = 0; i < 5; i++) retries.push(client.opts.resolveClose!(ctxNoHello).retry)
      expect(retries).toEqual([true, true, true, true, false]) // 第 5 次 give-up
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- #376: 4402 有限重连预算（独立于通用传输预算；手动重连/切容器重置）----

  it('#376: 4402 预算独立于 1006 网络抖动（互不消耗；各自 ~5 次 give-up）', () => {
    const { client } = makeGateway()
    const ctx4402 = { code: 4402, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }
    const ctx1006 = { code: 1006, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }
    // 1006 网络抖动 ×4（未达 1006 预算）→ 不消耗 4402 预算
    for (let i = 0; i < 4; i++) expect(client.opts.resolveClose!(ctx1006).retry).toBe(true)
    // 4402 ×5 → 第 5 次 give-up（若 1006 掺入同一预算，总失败 5 次早已 give-up、等不到 9 次）
    const retries: boolean[] = []
    for (let i = 0; i < 5; i++) retries.push(client.opts.resolveClose!(ctx4402).retry)
    expect(retries).toEqual([true, true, true, true, false])
  })

  it('#376: PAIRING_REQUIRED / 4401 / 4403 / 4404（非传输问题）不消耗 4402 预算', () => {
    const { client } = makeGateway()
    const base = { code: 4402, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }
    // 认证/归属/改密：先行拦截 retry:false，不进入任何预算
    for (const code of [4401, 4403, 4404]) {
      expect(client.opts.resolveClose!({ ...base, code }).retry).toBe(false)
    }
    // PAIRING_REQUIRED 握手拒绝（配对中，非传输问题）
    const connError = new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'pairing required',
      gatewayCode: 'ERR_PAIRING_REQUIRED',
      details: { code: 'PAIRING_REQUIRED' },
    })
    expect(
      client.opts.resolveClose!({ ...base, code: 1000, connectFailure: { error: connError } }).retry,
    ).toBe(false)
    // 上述均未消耗预算：首个 4402 仍 retry:true（若被消耗，此处早已超预算 give-up）
    expect(client.opts.resolveClose!(base).retry).toBe(true)
  })

  it('#376: 4402 超预算 → resolveClose retry:false 且 onClose 上报（ChatView 据 code+retry 提示）', () => {
    const { client, handlers } = makeGateway()
    for (let i = 0; i < 5; i++) client.close({ code: 4402, reason: 'gateway down' })
    expect(handlers.onClose).toHaveBeenCalledTimes(5) // 每次 close 都 notify 上报
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'gateway down', false, false) // 超预算 retry:false
  })

  it('#376: 手动重连/切换容器 = 新 GatewayChat 实例 → 4402 预算重置，可再次自动重连', () => {
    const { gw: gw1, client: c1 } = makeGateway()
    const ctx = { code: 4402, reason: '', generation: 0, socketOpened: true, helloReceived: false, connectRequestSent: false }
    for (let i = 0; i < 4; i++) expect(c1.opts.resolveClose!(ctx).retry).toBe(true)
    expect(c1.opts.resolveClose!(ctx).retry).toBe(false) // gw1 第 5 次 4402 give-up
    gw1.stop()
    // ChatView openGateway 每次新建 GatewayChat（全新闭包计数）→ 预算重置
    createGatewayChat({ container: 'alpha', jwt: 'jwt-1', bootstrapToken: 'boot-1', handlers: makeHandlers() })
    const c2 = MockGatewayProtocolClient.last!
    expect(c2).not.toBe(c1)
    expect(c2.opts.resolveClose!(ctx).retry).toBe(true) // 新实例预算从零开始
  })

  it('F4: 构造带 requestTimeoutMs（RPC 有界等待，防半开连接 promise 永挂）', () => {
    const { client } = makeGateway()
    expect(client.opts.requestTimeoutMs).toBe(30_000)
  })

  it('A2: RPC 超时（CLIENT_TIMEOUT）→ 仅 reject 请求，不 teardown 整条连接（防慢请求全量重连循环）', () => {
    const { client } = makeGateway()
    client.fireRequestTiming({ errorCode: 'CLIENT_TIMEOUT' })
    expect(client.closeSocket).not.toHaveBeenCalled()
    // 非超时错误码同样不关
    client.closeSocket.mockClear()
    client.fireRequestTiming({ errorCode: 'SESSION_NOT_FOUND' })
    expect(client.closeSocket).not.toHaveBeenCalled()
  })

  it('A2/看门狗: 未 hello 前默认 tick 30s 初值 → 阈值 60s 无网关帧 → closeSocket 强制重连（黑洞自愈）；onActivity 刷新则不误杀', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      // 未注入 hello → tickIntervalMs 保持默认 30s 初值 → 阈值 60s（与旧 SILENCE_TIMEOUT_MS 等价）。
      // 刚 start：未超时
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 收到网关帧 → 刷新活动时间
      client.fireActivity()
      vi.advanceTimersByTime(45_000) // onActivity 后 45s，仍未到 60s 阈值
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 继续无帧 → 超 60s → 强制重连
      vi.advanceTimersByTime(15_001)
      expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
      gw.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('#493: 页面后台（document.hidden）期间 60s 无帧 → 看门狗不误杀；恢复可见后监测恢复', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      // 未注入 hello → 默认 tick 30s 初值 → 阈值 60s（#566 后基准跟 hello 走，未 hello 前为安全初值）。
      // Safari 后台/遮挡页节流定时器并延迟 WS 帧投递：此时「60s 无帧」是页面被后台化而非链路黑洞。
      // 等价为 document.hidden=true + 时钟照走但 onActivity 不到。看门狗不得据此 closeSocket。
      // 按 15s 巡检网格精确推进：hidden 期间 8 个巡检点（15…120s）全部跳过判定。
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      vi.advanceTimersByTime(120_000)
      expect(client.closeSocket).not.toHaveBeenCalled() // 后台 120s 无帧不误杀

      // 恢复可见：首个可见巡检点（135s）把沉默基准重置为当时（后台陈旧 gap 不计入）。
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      vi.advanceTimersByTime(15_000) // → 135s：resume 重置基准，不杀
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 监测恢复：自重置基准起满 60s 无帧 = 真黑洞，看门狗照常 closeSocket 自愈。
      // 基准=135s，再推进到 195s（45,60,75 三个巡检点过 60s 阈值线：135+60=195）。
      vi.advanceTimersByTime(45_000) // → 180s：gap 45s，未杀
      expect(client.closeSocket).not.toHaveBeenCalled()
      vi.advanceTimersByTime(15_001) // → 195.001s：gap ≥60s，触发黑洞自愈
      expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
      gw.stop()
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      vi.useRealTimers()
    }
  })

  it('#493: 后台停留超 60s 后回前台，不得因后台陈旧 gap 立即误杀（resume 须重置沉默基准）', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      client.fireActivity() // 前台存活一帧，建立基准
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      vi.advanceTimersByTime(120_000) // 后台停留 120s（时钟照走、帧不到）——不应计入沉默
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }) // 回前台
      // 回前台后首帧（resume/同步）到来前的最近一个巡检点：不得用后台陈旧 gap 立即误杀
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 恢复可见后真黑洞（60s 无帧）仍自愈
      vi.advanceTimersByTime(60_001)
      expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
      gw.stop()
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      vi.useRealTimers()
    }
  })

  it('#566: 看门狗阈值跟 hello policy.tickIntervalMs 走（10s→20s / 30s→60s / 60s→120s），每次 hello 重算用最新承诺', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      // 每轮：注入 hello（advertised tick）→ hello 帧本身刷新活动基准（协议机对任何入站帧调
      // onActivity，测试手动 fireActivity 模拟）→ 阈值前一个 15s 巡检点不杀、越线后触发。
      // 三轮 tick 递增且每轮都是新的 hello——第三轮即「重连 hello 用最新值」（网关升级改 tick）。
      // 巡检点按 15s 网格：阈值 20s → 15s(gap15<20)不杀 / 30s(gap30≥20)触发；60s → 45/60；120s → 105/120。
      const cases: Array<{ tick: number; before: number }> = [
        { tick: 10_000, before: 15_000 }, // advertised 10s → 阈值 2×=20s
        { tick: 30_000, before: 45_000 }, // advertised 30s → 阈值 2×=60s（与旧硬编码等价）
        { tick: 60_000, before: 105_000 }, // advertised 60s → 阈值 2×=120s
      ]
      for (const c of cases) {
        client.fireConnectHello({ policy: { tickIntervalMs: c.tick } }, {})
        client.fireActivity() // hello 帧刷新活动基准（基准落 15s 网格点，巡检相位可预期）
        vi.advanceTimersByTime(c.before)
        expect(client.closeSocket).not.toHaveBeenCalled()
        vi.advanceTimersByTime(15_000)
        expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
        client.closeSocket.mockClear()
      }
      gw.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('#566: 恶意超小 tickIntervalMs 钳到 1s 地板（收到帧后一个巡检周期内不误杀，防热循环）', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      // 网关 advertise 50ms（恶意/异常）→ clamp 后有效值 1s（MIN_TICK_WATCH_INTERVAL_MS 地板）→ 阈值 2s。
      client.fireConnectHello({ policy: { tickIntervalMs: 50 } }, {})
      client.fireActivity() // hello 帧刷新活动基准
      // 距基准 14s 收到一帧（刷新基准）→ 15s 巡检点 gap=1s：
      //   钳制生效（阈值 2s）→ 不误杀；未钳制（阈值=50ms*2=100ms）→ 立即误杀热循环——本断言精确区分。
      vi.advanceTimersByTime(14_000)
      client.fireActivity()
      vi.advanceTimersByTime(1_000)
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 继续无帧 → 30s 巡检点 gap=16s ≥ 2s → 真黑洞自愈（地板不影响判死能力，只防热循环）
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
      gw.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('#566: tickIntervalMs 缺失/无效一律回退 30s（阈值 60s，与旧硬编码等价）', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      // 7 种无效形态：缺 policy / policy 缺字段 / 非数 / 0 / 负数 / NaN / Infinity——守卫全部回退默认。
      const invalidHellos = [
        {},
        { policy: {} },
        { policy: { tickIntervalMs: 'abc' } },
        { policy: { tickIntervalMs: 0 } },
        { policy: { tickIntervalMs: -5 } },
        { policy: { tickIntervalMs: NaN } },
        { policy: { tickIntervalMs: Infinity } },
      ]
      for (const hello of invalidHellos) {
        const { gw, client } = makeGateway() // 每轮新实例（上轮已触发 closeSocket）
        gw.start()
        client.fireConnectHello(hello, {})
        client.fireActivity() // hello 帧刷新活动基准（基准落 15s 网格点）
        // 45s 巡检点 gap=45s < 60s：不触发（若守卫失效、无效值直接进 clamp → 钳到 1s 地板 →
        // 阈值 2s → gap45 已越线触发——本断言精确区分「回退 30s」与「误钳小值」）
        vi.advanceTimersByTime(45_000)
        expect(client.closeSocket).not.toHaveBeenCalled()
        // 60s 巡检点 gap=60s ≥ 60s → 黑洞自愈
        vi.advanceTimersByTime(15_000)
        expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
        gw.stop()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('#566+#493: 小 tick（10s→阈值 20s）下后台期间不判死；回前台后真黑洞按新阈值自愈', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const { gw, client } = makeGateway()
      gw.start()
      // 注入小 tick：阈值 20s（比旧 60s 灵敏）——#493 跳过逻辑与新基准正交叠加，后台期间照样不杀。
      client.fireConnectHello({ policy: { tickIntervalMs: 10_000 } }, {})
      client.fireActivity()
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      vi.advanceTimersByTime(60_000) // 后台 60s（gap 已远超 20s 阈值）——不误杀
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 回前台：首个可见巡检点重置基准（后台陈旧 gap 不计入）
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).not.toHaveBeenCalled()
      // 恢复可见后真黑洞（自重置基准起 ≥20s 无帧）→ 按新阈值自愈（15s 巡检点 gap=15<20 未到，
      // 30s 处 gap=30≥20 触发）
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).not.toHaveBeenCalled()
      vi.advanceTimersByTime(15_000)
      expect(client.closeSocket).toHaveBeenCalledWith(1000, 'silence timeout')
      gw.stop()
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      vi.useRealTimers()
    }
  })

  it('A3: crypto.randomUUID 不可用（非安全上下文）→ 兜底生成 requestId / 幂等 key（RPC 层不崩）', async () => {
    // 非安全上下文：crypto 存在但无 randomUUID（jsdom 有 getRandomValues）——A3 修复用
    // getRandomValues 兜底（32-hex），不依赖 Math.random 坍缩路径
    vi.stubGlobal('crypto', { getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7) % 256; return arr } } as unknown as Crypto)
    try {
      const { gw, client } = makeGateway()
      client.request.mockResolvedValue({})
      // send 的幂等 key 走 createRequestId 兜底（不抛 TypeError）
      await expect(gw.send('sk-1', 'hi')).resolves.toBeUndefined()
      expect(client.request).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      )
      const params = client.request.mock.calls[0][1] as { idempotencyKey: string }
      // P2-4（code review）：兜底路径也须 32-hex（原 Math.random 兜底 ~30 位 base36，违反自钉契约
      // /^[a-z0-9]{32}$/ 且跨路径与 randomUUID 格式不一致）
      expect(params.idempotencyKey).toMatch(/^[a-z0-9]{32}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('P2-4: getRandomValues 兜底产出 32-hex（无 randomUUID 时 createSession/send 幂等 key 同格式）', async () => {
    // 只去掉 randomUUID（保留 getRandomValues）——A3 测试已覆盖兜底路径
    const cryptoNoUUID = {
      getRandomValues: (arr: Uint8Array) => {
        // 真实随机填充（确定性 mock 会让两次调用产出同 key，无法断言不碰撞）
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
        return arr
      },
    } as unknown as Crypto
    vi.stubGlobal('crypto', cryptoNoUUID)
    try {
      const { gw, client } = makeGateway()
      client.request.mockResolvedValue({ key: 'sk-new' })
      await gw.createSession()
      await gw.send('sk-1', 'hi')
      const createKey = (client.request.mock.calls[0][1] as { key: string }).key
      const sendKey = (client.request.mock.calls[1][1] as { idempotencyKey: string }).idempotencyKey
      expect(createKey).toMatch(/^[a-z0-9]{32}$/)
      expect(sendKey).toMatch(/^[a-z0-9]{32}$/) // 跨路径统一 32-hex
      expect(createKey).not.toBe(sendKey) // 不同调用不同 key（不碰撞）
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('F10: 握手超时 ≥ 隧道侧网关连接超时（server CONNECT_TIMEOUT_MS=5000）+ 余量', () => {
    const { client } = makeGateway()
    expect(client.opts.handshake).toMatchObject({ mode: 'require-challenge' })
    expect((client.opts.handshake as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(5000)
  })

  it('onConnectError → handlers.onError（传输级错误上报）', () => {
    const { client, handlers } = makeGateway()
    client.connectError('WebSocket connection failed: ECONNREFUSED')
    expect(handlers.onError).toHaveBeenCalledWith('WebSocket connection failed: ECONNREFUSED')
  })

  it('listSessions → sessions.list RPC + 响应校准（key/derivedTitle/updatedAt，跳过非法项）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({
      sessions: [
        { key: 's1', derivedTitle: '标题', updatedAt: '2026-08-04' },
        { sessionKey: 's2' },
        { key: 123 },
        'not-a-dict',
      ],
    })
    const list = await gw.listSessions()
    expect(client.request).toHaveBeenCalledWith('sessions.list', { includeDerivedTitles: true })
    expect(list).toEqual([
      { session_key: 's1', title: '标题', updated_at: '2026-08-04' },
      { session_key: 's2', title: '', updated_at: '' },
    ])
  })

  it('createSession → sessions.create（幂等 key + label）+ 返回网关 key', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ key: 'new-session-key' })
    await expect(gw.createSession('我的会话')).resolves.toBe('new-session-key')
    expect(client.request).toHaveBeenCalledWith('sessions.create', expect.objectContaining({ label: '我的会话' }))
    const params = client.request.mock.calls[0][1] as { key: string }
    expect(params.key).toMatch(/^[a-z0-9]{32}$/) // 幂等 key 为 hex uuid
  })

  it('createSession 网关未返回 key → 抛错', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await expect(gw.createSession()).rejects.toThrow('会话创建失败')
  })

  it('deleteSession → sessions.delete{key}（不带 archivedOnly——网关对未归档会话恒拒，P0）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.deleteSession('sk-1')
    // P0 回归：恒带 archivedOnly:true 让所有正常会话删除被网关 INVALID_REQUEST 拒绝
    expect(client.request).toHaveBeenCalledWith('sessions.delete', { key: 'sk-1' })
  })

  it('getHistory → chat.history{sessionKey,limit?,messageId?} + 响应校准（messages 过滤非 dict、分页字段）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({
      messages: [{ role: 'assistant', text: 'a' }, 'skip-me'],
      hasMore: true,
      nextOffset: 5,
    })
    const h = await gw.getHistory('sk-1', 20, 'mid-9')
    expect(client.request).toHaveBeenCalledWith('chat.history', { sessionKey: 'sk-1', limit: 20, messageId: 'mid-9' })
    expect(h).toEqual({ messages: [{ role: 'assistant', text: 'a' }], hasMore: true, nextOffset: 5 })
  })

  it('getHistory 缺省分页字段 → 回退', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ messages: [] })
    const h = await gw.getHistory('sk-1')
    expect(h).toEqual({ messages: [], hasMore: false, nextOffset: null })
  })

  it('send → chat.send{sessionKey,message,idempotencyKey}', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.send('sk-1', '你好')
    expect(client.request).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'sk-1',
      message: '你好',
      idempotencyKey: expect.any(String),
    })
  })

  // ---- #564: 幂等 key 外注（重发复用原 id 经网关幂等去重，防转录双跑）----

  it('#564: send 外部传入 idempotencyKey 优先（重发复用 OutboxItem.id）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ runId: 'r1' })
    await gw.send('sk-1', '你好', undefined, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
    expect(client.request).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'sk-1',
      message: '你好',
      idempotencyKey: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
  })

  it('#564: send 缺省 idempotencyKey 仍内部生成（既有行为回归）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.send('sk-1', '你好')
    const params = client.request.mock.calls[0][1] as { idempotencyKey: string }
    expect(params.idempotencyKey).toMatch(/^[a-z0-9]{32}$/)
  })

  // ---- #459-T1 #462：chat.send 携带官方 attachments 字段 ----

  it('#462: send 带 attachments → payload 含官方字段形状数组', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    const atts = [
      { type: 'image', mimeType: 'image/png', fileName: 'shot.png', content: 'base64...', sizeBytes: 1234, width: 800, height: 600 },
      { type: 'audio', mimeType: 'audio/mpeg', fileName: 'voice.mp3', content: 'base64...' },
    ]
    await gw.send('sk-1', '看这张图', atts)
    expect(client.request).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'sk-1',
      message: '看这张图',
      idempotencyKey: expect.any(String),
      attachments: atts,
    })
  })

  it('#462: send 不带 attachments → payload 无 attachments 字段（回归无差）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.send('sk-1', '你好')
    const params = client.request.mock.calls[0][1] as Record<string, unknown>
    expect(params).not.toHaveProperty('attachments')
  })

  it('#462: send attachments 为空数组 → payload 无 attachments 字段（不带附件输入时不携带）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    await gw.send('sk-1', '你好', [])
    const params = client.request.mock.calls[0][1] as Record<string, unknown>
    expect(params).not.toHaveProperty('attachments')
  })

  it('#462: send 纯附件（无文本）→ message 为空字符串仍带 attachments（US15 纯图片消息）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({})
    const atts = [{ type: 'image', mimeType: 'image/png', fileName: 'only.png', content: 'base64...' }]
    await gw.send('sk-1', '', atts)
    expect(client.request).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'sk-1',
      message: '',
      idempotencyKey: expect.any(String),
      attachments: atts,
    })
  })

  it('listCommands → commands.list + 响应校准（textAliases 缺省回退 /name）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({
      commands: [
        { name: 'model', description: '切换模型', textAliases: ['/model', '/m'] },
        { name: 'plain', description: '无别名' },
        { name: 7 },
      ],
    })
    const list = await gw.listCommands()
    expect(client.request).toHaveBeenCalledWith('commands.list', {})
    expect(list).toEqual([
      { name: 'model', description: '切换模型', aliases: ['/model', '/m'] },
      { name: 'plain', description: '无别名', aliases: ['/plain'] },
    ])
  })

  it('resolveApproval → {kind}.approval.resolve，params 仅 id/decision（kind 派生 method 名）', async () => {
    const { gw, client } = makeGateway()
    client.request.mockResolvedValue({ applied: true, approval: {} })
    await gw.resolveApproval('ap-1', 'exec', 'allow-once')
    expect(client.request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'ap-1',
      decision: 'allow-once',
    })
    await gw.resolveApproval('ap-2', 'plugin', 'deny')
    expect(client.request).toHaveBeenLastCalledWith('plugin.approval.resolve', {
      id: 'ap-2',
      decision: 'deny',
    })
  })
})

describe('#377 设备配对生命周期（GatewayBrowserDeviceAuthLifecycle 接线 + 自动 approve 编排）', () => {
  beforeEach(() => {
    // clearAllMocks 不清 mockImplementation——重置 approve 默认实现为 resolve（挂起/拒绝由测试覆盖），
    // 防跨测试泄漏（如「切容器已 stop」的挂起 promise 实现污染后续测试）。
    ;(approvePairing as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ status: 'paired' }))
  })

  function pairingError(requestId: string) {
    return new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'pairing required',
      gatewayCode: 'ERR_PAIRING_REQUIRED',
      details: { code: 'PAIRING_REQUIRED', requestId },
    })
  }

  it('已配对重连：hasStoredDeviceToken=true 不传 token 凭证 → lifecycle 返回 deviceToken → buildConnectParams 透传 auth.deviceToken（不再走 bootstrap）', async () => {
    const { client } = makeGateway()
    // 真网关适配凭证选择：已配对（tokenStore 有 deviceToken）→ gatewayChat 不传 token/bootstrapToken
    // 凭证，交官方 lifecycle 从 tokenStore 选 deviceToken（buildPlan 参数无 token/bootstrapToken）。
    vi.mocked(hasStoredDeviceTokenFor).mockResolvedValueOnce(true)
    MockLifecycle.buildPlan.mockResolvedValueOnce({
      clientId: 'openclaw-control-ui',
      role: 'operator',
      identity: { deviceId: 'dev-1', publicKey: 'pk-1', sign: vi.fn() },
      selectedAuth: { usingStoredDeviceToken: true },
      scopes: ['operator.read'],
      auth: { deviceToken: 'dt-1' },
    })
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
    expect(MockLifecycle.buildPlan).toHaveBeenCalledWith(
      expect.not.objectContaining({ token: expect.anything(), bootstrapToken: expect.anything() }),
    )
    expect(plan).toMatchObject({ auth: { deviceToken: 'dt-1' } })
    const params = client.opts.buildConnectParams!(plan)
    expect(params).toMatchObject({ auth: { deviceToken: 'dt-1' } })
    expect((params as { auth: { token?: string } }).auth.token).toBeUndefined()
  })

  it('onConnectHello → lifecycle.acceptHello（hello-ok 下发 deviceToken 持久化）', async () => {
    const { client } = makeGateway()
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
    client.fireConnectHello({ auth: { deviceToken: 'dt-1', role: 'operator', scopes: [] } }, plan)
    expect(MockLifecycle.acceptHello).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ deviceToken: 'dt-1' }) }),
      expect.objectContaining({ clientId: 'openclaw-control-ui', role: 'operator' }),
    )
  })

  it('hello 无 deviceToken / 本连接无身份 → acceptHello 不调（不标记配对完成，预算保留）', async () => {
    const { client } = makeGateway()
    // 本连接无设备身份（storage 不可用降级）→ buildPlan 返回 identity: null
    MockLifecycle.buildPlan.mockResolvedValueOnce({
      clientId: 'openclaw-control-ui',
      role: 'operator',
      identity: null,
      selectedAuth: {},
      scopes: ['operator.read'],
      auth: { token: 'boot-1' },
    })
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
    // hello-ok 不带 deviceToken（异常网关）→ 不持久化、不标记配对完成
    client.fireConnectHello({ auth: { role: 'operator', scopes: [] } }, plan)
    expect(MockLifecycle.acceptHello).not.toHaveBeenCalled()
    // 配对预算未被 hello 重置/配对状态未完成 → 再遇 PAIRING_REQUIRED 仍自动 approve
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-3') } })
    await vi.waitFor(() => expect(approvePairing).toHaveBeenCalledWith('alpha', 'req-3'))
  })

  it('未配对首连：PAIRING_REQUIRED{requestId} → 自动 approve → 重连；onClose 不报 pairingRequired（编排接管）', async () => {
    const { client, handlers } = makeGateway()
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-1') } })
    await vi.waitFor(() => expect(approvePairing).toHaveBeenCalledWith('alpha', 'req-1'))
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled()) // approve 已落库 → 重连（bootstrap 首连）
    expect(handlers.onClose).not.toHaveBeenCalled() // 配对编排进行中不向 UI 报 pairingRequired
  })

  it('approve 失败（HTTP 错误）→ 报 pairingRequired=true（转 UI 手动处理），不自动重连', async () => {
    const { client, handlers } = makeGateway()
    ;(approvePairing as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('approve failed'))
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-1') } })
    await vi.waitFor(() => expect(handlers.onClose).toHaveBeenLastCalledWith(1000, 'closed(1008)', false, true))
    expect(client.start).not.toHaveBeenCalled()
  })

  it('配对完成后 onClose 不再报 pairingRequired（配对状态已清除）', async () => {
    const { client, handlers } = makeGateway()
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
    client.fireConnectHello({ auth: { deviceToken: 'dt-1', role: 'operator', scopes: [] } }, plan)
    // 配对完成后连接断开（非配对原因）→ pairingRequired 恒 false
    client.close({ code: 4402, reason: 'gateway down' })
    expect(handlers.onClose).toHaveBeenLastCalledWith(4402, 'gateway down', true, false)
  })

  it('deviceToken 失效（网关重置）：paired 后 PAIRING_REQUIRED → clearStoredToken 清失效 token + 自动重配对', async () => {
    const { client, handlers } = makeGateway()
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
    client.fireConnectHello({ auth: { deviceToken: 'dt-1', role: 'operator', scopes: [] } }, plan)
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-2') } })
    await vi.waitFor(() => expect(MockLifecycle.clearStoredToken).toHaveBeenCalled())
    await vi.waitFor(() => expect(approvePairing).toHaveBeenCalledWith('alpha', 'req-2'))
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it('切容器已 stop()：approve 在途 → 不重建已停协议机的连接（防 ws 泄漏）', async () => {
    const { gw, client } = makeGateway()
    let resolveApprove!: (v: { status: string }) => void
    ;(approvePairing as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolveApprove = resolve }),
    )
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-1') } })
    await vi.waitFor(() => expect(approvePairing).toHaveBeenCalled())
    gw.stop() // 切容器：旧 gateway 停用
    resolveApprove({ status: 'paired' })
    await vi.waitFor(() => expect(client.start).not.toHaveBeenCalled()) // 不重建已停连接
  })

  it('配对预算用尽（approve 反复无效）→ 停止自动配对，报 pairingRequired（防无限循环）', async () => {
    const { client, handlers } = makeGateway()
    // 连续 3 次 PAIRING_REQUIRED（approve 成功但网关仍拒 → 重连又被拒），消耗配对预算
    for (let i = 0; i < 3; i++) {
      client.close({ code: 1000, reason: 'x', connectFailure: { error: pairingError('req-1') } })
      await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
      client.start.mockClear()
    }
    // 第 4 次：预算用尽 → 不再自动 approve/重连，转 UI 手动处理
    client.close({ code: 1000, reason: 'x', connectFailure: { error: pairingError('req-1') } })
    await vi.waitFor(() => expect(handlers.onClose).toHaveBeenLastCalledWith(1000, 'x', false, true))
    expect(client.start).not.toHaveBeenCalled()
  })

  // ---- 多容器配对 bug 二段修复（生产实锤 gamma）：token MISMATCH 自愈 ----
  // 根因：断连重连用失效 deviceToken → 网关 AUTH_DEVICE_TOKEN_MISMATCH（NON_RECOVERABLE，官方
  // retry:false）→ 面板 onClose 只捕获 PAIRING_REQUIRED，对 token-mismatch 无分支 → 落 retry:false
  // → useChatConnection 显示「自动重连已停止，请手动重连」（连接即停）。
  // 修复：onClose 识别 AUTH_DEVICE_TOKEN_MISMATCH / AUTH_TOKEN_MISMATCH → 清失效 token → client.start()
  // 重连（bootstrap 首连 → PAIRING_REQUIRED → 既有自动配对编排闭环），复用配对预算防无限循环。
  function tokenMismatchError(code: 'AUTH_DEVICE_TOKEN_MISMATCH' | 'AUTH_TOKEN_MISMATCH') {
    return new MockGatewayProtocolRequestError({
      code: 'connect',
      message: 'device token mismatch',
      gatewayCode: 'ERR_UNAUTHORIZED',
      details: { code },
    })
  }

  // 辅助：先调 buildConnectPlan 让 gatewayChat 缓存 lastAuthPlan（recoverTokenMismatch/runAutoPairing
  // 的 clearStoredToken 依赖它）——对齐既有 PAIRING 测试在 hello/close 前调 plan 的模式。
  async function primeAuthPlan(client: InstanceType<typeof MockGatewayProtocolClient>) {
    await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
  }

  it('MISMATCH 自愈：AUTH_DEVICE_TOKEN_MISMATCH → 清失效 token + 重连，onClose 不报连接即停', async () => {
    const { client, handlers } = makeGateway()
    await primeAuthPlan(client)
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_DEVICE_TOKEN_MISMATCH') } })
    await vi.waitFor(() => expect(MockLifecycle.clearStoredToken).toHaveBeenCalled())
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled()) // 清 token 后 bootstrap 重连（→ PAIRING_REQUIRED 编排）
    expect(handlers.onClose).not.toHaveBeenCalled() // 自愈进行中不向 UI 报「连接即停」
  })

  // ---- #567 行为变化点（标红，PR 明示）：AUTH_TOKEN_MISMATCH 从「clearStoredToken + start 自愈」
  // 改为官方单次重试机制（onConnectFailure → shouldRetryGatewayWithDeviceToken → resolveClose retry
  // → 协议机自动重连重发旧 token），非等价重构。_DEVICE_ 变体保留自愈闭环（V3，下方既有用例回归）。
  // #567 V1–V6 实证用例（规格 §五）：shouldRetryGatewayWithDeviceToken 用真实 SDK 实现（vi.mock
  // 部分替换保留原导出），断言走协议机接缝（fireConnectFailure + resolveClose + buildConnectPlan）。
  // 规格缝隙（PR 明示）：V1 的「storedToken + bootstrap 并存」场景在当前凭证选择下生产不可达——
  // hasStoredDeviceTokenFor 与 lifecycle tokenStore 同源同键（deviceAuth.ts：同一
  // createContainerTokenStore + loadDeviceIdentity）：有 storedToken ⟺ stored 判定 true ⟺ 不传
  // bootstrap token。故 shouldRetry 恒被硬门拒、AUTH_TOKEN_MISMATCH 生产恒落 R2 兜底（规格 §四 R2
  // 既定路径，行为与改造前等价）；V1/V2 手工拼 plan 验证的是机制接线本身（未来凭证选择变化——如
  // 显式 deviceToken / scope 升级——时该通道即生效，此即行为契约）。
  it('#567 行为变化点: AUTH_TOKEN_MISMATCH（有 storedToken + bootstrap，预算未用）→ 官方单次重试：onConnectFailure 置 pending → resolveClose retry:true → 重连 buildPlan 带 pendingDeviceTokenRetry（重发旧 token），不再经 clearStoredToken/recoverTokenMismatch', async () => {
    const { client, handlers } = makeGateway()
    // 首连 plan：本次 connect 带显式 bootstrap token（explicitBootstrapToken='boot-1'）+ 本地有持久化
    // 旧 deviceToken（selectedAuth.storedToken='dt-1'）——网关对 bootstrap token 回 AUTH_TOKEN_MISMATCH
    //（token 失同步）。真实 SDK shouldRetry：硬门全过（预算未用/无 currentDeviceToken/有 explicit/
    // 有 storedToken/trusted）→ 错误码 AUTH_TOKEN_MISMATCH 命中触发集 → true。
    const plan = {
      ...((await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })) as object),
      selectedAuth: { storedToken: 'dt-1' },
    }
    // 协议机时序：connect request reject → onConnectFailure（shouldRetry 判定 → pending 置位）→
    // socket close(1008) → resolveClose → onClose
    // 返回 SDK 默认 connect 失败决策（与未接该回调时协议机 ?? 兜底逐字节一致，socket 关法不变）
    expect(client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)).toEqual({
      closeCode: 1008,
      closeReason: 'connect failed',
    })
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_TOKEN_MISMATCH') } })
    // resolveClose 读 pendingDeviceTokenRetry → SDK shouldPause 对 AUTH_TOKEN_MISMATCH 返 false →
    // retry:true（协议机自动重连，UI 显示「自动重连中」而非连接即停）
    expect(handlers.onClose).toHaveBeenLastCalledWith(1000, 'closed(1008)', true, false)
    // 不落自愈闭环：不清 storedToken、不 client.start（重连由协议机自动完成）
    expect(MockLifecycle.clearStoredToken).not.toHaveBeenCalled()
    expect(client.start).not.toHaveBeenCalled()
    // 协议机自动重连 → buildConnectPlan：pendingDeviceTokenRetry 传给 lifecycle（触发 SDK
    // selectGatewayConnectAuth 的「重发旧 token」通道 authDeviceToken: storedToken），一次性消费后清位
    await client.opts.buildConnectPlan!({ nonce: 'n2', generation: 2 })
    expect(MockLifecycle.buildPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({ pendingDeviceTokenRetry: true, trustedDeviceTokenRetry: true }),
    )
  })

  it('#567 V2: AUTH_TOKEN_MISMATCH 重发一次后仍 MISMATCH（预算用尽）→ shouldRetry 拒绝 → R2 兜底 recoverTokenMismatch（清 token → bootstrap 重连）', async () => {
    const { client, handlers } = makeGateway()
    await primeAuthPlan(client)
    const plan = {
      ...((await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })) as object),
      selectedAuth: { storedToken: 'dt-1' },
    }
    // ① 第一次：官方单次重试通道（deviceTokenRetryBudgetUsed 置位）
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    client.close({ code: 1000, reason: 'x', connectFailure: { error: tokenMismatchError('AUTH_TOKEN_MISMATCH') } })
    expect(handlers.onClose).toHaveBeenLastCalledWith(1000, 'x', true, false) // 协议机自动重连
    // ② 协议机重连 → buildConnectPlan 消费 pending（一次性，重发旧 token）
    await client.opts.buildConnectPlan!({ nonce: 'n2', generation: 2 })
    expect(MockLifecycle.buildPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({ pendingDeviceTokenRetry: true }),
    )
    // ③ 第二次 connect 仍被拒（重发旧 token 无效）：shouldRetry 因 retryBudgetUsed 拒绝 → pending
    // 不置位 → shouldPause 判终端 → resolveClose retry:false → onClose 落 R2 兜底 recoverTokenMismatch
    handlers.onClose.mockClear()
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    client.close({ code: 1000, reason: 'x', connectFailure: { error: tokenMismatchError('AUTH_TOKEN_MISMATCH') } })
    expect(handlers.onClose).not.toHaveBeenCalled() // 自愈进行中不向 UI 报连接即停
    await vi.waitFor(() => expect(MockLifecycle.clearStoredToken).toHaveBeenCalled())
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
  })

  it('#567 V4: hello 成功无条件清零单次重发预算（无 deviceToken 的 hello 也清——非 acceptHello-gated；pairingAttempts 清零仍 gated，二者独立）', async () => {
    const { client } = makeGateway()
    const plan = {
      ...((await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })) as object),
      selectedAuth: { storedToken: 'dt-1' },
    }
    const ctx = { code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_TOKEN_MISMATCH') } }
    // ① 触发一次重试：预算用掉（pending + budgetUsed 置位）
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
    // ② hello 成功（不带 deviceToken——无条件清零，对齐官方 handleConnectHello；若 acceptHello-gated
    // 则此处不清，③ 的 shouldRetry 会因预算用尽被拒 → retry:false，本断言精确区分）
    client.fireConnectHello({ policy: {} }, plan)
    // ③ 预算已清：再遇 AUTH_TOKEN_MISMATCH 重新可重试（满预算单次重发）
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
  })

  it('#567 V5: AUTH_TOKEN_MISMATCH 无 storedToken（从未配对）→ shouldRetry 硬门拒绝 → R2 兜底 recoverTokenMismatch', async () => {
    const { client, handlers } = makeGateway()
    await primeAuthPlan(client)
    // mock 默认 plan.selectedAuth={}（无 storedToken）→ 真实 SDK shouldRetry 的 !storedToken 硬门拒绝
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_TOKEN_MISMATCH') } })
    await vi.waitFor(() => expect(MockLifecycle.clearStoredToken).toHaveBeenCalled())
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
    expect(handlers.onClose).not.toHaveBeenCalled() // 自愈进行中不向 UI 报连接即停
  })
  // #567 V3（_DEVICE_ 回归网：上方「MISMATCH 自愈：AUTH_DEVICE_TOKEN_MISMATCH」用例不动，触发码收窄
  // 后 _DEVICE_ 仍走 recoverTokenMismatch）+ V6（凭证选择回归：首连 token / 已配对 deviceToken 用例
  // 不动）由既有用例保持绿承担，此处不重复。

  it('#567: start()/stop() 重置单次重发预算（规格 §三 重置点——手动重连/切容器后重新满预算）', async () => {
    const { gw, client } = makeGateway()
    const plan = {
      ...((await client.opts.buildConnectPlan!({ nonce: 'n', generation: 1 })) as object),
      selectedAuth: { storedToken: 'dt-1' },
    }
    const ctx = { code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_TOKEN_MISMATCH') } }
    // ① 触发一次重试：预算用掉
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
    // ② stop() 清预算（若不清，③ 的 shouldRetry 会因预算用尽被拒 → retry:false）
    gw.stop()
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
    // ③ start() 同样重置（同实例手动重连）
    gw.start()
    client.fireConnectFailure(tokenMismatchError('AUTH_TOKEN_MISMATCH'), plan)
    expect(client.opts.resolveClose!(ctx).retry).toBe(true)
    gw.stop() // 清理看门狗定时器
  })

  it('MISMATCH 自愈后重连遇 PAIRING_REQUIRED → 走既有自动配对编排（approve → 重连）', async () => {
    const { client } = makeGateway()
    await primeAuthPlan(client)
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_DEVICE_TOKEN_MISMATCH') } })
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
    client.start.mockClear()
    // 清 token 后 bootstrap 重连 → 网关 PAIRING_REQUIRED → 既有自动配对编排接管
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-new') } })
    await vi.waitFor(() => expect(approvePairing).toHaveBeenCalledWith('alpha', 'req-new'))
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
  })

  it('MISMATCH 反复（清 token 重连仍 MISMATCH）达预算 → 停止自愈，报连接即停（防无限循环）', async () => {
    const { client, handlers } = makeGateway()
    await primeAuthPlan(client)
    for (let i = 0; i < 3; i++) {
      client.close({ code: 1000, reason: 'x', connectFailure: { error: tokenMismatchError('AUTH_DEVICE_TOKEN_MISMATCH') } })
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(i + 1))
    }
    // 第 4 次：预算用尽 → 不再自愈，转 UI 手动重连（连接即停）
    client.close({ code: 1000, reason: 'x', connectFailure: { error: tokenMismatchError('AUTH_DEVICE_TOKEN_MISMATCH') } })
    await vi.waitFor(() => expect(handlers.onClose).toHaveBeenLastCalledWith(1000, 'x', false, false))
    expect(client.start).toHaveBeenCalledTimes(3)
  })

  // 真实时序回归（advisor 复核要求·锁死预算语义防回归）：pairingAttempts 由 onConnectHello 在
  // acceptHello 成功（hello 带 deviceToken）后清零——onHello（无 token 的中间握手）不清。故：
  //   恢复成功（最终拿到 token）→ 预算清 0，下次 MISMATCH 可重新自愈（满预算）；
  //   恢复持续失败（永远拿不到 token）→ 预算不被中途 hello 误清，达阈值 give-up。
  it('真实时序：MISMATCH→自愈→PAIRING→approve→hello-ok带token→acceptHello成功 → 预算清0，可再次满预算自愈', async () => {
    const { client } = makeGateway()
    await primeAuthPlan(client)
    // ① MISMATCH → 自愈（清 token + 重连），budget=1
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: tokenMismatchError('AUTH_DEVICE_TOKEN_MISMATCH') } })
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1))
    // ② 中间握手 onHello（无 token）——不得清预算（否则 budget 永不到阈值、无 give-up 上限）
    client.fireHello()
    // ③ bootstrap 重连遇 PAIRING_REQUIRED → 既有编排 approve → 重连，budget=2
    client.start.mockClear()
    client.close({ code: 1000, reason: 'closed(1008)', connectFailure: { error: pairingError('req-final') } })
    await vi.waitFor(() => expect(approvePairing).toHaveBeenCalledWith('alpha', 'req-final'))
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
    // ④ approve 后 hello-ok 带新 deviceToken → acceptHello 成功 → 预算清 0（恢复彻底完成）
    const plan = await client.opts.buildConnectPlan!({ nonce: 'n', generation: 2 })
    client.fireConnectHello({ auth: { deviceToken: 'dt-new', role: 'operator', scopes: [] } }, plan)
    await vi.waitFor(() => expect(MockLifecycle.acceptHello).toHaveBeenCalled())
    // ⑤ 预算已清 0：再次 MISMATCH → 重新满预算自愈（不是「只剩 1 次」）——连续 3 次才 give-up
    for (let i = 0; i < 3; i++) {
      client.close({ code: 1000, reason: 'x', connectFailure: { error: tokenMismatchError('AUTH_DEVICE_TOKEN_MISMATCH') } })
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(2 + i))
    }
  })
})
