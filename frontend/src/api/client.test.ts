// seam: API client —— JWT 拦截 + 401 刷新重试/跳登录（spec §9.1）。
// 出处：docs/FULLSTACK-REFACTOR-SPEC.md §9.1（API client 封装 JWT 拦截器，401 刷新/跳登录）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { apiFetch, apiJson, ApiError } from '@/api/client'

// 默认 application/json（后端信封响应经 res.json() 恒带该头）；非 JSON 场景（二进制 PNG 等）
// 传第三个参数覆盖。apiFetch 现在对 HTTP 200 按 Content-Type 决定是否做信封 sniff——mock 须建模
// 真实响应头，否则 JSON 信封测试会误走「非 JSON → 跳过 sniff」分支。
function mockResp(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response
}

// 未过期 JWT（exp 远大于现在）：header.payload.signature，payload 仅含 exp
function liveToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/=+$/, '')
  return `h.${payload}.s`
}

describe('api client', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  it('attaches JWT Bearer header when authenticated', async () => {
    useAuthStore().token = 'tok-abc'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('[]'))
    await apiFetch('/api/v1/x')
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer tok-abc')
  })

  it('omits Authorization header when no token', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('{}'))
    await apiFetch('/api/v1/x')
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Headers).get('Authorization')).toBeNull()
  })

  it('sets JSON Content-Type when a body is present', async () => {
    useAuthStore().token = 't'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('{}'))
    await apiFetch('/api/v1/x', { method: 'POST', body: '{"a":1}' })
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json')
  })

  it('refreshes via cookie and retries once on 401 (codex R2 :26)', async () => {
    // access 过期但 httpOnly refresh cookie 仍有效：hydrate 换新后须用新 token 重试成功，
    // 而非清会话干等用户手动刷新（单受保护路由下 guard 不会再次 hydrate）。
    const auth = useAuthStore()
    auth.token = 'expired-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp('', 401)) // 原请求 401
      .mockResolvedValueOnce(mockResp({ access: liveToken() }, 200)) // refresh 成功
      .mockResolvedValueOnce(mockResp('[]', 200)) // 重试成功
    const resp = await apiFetch('/api/v1/x')
    expect(resp.status).toBe(200)
    expect(auth.token).not.toBe('expired-access')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 重试用的是 refresh 换到的新 token
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).toBe(`Bearer ${auth.token}`)
  })

  it('forces refresh before retrying a locally unexpired token rejected with 401 (codex R5 :34)', async () => {
    const auth = useAuthStore()
    const rejectedToken = liveToken()
    const refreshedToken = `${liveToken()}-refreshed`
    auth.token = rejectedToken
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp('', 401))
      .mockResolvedValueOnce(mockResp({ access: refreshedToken }, 200))
      .mockResolvedValueOnce(mockResp('[]', 200))

    const resp = await apiFetch('/api/v1/x')

    expect(resp.status).toBe(200)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/token/refresh')
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).not.toBe(`Bearer ${rejectedToken}`)
  })

  it('clears session, redirects, and throws when refresh also fails on 401', async () => {
    const auth = useAuthStore()
    auth.token = 'expired-access'
    // 原请求 + refresh 全 401：refresh 端点确认 cookie 失效 → 清会话 + 跳登录 + 抛错
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('', 401))
    const assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', assign: assignSpy },
    })
    await expect(apiFetch('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
    expect(auth.token).toBe('')
    expect(assignSpy).toHaveBeenCalledWith('/login')
  })

  it('preserves session and stays on page on transient refresh failure (codex R8 F2)', async () => {
    // access 401 但 refresh 请求遇 5xx（auth 服务临时中断）：httpOnly refresh cookie 仍可能有效，
    // forceRefresh 已对 5xx/网络异常不标 refreshExhausted。apiFetch 不得因此清会话/跳登录踢人——
    // 须区分「确认拒绝（refreshExhausted）」与「瞬态失败」，后者仅抛错保留重试机会。
    const auth = useAuthStore()
    auth.token = 'expired-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp('', 401)) // 原请求 401
      .mockResolvedValueOnce(mockResp('', 503)) // refresh 瞬态 5xx（非 4xx 确认拒绝）
    const assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', assign: assignSpy },
    })

    await expect(apiFetch('/api/v1/x')).rejects.toBeInstanceOf(ApiError)

    expect(assignSpy).not.toHaveBeenCalled() // 不跳登录（会话可能仍有效）
    expect(auth.refreshExhausted).toBe(false) // 瞬态失败不标耗尽
    expect(fetchMock).toHaveBeenCalledTimes(2) // 原请求 + refresh；无 token 不重试
  })

  it('apiJson returns parsed body on 2xx', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ a: 1 }))
    expect(await apiJson<{ a: number }>('/x')).toEqual({ a: 1 })
  })

  it('apiJson resolves undefined on 204 No Content empty body (#419-5)', async () => {
    // 204 空体 resp.json() 会 reject（No Content 语义）——apiJson 须短路返回，不读 body。
    // 断言 json 未被调用：实现若仍调 json()（即便 catch 兜底）本用例即失败。
    const jsonSpy = vi.fn().mockRejectedValue(new Error('json should not be called on 204'))
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 204,
      ok: true,
      json: jsonSpy,
    } as unknown as Response)
    expect(await apiJson<void>('/x')).toBeUndefined()
    expect(jsonSpy).not.toHaveBeenCalled()
  })

  it('apiJson throws ApiError with backend detail on non-2xx', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ detail: '非法 name' }, 400),
    )
    await expect(apiJson('/x')).rejects.toThrow('非法 name')
  })

  it('apiJson throws ApiError with envelope code on HTTP 200 business error（#312 信封）', async () => {
    // P0 回归：TS 后端错误恒 HTTP 200 + {code,message,data}——apiJson 不得把信封错误当成功透传
    // （旧实现只按 resp.ok 判错 → 20040/401 分支全成死代码，用户看到内部错误文案）。
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 20040, message: '容器不存在或无权访问', data: null }),
    )
    await expect(apiJson('/api/v1/containers/x/bootstrap-token')).rejects.toMatchObject({
      code: 20040,
      status: 200,
    } as ApiError)
  })

  it('apiFetch refreshes and retries on HTTP 200 envelope 10001（吊销 token 走刷新链）', async () => {
    // P0 回归：token 吊销时 server 以 HTTP 200 + {code:10001} 拒业务请求（#312 信封）——apiFetch
    // 须与 HTTP 401 同语义触发刷新链，否则刷新/跳登录永不触发、用户留在原地。
    const auth = useAuthStore()
    auth.token = 'revoked-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp({ code: 10001, message: '未认证', data: null }))
      .mockResolvedValueOnce(mockResp({ access: liveToken() }, 200)) // refresh 成功
      .mockResolvedValueOnce(mockResp({ code: 0, message: 'ok', data: [] })) // 重试成功
    const resp = await apiFetch('/api/v1/containers/')
    expect(resp.status).toBe(200)
    expect(auth.token).not.toBe('revoked-access')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 重试用的是 refresh 换到的新 token
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).toBe(`Bearer ${auth.token}`)
  })

  it('apiFetch redirects to login when envelope 10001 + refresh exhausted', async () => {
    const auth = useAuthStore()
    auth.token = 'revoked-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    // 业务请求被拒（HTTP 200 + 10001，token 吊销）→ 触发刷新链；refresh 端点确认失效（10003，
    // #370 评论 52：仅此码置 refreshExhausted——server refresh 端点只可能返回 10003/90000/90002）
    fetchMock
      .mockResolvedValueOnce(mockResp({ code: 10001, message: '未认证', data: null }))
      .mockResolvedValueOnce(mockResp({ code: 10003, message: '刷新凭证无效', data: null }))
    const assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', assign: assignSpy },
    })
    await expect(apiFetch('/api/v1/containers/')).rejects.toMatchObject({ status: 401 } as ApiError)
    expect(assignSpy).toHaveBeenCalledWith('/login')
  })

  it('apiJson passes non-envelope 2xx body through（兜底）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([1, 2, 3]))
    expect(await apiJson<number[]>('/legacy')).toEqual([1, 2, 3])
  })

  // PR #370 第四轮 R4-1（P0）：TS 后端 #312 信封 {code:0,message,data} 下，apiJson 成功时必须
  // 解包 data 返回业务载荷，而不是整个信封——否则所有非 chat.ts 调用方（containers/wiki/models/
  // pairing + ChatView.loadInstances）裸消费信封对象，listInstances.length / ContainersView.map 失败，
  // 主线「容器列表 → selectContainer → 隧道」全断。非信封（裸载荷）仍原样透传（上一用例）。
  it('apiJson unwraps envelope data on HTTP 200 success（#312 信封）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { a: 1 } }),
    )
    expect(await apiJson<{ a: number }>('/x')).toEqual({ a: 1 })
  })

  it('apiJson unwraps envelope data array（listInstances 契约）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: [1, 2, 3] }),
    )
    expect(await apiJson<number[]>('/x')).toEqual([1, 2, 3])
  })

  // PR #370 第四轮 R4-3（P0）：10005（mustChangePassword）是授权门状态，非凭据失效——刷新换新 token
  // 不会改变它。不得放入 ENVELOPE_UNAUTHENTICATED_CODES 触发刷新链（否则改密用户每请求都无谓刷新
  // 再抛 401「未登录」，看不到「需改密」指引）。apiFetch 对 10005 应直接返回响应交 apiJson 抛 code。
  // T09 Spec-1（PNG 二进制 body 守卫）：HTTP 200 + 非 JSON（image/png 原生字节）→ apiFetch 不得
  // 调 json()/读 body（否则 drain 流使 blob() 抛 Body is unusable），须原样返回。
  it('apiFetch returns non-JSON 200 without reading/consuming the body', async () => {
    const jsonSpy = vi.fn()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
      json: jsonSpy,
    } as unknown as Response)
    const resp = await apiFetch('/api/v1/figures/f-1/png')
    expect(resp.status).toBe(200)
    expect(jsonSpy).not.toHaveBeenCalled() // 非 JSON 200：绝不读 body
  })

  it('apiFetch does not trigger refresh chain on envelope 10005（mustChangePassword 非凭据失效）', async () => {
    const auth = useAuthStore()
    auth.token = 't'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(mockResp({ code: 10005, message: '请先修改密码', data: null }))
    const resp = await apiFetch('/api/v1/x')
    expect(resp.status).toBe(200) // 原响应直接返回，交 apiJson 抛码
    expect(fetchMock).toHaveBeenCalledTimes(1) // 不调 refresh 端点
    expect(auth.token).toBe('t') // 不清 token / 不刷新
  })

  // PR #370 第四轮 R4-4（P1）：并发 401/10001 下 N 个 refreshAndRetry 各调 forceRefresh → N 个同
  // cookie refresh POST → 服务端 rotateRefresh 重放检测「族灭」全部 refresh（10003）→ 凭据有效的
  // 用户被强制登出。须模块级 in-flight refresh promise 单飞：首个 refreshAndRetry 触发，其余复用。
  it('refreshAndRetry coalesces concurrent 10001s into a single refresh POST', async () => {
    const auth = useAuthStore()
    auth.token = 'expired-access'
    const newToken = liveToken()
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/v1/auth/token/refresh') return mockResp({ access: newToken }, 200)
      const hdrs = new Headers(init.headers)
      return hdrs.get('Authorization') === 'Bearer expired-access'
        ? mockResp({ code: 10001, message: '未认证', data: null })
        : mockResp({ code: 0, message: 'ok', data: { ok: true } })
    })
    await Promise.all([apiFetch('/api/v1/x'), apiFetch('/api/v1/y')])
    const refreshCalls = fetchMock.mock.calls.filter(([p]) => p === '/api/v1/auth/token/refresh')
    expect(refreshCalls).toHaveLength(1) // 单飞：并发 refresh 合并为一次，防服务端族灭
  })
})
