// auth store —— 认证状态单例（spec §9.1 Pinia store: auth）。
// P0：login 调后端 /api/v1/auth/login 拿 access token；isAuthenticated 驱动路由守卫。
// #312 信封（TS 后端）：所有 REST 一律 HTTP 200，成功 access 在 data.access、错误在信封码——
// login/register/forceRefresh 均按信封判。
import { defineStore } from 'pinia'

import { extractApiError, ApiError, parseEnvelope } from '@/api/errors'
import { fetchWithTimeout } from '@/api/request'

// codex P2-1：检查 access token 是否过期（JWT exp claim）
// issue #240：导出供 ChatView connect() 前置检查——过期先 forceRefresh 再建连，避免无谓 4401 往返。
export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return Date.now() >= payload.exp * 1000
  } catch {
    return true
  }
}

// 从 JWT access token 解出本地隔离用身份串（payload.sub ?? payload.username）。
// issue #668：chat 草稿（draftOwner）与面板三态宽度（panelWidth）两处 localStorage
// 按用户隔离共用——解析失败回退 token 本体（token 间天然隔离），空 token 回退 'signed-out'。
export function tokenOwner(token: string): string {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))) as Record<string, unknown>
    const identity = payload.sub ?? payload.username
    if (typeof identity === 'string' && identity) return identity
  } catch { /* malformed token falls through to token-scoped isolation */ }
  return token || 'signed-out'
}

// 读取失败响应并抛出含后端真实错误消息的 Error（校验消息，见 api/errors.ts）。
// #312 信封：HTTP 200 + code!==0 → 抛信封 message；非信封 → HTTP 状态 + 字段级 body。
// body 由调用方一次读取传入（Response body 只可读一次，避免二次 json() 抛错）。
// 修复 BUG：旧实现只抛写死文案，丢弃 {"password":["这个密码太常见了。"]} 等真实原因，
// 致 LoginView 误显示「用户名可能已存在」——实际是密码被拒。
function rejectWithApiError(resp: Response, body: unknown): never {
  const env = parseEnvelope(body)
  if (env && env.code !== 0) throw new ApiError(env.message)
  throw new ApiError(extractApiError(resp.status, body))
}

// 安全读响应 body：非 JSON（5xx HTML 等）返回 null。
async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json()
  } catch {
    return null
  }
}

// 成功响应 body 取 access token：#312 信封在 data.access，非信封形状在顶层 access（兜底）。
function readAccessToken(body: unknown): string | null {
  const env = parseEnvelope(body)
  const raw = env ? env.data : (body as Record<string, unknown>)
  const access = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).access : undefined
  return typeof access === 'string' ? access : null
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: '' as string,
    // codex P2-3：cookie 确认无效（401/403）后置真，避免无意义重试；瞬时失败不置
    refreshExhausted: false as boolean,
    // #340-D：me 消费（#317 A：消费 me 新字段 role/mustChangePassword/maxContainers）。
    // role 驱动 admin-only nav 条件渲染 + requiresAdmin 路由守卫；mustChangePassword 驱动强制
    // 改密流程。login/register 后拉一次，me 失败静默降级（token 已就绪，守卫靠 refreshExhausted）。
    role: '' as string,
    mustChangePassword: false as boolean,
    maxContainers: 0 as number,
  }),
  getters: {
    isAuthenticated: (state): boolean => !!state.token,
  },
  actions: {
    // #340-D：拉 /api/v1/auth/me 填充 role/mustChangePassword/maxContainers（me 是 mustChangePassword
    // gate 放行路径）。失败静默降级（保留 token 会话；role 未取到则 admin 路由/导航不渲染，
    // 不误踢用户）。401/10001（token 已失效）→ 清 token 交 401 刷新链。
    async fetchMe(): Promise<void> {
      if (!this.token) return
      try {
        const resp = await fetchWithTimeout('/api/v1/auth/me', {
          headers: { Authorization: `Bearer ${this.token}` },
        })
        const body = await safeJson(resp)
        const env = parseEnvelope(body)
        if (env && env.code !== 0) {
          if (env.code === 10001) this.token = '' // 失效：交刷新链
          return
        }
        if (!resp.ok) return
        const data = env ? (env.data as Record<string, unknown>) : (body as Record<string, unknown>)
        if (typeof data?.role === 'string') this.role = data.role
        if (typeof data?.mustChangePassword === 'boolean') this.mustChangePassword = data.mustChangePassword
        if (typeof data?.maxContainers === 'number') this.maxContainers = data.maxContainers
      } catch {
        // 网络瞬态：静默，下次再取
      }
    },
    async login(username: string, password: string): Promise<void> {
      const resp = await fetchWithTimeout('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body = await safeJson(resp)
      // #312 信封：失败（code!==0）也可能 HTTP 200 → 以信封码为准；非信封按 resp.ok。
      const env = parseEnvelope(body)
      if (env && env.code !== 0) return rejectWithApiError(resp, body)
      if (!resp.ok) return rejectWithApiError(resp, body)
      const access = readAccessToken(body)
      if (!access) return rejectWithApiError(resp, body)
      this.token = access
      this.refreshExhausted = false
      await this.fetchMe() // #340-D：login 后拉 me 消费 role/mustChangePassword
    },
    // codex round-4 F5 注：register 已随 #331 关闭公开注册移除——register 端点改为 admin-only，
    // 登录页不再暴露注册入口（#340 移除 LoginView register 模式），账号由 admin users 页创建。
    async forceRefresh(): Promise<void> {
      // 服务端 401 优先于本地 exp 判断：先丢弃被拒 token，再用 httpOnly cookie 换新。
      this.token = ''
      if (this.refreshExhausted) return
      try {
        const resp = await fetchWithTimeout('/api/v1/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        })
        const body = await safeJson(resp)
        // #312 信封：失败（10003 刷新无效）也 HTTP 200 → 以信封码判耗尽；非信封按状态码。
        // #370 评论 52（P1）：仅确定失效码（10003 refresh 无效/重放/族灭）置耗尽——90000（后端
        // 瞬态内部错误，如 DB 瞬断）/90002（校验）与网络异常一样按瞬态处理不标记，否则凭据仍有效
        // 的用户被瞬态故障强制登出且无自动重试（对照 client.ts「瞬态失败保留会话供上层重试」）。
        const env = parseEnvelope(body)
        if (env && env.code === 10003) {
          this.refreshExhausted = true
        } else if (env && env.code !== 0) {
          // 其它信封码（90000/90002…）= 瞬态：不标记，下次重试
        } else if (resp.ok) {
          const access = readAccessToken(body)
          if (access) this.token = access
          else this.refreshExhausted = true // 成功形状但无 access（异常）→ 按失效处理
        } else if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
          this.refreshExhausted = true
        }
      } catch {
        // 网络异常：瞬时失败，不标记，下次重试
      }
    },
    // codex P2-1/P2-3/round-4 F1：进入受保护路由前恢复登录态。
    // token 未过期 → 跳过；过期/无 → 先清 token 再用 cookie 换新。
    // #340-D：恢复会话后拉 me 填充 role（requiresAdmin 守卫依赖；me 失败静默降级）。
    async hydrate(): Promise<void> {
      if (this.token && !isTokenExpired(this.token)) {
        if (!this.role) await this.fetchMe()
        return
      }
      await this.forceRefresh()
      if (this.token) await this.fetchMe()
    },
    // codex P2-2/round-4 F2：access 过期先 refresh 换新，再调后端清 httpOnly cookie，最后重置本地。
    async logout(): Promise<void> {
      if (this.token && isTokenExpired(this.token)) {
        await this.hydrate()
      }
      if (this.token) {
        try {
          await fetchWithTimeout('/api/v1/auth/logout', {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${this.token}` },
          })
        } catch {
          // 后端不可达也清本地
        }
      }
      this.token = ''
      this.refreshExhausted = true
      this.role = ''
      this.mustChangePassword = false
    },
    // codex R1 :102：API 收到 401 时清 access token（失效/被吊销）。
    // 不标 refreshExhausted——401 可能仅 access 过期，httpOnly refresh cookie 仍有效；
    // 让 hydrate 用 refresh 端点真实结果决定耗尽（避免不必要的强制重登）。
    // 主动 logout 才标 refreshExhausted（用户意图结束会话，cookie 应随之失效）。
    clearSession(): void {
      this.token = ''
      this.role = ''
      this.mustChangePassword = false
    },
  },
})
