// seam: auth store clearSession —— codex R1 :102。
// 覆盖：401 清会话时只清 access token，不标 refreshExhausted——让 hydrate 用 refresh
// 端点真实结果决定耗尽（access 过期但 httpOnly refresh cookie 仍有效时不被迫重登）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAuthStore, tokenOwner } from '@/stores/auth'

// 复刻 api/client.test.ts 的 Response mock 形态。
function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

describe('auth.clearSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('clears access token on 401', () => {
    const auth = useAuthStore()
    auth.token = 'expired-access'
    auth.clearSession()
    expect(auth.token).toBe('')
  })

  it('does not exhaust refresh cookie on 401 (codex R1 :102)', () => {
    // access 可能仅过期，httpOnly refresh cookie 仍有效——交由 hydrate 试 refresh 决定
    const auth = useAuthStore()
    auth.token = 'expired-access'
    auth.refreshExhausted = false
    auth.clearSession()
    expect(auth.refreshExhausted).toBe(false)
  })
})

// 修复 BUG：登录无论输入什么都显示「账号已被注册」。
// 根因：auth.login 旧实现只抛写死文案，丢弃校验错误体（多为弱密码被拒）；
// 现须透传后端真实校验消息。#340：register action 已随公开注册关闭（#331 admin-only）移除。
describe('auth login 错误透传', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('login 透传密码校验消息而非写死文案', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ password: ['这个密码太常见了。'] }, 400),
    )
    await expect(useAuthStore().login('weakuser', '12345678')).rejects.toThrow(
      '这个密码太常见了。',
    )
  })

  it('login 透传字段级错误', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ username: ['该字段必须唯一。'] }, 400),
    )
    await expect(useAuthStore().login('dup', 'strong-pass-1')).rejects.toThrow(
      '该字段必须唯一。',
    )
  })

  it('login 透传 non_field_errors', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ non_field_errors: ['用户名或密码错误'] }, 400),
    )
    await expect(useAuthStore().login('x', 'y')).rejects.toThrow('用户名或密码错误')
  })

  it('5xx 非 JSON 响应用状态码兜底', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    } as unknown as Response)
    await expect(useAuthStore().login('u', 'p')).rejects.toThrow('请求失败（500）')
  })

  it('login 成功：token 就位 + role 消费（happy path 未破坏）', async () => {
    const auth = useAuthStore()
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp({ code: 0, message: 'ok', data: { access: 'tok-ok' } })) // login
      .mockResolvedValueOnce(mockResp({ code: 0, message: 'ok', data: { role: 'user' } })) // fetchMe（#340-D）
    await auth.login('okuser', 'strong-pass-123')
    expect(auth.token).toBe('tok-ok')
    expect(auth.role).toBe('user') // #340-D：login 后 me 填充 role
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// #312 信封（TS 后端）：login/refresh 一律 HTTP 200，成功 access 在 data.access、错误在信封码——
// auth store 旧实现只认 resp.ok + 顶层 access，在信封下成功永远读不到 token、失败永远不抛错
// （P0 code review 修复）。
describe('auth #312 信封语义', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('login 成功：access 在信封 data.access（非顶层）', async () => {
    const auth = useAuthStore()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { access: 'tok-env' } }),
    )
    await auth.login('okuser', 'strong-pass-123')
    expect(auth.token).toBe('tok-env')
  })

  it('login 失败：HTTP 200 + 信封 code（10002 登录失败）→ 抛信封 message', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 10002, message: '用户名或密码错误', data: null }),
    )
    await expect(useAuthStore().login('x', 'y')).rejects.toThrow('用户名或密码错误')
  })

  it('forceRefresh 失败：HTTP 200 + 信封 10003（refresh 无效）→ 标 refreshExhausted', async () => {
    const auth = useAuthStore()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 10003, message: '刷新凭证无效', data: null }),
    )
    await auth.forceRefresh()
    expect(auth.token).toBe('')
    expect(auth.refreshExhausted).toBe(true)
  })

  it('forceRefresh 失败：HTTP 200 + 信封 90000（后端瞬态故障）→ 不标 refreshExhausted（保留会话供重试）', async () => {
    // #370 评论 52（P1）：旧实现 env.code!==0 一律置耗尽——DB 瞬断等瞬态 90000 会把仍有效的
    // 会话踢出登录（后续任何 apiFetch 刷新链见 refreshExhausted 直接 clearSession + 跳 /login）。
    // 对照 client.ts 语义：「瞬态失败（cookie 仍可能有效）→ 不标记，下次重试」。
    const auth = useAuthStore()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 90000, message: '服务器内部错误', data: null }),
    )
    await auth.forceRefresh()
    expect(auth.token).toBe('')
    expect(auth.refreshExhausted).toBe(false)
  })

  it('forceRefresh 失败：HTTP 200 + 信封 90002（校验）→ 不标 refreshExhausted（瞬态）', async () => {
    const auth = useAuthStore()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 90002, message: '参数校验失败', data: null }),
    )
    await auth.forceRefresh()
    expect(auth.refreshExhausted).toBe(false)
  })
})

// issue #668：JWT→身份串解析（chat 草稿与面板三态宽度两处 localStorage 按用户隔离共用）。
describe('tokenOwner', () => {
  function jwt(payload: Record<string, unknown>): string {
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `header.${body}.sig`
  }

  it('JWT payload.sub 优先，无 sub 回退 username', () => {
    expect(tokenOwner(jwt({ sub: 'alice', username: 'bob' }))).toBe('alice')
    expect(tokenOwner(jwt({ username: 'bob' }))).toBe('bob')
  })

  it('malformed token 回退 token 本体（token 间天然隔离），空 token 回退 signed-out', () => {
    expect(tokenOwner('not-a-jwt')).toBe('not-a-jwt')
    expect(tokenOwner('')).toBe('signed-out')
  })

  it('sub 为空串回退 token 本体（?? 语义：空串不回退 username）', () => {
    const token = jwt({ sub: '', username: 'bob' })
    expect(tokenOwner(token)).toBe(token)
  })
})
