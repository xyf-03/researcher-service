import { describe, it, expect, vi } from 'vitest'
import { isQuotaValid, QUOTA_MAX } from '../src/auth/quota'

// 意见⑬[P2]（Codex 六轮）：DEFAULT_MAX_CONTAINERS 默认配额写入前未校验 —— config 加载时
// Number(env ?? 3) 快照，非法 env（负/非数/超 Int 上界）会变 NaN/负数/超界，createUser/bootstrap
// fallback 写库时 Prisma 拒写 90000 或存非法配额。修复：config 加载即校验（isQuotaValid），非法
// fail-fast 抛错。isQuotaValid 与 userService.assertQuotaValid 共享 quota.ts 单一准据。
describe('default quota env (slice config)', () => {
  async function loadDefaultQuota(env: string | undefined): Promise<number | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.DEFAULT_MAX_CONTAINERS
    else vi.stubEnv('DEFAULT_MAX_CONTAINERS', env)
    try {
      const { config } = await import('../src/config')
      return config.defaultMaxContainers
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 3（dev 友好）', async () => {
    expect(await loadDefaultQuota(undefined)).toBe(3)
  })

  it('合法 7 → 加载为 7', async () => {
    expect(await loadDefaultQuota('7')).toBe(7)
  })

  it('非数字 abc → fail-fast（不再写 NaN）', async () => {
    expect(await loadDefaultQuota('abc')).toBe('THREW')
  })

  it('负数 -5 → fail-fast（不再写负配额）', async () => {
    expect(await loadDefaultQuota('-5')).toBe('THREW')
  })

  it('超 Int 上界 2147483648 → fail-fast（不再写超界）', async () => {
    expect(await loadDefaultQuota('2147483648')).toBe('THREW')
  })

  // quota.ts 纯校验准据（config 与 userService 共用）
  it('isQuotaValid：0 / 上界 / 中间值合法；负数 / 超界 / NaN / 非整数非法', () => {
    expect(isQuotaValid(0)).toBe(true)
    expect(isQuotaValid(QUOTA_MAX)).toBe(true)
    expect(isQuotaValid(3)).toBe(true)
    expect(isQuotaValid(-1)).toBe(false)
    expect(isQuotaValid(QUOTA_MAX + 1)).toBe(false)
    expect(isQuotaValid(Number.NaN)).toBe(false)
    expect(isQuotaValid(3.5)).toBe(false) // 非整数（Prisma Int 不接受小数）
  })
})

// 意见②⑧[P2]（Codex ⑯ 轮）：DUMMY_BCRYPT_HASH 固定 cost=12，而 config.bcryptCost 原可被
// BCRYPT_COST env 覆盖 → cost≠12 时 dummy(12) 与真实 hash 耗时差恢复账号存在性探测。修复：
// 规格锁 12（.env.example/README 明文），config 加载即校验，非 12 fail-fast（与 JWT_SECRET 生产
// 校验同模式）。真实 hash 与 dummy 恒同 cost，时序侧信道不再依赖「配置恰好为 12」。
describe('bcrypt cost env (slice config)', () => {
  async function loadBcryptCost(env: string | undefined): Promise<number | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.BCRYPT_COST
    else vi.stubEnv('BCRYPT_COST', env)
    try {
      const { config } = await import('../src/config')
      return config.bcryptCost
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 12（规格锁）', async () => {
    expect(await loadBcryptCost(undefined)).toBe(12)
  })

  it('显式 12 → 加载为 12（合法）', async () => {
    expect(await loadBcryptCost('12')).toBe(12)
  })

  it('非 12（如 14）→ fail-fast（不再允许 cost 漂移）', async () => {
    expect(await loadBcryptCost('14')).toBe('THREW')
  })

  it('非数字 abc → fail-fast', async () => {
    expect(await loadBcryptCost('abc')).toBe('THREW')
  })
})

// 意见②⑧[P1]（Codex ⑰ 轮）：生产 JWT_SECRET 仅挡占位符不够 —— `JWT_SECRET=a` 弱值也能签发
// HS256 access token，攻击者离线爆破伪造 admin token。修复：production 下强制 ≥32 字符
// （256bit HS256 安全下限），不足 fail-fast。dev/test 保持任意非空可用（本地调试）。
describe('JWT secret strength env (slice config)', () => {
  async function loadSecret(
    opts: { secret?: string; env?: string },
  ): Promise<string | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    const { secret, env = 'production' } = opts
    if (secret === undefined) delete process.env.JWT_SECRET
    else vi.stubEnv('JWT_SECRET', secret)
    vi.stubEnv('NODE_ENV', env)
    // C1：production 下 config 加载还校验 CREDENTIAL_ENCRYPTION_KEYS（gateway token 加密密钥）。
    // 提供合法 32B base64 隔离 JWT_SECRET 变量——否则放行用例会因缺加密密钥被误判 THREW。
    if (env === 'production') {
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
      // 第六轮 P2：production 还校验 OPENCLAW_TEMPLATE_DIR（须存在可读目录）。stub process.cwd()
      // 满足校验，隔离 JWT_SECRET 变量（同上理由）。
      vi.stubEnv('OPENCLAW_TEMPLATE_DIR', process.cwd())
      // #385：production 还校验 PANEL_PUBLIC_ORIGIN（缺省 fail-fast）——提供合法值隔离本变量。
      vi.stubEnv('PANEL_PUBLIC_ORIGIN', 'https://panel.example.com')
    }
    try {
      const { config } = await import('../src/config')
      return config.jwtSecret
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('生产缺 JWT_SECRET → fail-fast（既有行为）', async () => {
    expect(await loadSecret({ secret: undefined })).toBe('THREW')
  })

  it('生产 JWT_SECRET 为占位符 → fail-fast（既有行为）', async () => {
    expect(await loadSecret({ secret: 'change-me-in-production' })).toBe('THREW')
  })

  it('生产 JWT_SECRET 过短（<32，如 a）→ fail-fast（新校验）', async () => {
    expect(await loadSecret({ secret: 'a' })).toBe('THREW')
  })

  it('生产 JWT_SECRET 恰好 31 字符 → fail-fast（新校验边界）', async () => {
    expect(await loadSecret({ secret: 'x'.repeat(31) })).toBe('THREW')
  })

  it('生产 JWT_SECRET ≥32 字符 → 放行并返回', async () => {
    const strong = 's'.repeat(32)
    expect(await loadSecret({ secret: strong })).toBe(strong)
  })

  it('dev/test 短密钥仍可用（本地调试不受影响）', async () => {
    expect(await loadSecret({ secret: 'a', env: 'development' })).toBe('a')
  })
})

// 意见③⓪[P2]（Codex ㉑ 轮）：BOOTSTRAP_ADMIN_USERNAME 空串视为缺失 —— Compose 未设置变量替换成
// 空串时 `?? 'admin'` 不触发（空串非 nullish），bootstrap 建 username="" 的唯一 admin，而
// loginSchema min(1) 拒绝空串 → 永久不可登录、重启又因 users 非空跳过 bootstrap。修复：空串回退默认。
describe('bootstrap admin username env (slice config)', () => {
  async function loadUsername(env: string | undefined): Promise<string> {
    vi.resetModules()
    if (env === undefined) delete process.env.BOOTSTRAP_ADMIN_USERNAME
    else vi.stubEnv('BOOTSTRAP_ADMIN_USERNAME', env)
    try {
      const { config } = await import('../src/config')
      return config.bootstrapAdminUsername
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('未设置 → 默认 admin', async () => {
    expect(await loadUsername(undefined)).toBe('admin')
  })

  it('自定义 my-admin → 保留', async () => {
    expect(await loadUsername('my-admin')).toBe('my-admin')
  })

  it('空串 → 视为缺失回退 admin（新校验）', async () => {
    expect(await loadUsername('')).toBe('admin')
  })

  it('纯空白 → 视为缺失回退 admin', async () => {
    expect(await loadUsername('   ')).toBe('admin')
  })
})

// 意见③①[P2]（Codex ㉓ 轮）：REFRESH_TOKEN_TTL 启动期校验 —— `7days` 这类错值 config 接受、
// server 正常起（health 绿），首个 login 才在 refreshExpiresAt() 抛 90000。修复：config 加载即
// 校验 TTL 格式（与 tokens.parseTtlToMs 同正则 `<数字><单位>`），非法 fail-fast。
describe('refresh ttl env (slice config)', () => {
  async function loadRefreshTtl(env: string | undefined): Promise<string | 'THREW'> {
    vi.resetModules()
    if (env === undefined) delete process.env.REFRESH_TOKEN_TTL
    else vi.stubEnv('REFRESH_TOKEN_TTL', env)
    try {
      const { config } = await import('../src/config')
      return config.refreshTtl
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('未设置 → 默认 7d', async () => {
    expect(await loadRefreshTtl(undefined)).toBe('7d')
  })

  it('合法 30m → 保留', async () => {
    expect(await loadRefreshTtl('30m')).toBe('30m')
  })

  it('非法 7days → fail-fast（新校验）', async () => {
    expect(await loadRefreshTtl('7days')).toBe('THREW')
  })

  it('非法 abc → fail-fast', async () => {
    expect(await loadRefreshTtl('abc')).toBe('THREW')
  })
})

// 意见⑦[P2]（Codex 第三轮，针对 9550045）：端口池环境值未校验 —— Number(env) 接受 NaN/小数/负/
// 超 65535，服务照常启动（PortAllocator 只查 end<start），create 时才异常（误报池耗尽 / 坏端口落 docker）。
// 修复：config 加载即校验两个端口池值为合法 TCP 端口整数（[1,65535]）且 end≥start，非法 fail-fast。
describe('port pool env (slice config)', () => {
  async function loadPortPool(envs: { start?: string; end?: string }): Promise<unknown | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (envs.start === undefined) delete process.env.OPENCLAW_PORT_POOL_START
    else vi.stubEnv('OPENCLAW_PORT_POOL_START', envs.start)
    if (envs.end === undefined) delete process.env.OPENCLAW_PORT_POOL_END
    else vi.stubEnv('OPENCLAW_PORT_POOL_END', envs.end)
    try {
      const { config } = await import('../src/config')
      return { portStart: config.fleet.portStart, portEnd: config.fleet.portEnd }
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 19000–19999（既有行为）', async () => {
    expect(await loadPortPool({})).toEqual({ portStart: 19000, portEnd: 19999 })
  })

  it('合法 20000–20100 → 加载为整数（既有行为）', async () => {
    expect(await loadPortPool({ start: '20000', end: '20100' })).toEqual({
      portStart: 20000,
      portEnd: 20100,
    })
  })

  it('非数字 abc → fail-fast（不再接受 NaN 端口池）', async () => {
    expect(await loadPortPool({ start: 'abc' })).toBe('THREW')
  })

  it('小数 19000.5 → fail-fast（TCP 端口须整数）', async () => {
    expect(await loadPortPool({ start: '19000.5' })).toBe('THREW')
  })

  it('负数 -1 → fail-fast', async () => {
    expect(await loadPortPool({ end: '-1' })).toBe('THREW')
  })

  it('0 → fail-fast（端口须 ≥1）', async () => {
    expect(await loadPortPool({ start: '0' })).toBe('THREW')
  })

  it('超 65535 → fail-fast（TCP 端口上限）', async () => {
    expect(await loadPortPool({ end: '70000' })).toBe('THREW')
  })

  it('end < start → fail-fast（不再只靠 PortAllocator 运行时检查）', async () => {
    expect(await loadPortPool({ start: '20000', end: '19999' })).toBe('THREW')
  })
})

// 意见[P2]（Codex 第六轮）：生产 OPENCLAW_TEMPLATE_DIR 走 `../researcher` 兜底、缺 fail-fast ——
// 漏设/拼错时 server 照常起（health 绿），首个 POST 才在后台 HomeProvisioner.provision() 的 cp()
// 失败、留 error 行（部署故障被静默掩盖，与 issue #195「卡 creating」同类）。修复：生产强制
// 绝对/存在/可读目录，非法 fail-fast（与 JWT_SECRET 生产校验同模式）；dev/test 保持兜底。
describe('production template dir (slice config)', () => {
  async function loadTemplateDir(opts: {
    env?: string
    dir?: string | undefined
  }): Promise<string | 'THREW'> {
    vi.resetModules()
    const { env = 'production', dir } = opts
    vi.stubEnv('NODE_ENV', env)
    if (env === 'production') {
      // 隔离 templateDir 变量：提供其余生产必填（JWT_SECRET / CREDENTIAL_ENCRYPTION_KEYS），
      // 否则放行用例会因缺其它必填被误判 THREW（同 loadSecret 模式）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
      // #385：隔离 panelOrigin 变量（同 loadSecret 模式）。
      vi.stubEnv('PANEL_PUBLIC_ORIGIN', 'https://panel.example.com')
    }
    if (dir === undefined) delete process.env.OPENCLAW_TEMPLATE_DIR
    else vi.stubEnv('OPENCLAW_TEMPLATE_DIR', dir)
    try {
      const { config } = await import('../src/config')
      return config.fleet.templateDir
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('生产缺 OPENCLAW_TEMPLATE_DIR → fail-fast（修前走 ../researcher 兜底照常起）', async () => {
    expect(await loadTemplateDir({ dir: undefined })).toBe('THREW')
  })

  it('生产相对路径 → fail-fast（须绝对路径，防 cwd 漂移错配）', async () => {
    expect(await loadTemplateDir({ dir: 'template/relative' })).toBe('THREW')
  })

  it('生产不存在的绝对路径 → fail-fast（须存在）', async () => {
    expect(await loadTemplateDir({ dir: '/definitely-not-a-real-template-dir-xyz' })).toBe('THREW')
  })

  it('生产合法存在的绝对目录 → 放行并返回', async () => {
    expect(await loadTemplateDir({ dir: process.cwd() })).toBe(process.cwd())
  })

  it('dev/test 缺省 → 走 ../researcher 兜底（不加 fail-fast，本地友好）', async () => {
    expect(await loadTemplateDir({ env: 'development', dir: undefined })).toBe(
      `${process.cwd()}/../researcher`,
    )
  })
})

// 意见[P2]（Codex 第七轮 #4）：OPENCLAW_FLEET_ROOT 相对路径时 path.join 保留相对性 —— instances/<name>/
// home 与 openclaw.json 作 Docker bind 的 source 非绝对（Docker bind source 须绝对），POST 返 creating、
// detached provisioning 后台失败留 error 行（部署故障静默掩盖，与 OPENCLAW_TEMPLATE_DIR 第六轮同类）。
// 修复：生产强制绝对路径（对齐 readTemplateDir），显式相对 fail-fast；缺省走 cwd/fleet 绝对兜底；
// dev/test 保持容忍（本地调试可显式相对）。
describe('production fleet root (slice config)', () => {
  async function loadFleetRoot(opts: {
    env?: string
    root?: string | undefined
  }): Promise<string | 'THREW'> {
    vi.resetModules()
    const { env = 'production', root } = opts
    vi.stubEnv('NODE_ENV', env)
    if (env === 'production') {
      // 隔离 fleet.root 变量：提供其余生产必填，否则放行用例被误判 THREW（同 loadTemplateDir 模式）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
      vi.stubEnv('OPENCLAW_TEMPLATE_DIR', process.cwd())
      // #385：隔离 panelOrigin 变量（同 loadTemplateDir 模式）。
      vi.stubEnv('PANEL_PUBLIC_ORIGIN', 'https://panel.example.com')
    }
    if (root === undefined) delete process.env.OPENCLAW_FLEET_ROOT
    else vi.stubEnv('OPENCLAW_FLEET_ROOT', root)
    try {
      const { config } = await import('../src/config')
      return config.fleet.root
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('生产相对路径 → fail-fast（修前 path.join 保留相对致 Docker bind 失败）', async () => {
    expect(await loadFleetRoot({ root: 'fleet/relative' })).toBe('THREW')
  })

  it('生产相对单段 fleet → fail-fast', async () => {
    expect(await loadFleetRoot({ root: 'fleet' })).toBe('THREW')
  })

  it('生产合法绝对路径 → 放行', async () => {
    expect(await loadFleetRoot({ root: '/var/fleet' })).toBe('/var/fleet')
  })

  it('生产缺省 → cwd/fleet 绝对兜底（Docker bind 安全）', async () => {
    expect(await loadFleetRoot({ root: undefined })).toBe(`${process.cwd()}/fleet`)
  })

  it('dev 相对路径 → 容忍（本地调试不受影响）', async () => {
    expect(await loadFleetRoot({ env: 'development', root: 'fleet/rel' })).toBe('fleet/rel')
  })
})

// 意见[F2]（code review PR #367）：隧道连容器网关的 URL scheme 硬编码 ws，deploy/Django 已文档
// OPENCLAW_FLEET_WS_SCHEME=wss（生产 TLS）。config 加载即校验 ws/wss，非法 fail-fast（防 `SCHEME=http`
// 这类错值静默拼出坏 URL，隧道全 4402）。
describe('fleet gateway WS scheme env (slice config, F2)', () => {
  async function loadHealthScheme(env: string | undefined): Promise<string | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.OPENCLAW_FLEET_WS_SCHEME
    else vi.stubEnv('OPENCLAW_FLEET_WS_SCHEME', env)
    try {
      const { config } = await import('../src/config')
      return config.fleet.healthScheme
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 ws（loopback 明文，本地零配置）', async () => {
    expect(await loadHealthScheme(undefined)).toBe('ws')
  })

  it('显式 ws → 加载为 ws', async () => {
    expect(await loadHealthScheme('ws')).toBe('ws')
  })

  it('显式 wss → 加载为 wss（生产网关 TLS）', async () => {
    expect(await loadHealthScheme('wss')).toBe('wss')
  })

  it('非法 http → fail-fast（不再静默拼出坏 URL）', async () => {
    expect(await loadHealthScheme('http')).toBe('THREW')
  })
})

// #385 生产 Origin 接线：PANEL_PUBLIC_ORIGIN —— 后端隧道连容器网关的 WS Origin + 容器
// allowedOrigins 强制条目（真网关 2026.7.1 校验 Origin，PR #384 实测）。生产缺省/非法 → 启动期
// fail-fast（对齐 readFleetRoot/LLM_API_KEY 前置校验模式）——缺配时 ChatView 对真网关
// CONTROL_UI_ORIGIN_NOT_ALLOWED 拒连，且容器配置渲染须在 create 前就知道该值。
describe('panel public origin env (slice config, #385)', () => {
  async function loadPanelOrigin(opts: {
    env?: string
    origin?: string | undefined
  }): Promise<string | 'THREW'> {
    vi.resetModules()
    const { env = 'production', origin } = opts
    vi.stubEnv('NODE_ENV', env)
    if (env === 'production') {
      // 隔离 panelOrigin 变量：提供其余生产必填，否则放行用例被误判 THREW（同 loadTemplateDir 模式）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
      vi.stubEnv('OPENCLAW_TEMPLATE_DIR', process.cwd())
    }
    if (origin === undefined) delete process.env.PANEL_PUBLIC_ORIGIN
    else vi.stubEnv('PANEL_PUBLIC_ORIGIN', origin)
    try {
      const { config } = await import('../src/config')
      return config.fleet.panelOrigin
    } catch (e) {
      // fail-fast：错误消息须指向该 env（验收：生产缺省/非法 → 启动期 fail-fast 含 env 名）
      if (env === 'production') expect((e as Error).message).toContain('PANEL_PUBLIC_ORIGIN')
      return 'THREW'
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('生产缺省 → fail-fast（错误消息指向 PANEL_PUBLIC_ORIGIN）', async () => {
    expect(await loadPanelOrigin({ origin: undefined })).toBe('THREW')
  })

  it('生产非 URL 值 → fail-fast', async () => {
    expect(await loadPanelOrigin({ origin: 'panel.example.com' })).toBe('THREW')
  })

  it('生产非法协议 ftp:// → fail-fast（须 http/https，WS Origin 语义）', async () => {
    expect(await loadPanelOrigin({ origin: 'ftp://panel.example.com' })).toBe('THREW')
  })

  it('生产合法 https origin → 放行并规范化（去 path/query）', async () => {
    expect(await loadPanelOrigin({ origin: 'https://panel.example.com' })).toBe(
      'https://panel.example.com',
    )
  })

  it('生产带 path 的 origin → 规范化为裸 origin（Origin header 形态）', async () => {
    expect(await loadPanelOrigin({ origin: 'https://panel.example.com/some/path?q=1' })).toBe(
      'https://panel.example.com',
    )
  })

  it('生产带端口的 origin → 保留端口', async () => {
    expect(await loadPanelOrigin({ origin: 'http://panel.example.com:8080' })).toBe(
      'http://panel.example.com:8080',
    )
  })

  it('dev 缺省 → 127.0.0.1:18789（与网关默认 seed 一致，本地零配置）', async () => {
    expect(await loadPanelOrigin({ env: 'development', origin: undefined })).toBe(
      'http://127.0.0.1:18789',
    )
  })

  it('dev 非法值 → 回退默认不 fail-fast（本地调试不受影响）', async () => {
    expect(await loadPanelOrigin({ env: 'development', origin: 'not a url' })).toBe(
      'http://127.0.0.1:18789',
    )
  })

  it('dev 合法自定义 origin → 保留', async () => {
    expect(await loadPanelOrigin({ env: 'development', origin: 'http://localhost:5173' })).toBe(
      'http://localhost:5173',
    )
  })
})

// #590/#592：OPENCLAW_NAMED_VOLUMES —— named volume 拓扑编排开关（ADR 0011）。默认 true =
// named volume 拓扑（#592 本地/CI 编排默认：三卷 + putArchive config）；显式 false 回退旧宿主
// bind。非 true/false 值 fail-fast（对齐 readHealthScheme 白名单模式）——否则 `TRUE`/`1` 这类
// 错值静默按默认 true 走，flag 关了却没生效。
describe('named volumes flag (slice config, #590/#592)', () => {
  async function loadNamedVolumes(env: string | undefined): Promise<boolean | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.OPENCLAW_NAMED_VOLUMES
    else vi.stubEnv('OPENCLAW_NAMED_VOLUMES', env)
    try {
      const { config } = await import('../src/config')
      return config.fleet.namedVolumes
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 true（named volume 拓扑，#592 本地/CI 默认）', async () => {
    expect(await loadNamedVolumes(undefined)).toBe(true)
  })

  it('显式 true → 开启 named volume 拓扑', async () => {
    expect(await loadNamedVolumes('true')).toBe(true)
  })

  it('显式 false → 保持旧 bind', async () => {
    expect(await loadNamedVolumes('false')).toBe(false)
  })

  it('非法 TRUE（大小写敏感）→ fail-fast（防错值静默按默认走）', async () => {
    expect(await loadNamedVolumes('TRUE')).toBe('THREW')
  })

  it('非法 1 → fail-fast', async () => {
    expect(await loadNamedVolumes('1')).toBe('THREW')
  })

  it('非法 yes → fail-fast', async () => {
    expect(await loadNamedVolumes('yes')).toBe('THREW')
  })
})

// T01（docs/autofigure/tickets/T01-authenticated-figure-creation.md）：AUTOFIGURE_ENABLED ——
// AutoFigure 域开关（默认关 = figures 路由未装配 → /api/v1/figures 90005）。非 true/false 值
// fail-fast（对齐 readNamedVolumes 白名单模式）——否则 `1`/`TRUE` 这类错值静默按默认 false 走，
// flag 开了却没生效（错误方向是「路由缺席」，fail-fast 更安全）。
describe('AutoFigure enabled flag (slice config, T01)', () => {
  async function loadAutofigureEnabled(env: string | undefined): Promise<boolean | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.AUTOFIGURE_ENABLED
    else vi.stubEnv('AUTOFIGURE_ENABLED', env)
    try {
      const { config } = await import('../src/config')
      return config.autofigure.enabled
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 false（flag 关 = 路由未装配）', async () => {
    expect(await loadAutofigureEnabled(undefined)).toBe(false)
  })

  it('显式 true → 装配 /api/v1/figures', async () => {
    expect(await loadAutofigureEnabled('true')).toBe(true)
  })

  it('显式 false → 保持关闭', async () => {
    expect(await loadAutofigureEnabled('false')).toBe(false)
  })

  it('非法 1 → fail-fast（防错值静默按默认 false 走）', async () => {
    expect(await loadAutofigureEnabled('1')).toBe('THREW')
  })

  it('非法 TRUE（大小写敏感）→ fail-fast', async () => {
    expect(await loadAutofigureEnabled('TRUE')).toBe('THREW')
  })

  it('非法 yes → fail-fast', async () => {
    expect(await loadAutofigureEnabled('yes')).toBe('THREW')
  })
})

// T03（docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）：AUTOFIGURE_LLM_KEY ——
// AutoFigure 生成凭证（服务端执行上下文）。flag 开 + 生产缺 key → fail-fast（否则 queued Job 永不
// 被跑、错配只在请求期暴露）；dev/test 缺省容忍空串（runner 纯逻辑测试经 DI 注入，不经 config）。
// 超时值管道属 T04，本 describe 不测任何 timeout 配置。
describe('AutoFigure llm key env (slice config, T03)', () => {
  async function loadAutofigureLlmKey(opts: {
    env?: string
    flag?: string | undefined
    key?: string | undefined
  }): Promise<string | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    const { env = 'development', flag, key } = opts
    vi.stubEnv('NODE_ENV', env)
    if (flag === undefined) delete process.env.AUTOFIGURE_ENABLED
    else vi.stubEnv('AUTOFIGURE_ENABLED', flag)
    if (env === 'production') {
      // 隔离 llmKey 变量：提供其余生产必填（对齐 loadSecret/loadTemplateDir 模式），
      // 否则放行用例会因缺其它必填被误判 THREW。T07 起 AUTOFIGURE_SIDECAR_URL 同为生产
      // enabled 必填，一并注入（该变量自身有独立 T07 describe 块）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
      vi.stubEnv('OPENCLAW_TEMPLATE_DIR', process.cwd())
      vi.stubEnv('PANEL_PUBLIC_ORIGIN', 'https://panel.example.com')
      vi.stubEnv('AUTOFIGURE_SIDECAR_URL', 'http://autofigure:8080')
    }
    if (key === undefined) delete process.env.AUTOFIGURE_LLM_KEY
    else vi.stubEnv('AUTOFIGURE_LLM_KEY', key)
    try {
      const { config } = await import('../src/config')
      return config.autofigure.llmKey
    } catch (e) {
      // fail-fast：错误消息须指向该 env（验收：生产 enabled+缺 key → 启动期 fail-fast 含 env 名）
      if (env === 'production' && flag === 'true') expect((e as Error).message).toContain('AUTOFIGURE_LLM_KEY')
      return 'THREW'
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('dev 缺省 → 空串（本地纯逻辑调试容忍）', async () => {
    expect(await loadAutofigureLlmKey({})).toBe('')
  })

  it('dev 显式 key → 保留', async () => {
    expect(await loadAutofigureLlmKey({ key: 'sk-dev-test' })).toBe('sk-dev-test')
  })

  it('生产 enabled + 缺 key → fail-fast（错误消息指向 AUTOFIGURE_LLM_KEY）', async () => {
    expect(await loadAutofigureLlmKey({ env: 'production', flag: 'true', key: undefined })).toBe(
      'THREW',
    )
  })

  it('生产 enabled + 提供 key → 放行并返回', async () => {
    expect(await loadAutofigureLlmKey({ env: 'production', flag: 'true', key: 'sk-prod' })).toBe(
      'sk-prod',
    )
  })

  it('生产 disabled + 缺 key → 容忍空串（flag 关不要求凭证）', async () => {
    expect(await loadAutofigureLlmKey({ env: 'production', flag: 'false', key: undefined })).toBe('')
  })
})

// T04（docs/autofigure/tickets/T04-timeout-reconcile-late-result.md）：AUTOFIGURE_JOB_TIMEOUT_MS ——
// AutoFigure 执行超时（ms）。默认 30 分钟（config boundary 唯一声明处，runner 逻辑不硬编码生产
// 超时）；超时自进入 running（startedAt）起算。非法值（非正整数）fail-fast（对齐
// readDefaultMaxContainers 加载即校验）——否则错值静默按默认 30min 走，超时语义错配只在运行期暴露。
describe('AutoFigure job timeout env (slice config, T04)', () => {
  async function loadAutofigureJobTimeoutMs(env: string | undefined): Promise<number | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.AUTOFIGURE_JOB_TIMEOUT_MS
    else vi.stubEnv('AUTOFIGURE_JOB_TIMEOUT_MS', env)
    try {
      const { config } = await import('../src/config')
      return config.autofigure.jobTimeoutMs
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 30 分钟（30 * 60 * 1000 ms）', async () => {
    expect(await loadAutofigureJobTimeoutMs(undefined)).toBe(30 * 60 * 1000)
  })

  it('显式正整数值 → 保留（测试注入短超时的管道）', async () => {
    expect(await loadAutofigureJobTimeoutMs('50')).toBe(50)
  })

  it('非法 0 → fail-fast（超时须为正整数毫秒，防静默按默认 30min 走）', async () => {
    expect(await loadAutofigureJobTimeoutMs('0')).toBe('THREW')
  })

  it('非法空串 → fail-fast（T10 compose 接线陷阱：`${VAR:-}` 无默认值注入空串 → Number(\'\')=0 静默按 0ms 走；须显式默认 1800000）', async () => {
    expect(await loadAutofigureJobTimeoutMs('')).toBe('THREW')
  })

  it('非法非数 → fail-fast', async () => {
    expect(await loadAutofigureJobTimeoutMs('abc')).toBe('THREW')
  })
})

// T07（docs/autofigure/tickets/T07-autofigure-http-adapter.md）：AUTOFIGURE_SIDECAR_URL ——
// 私有 AutoFigure sidecar 的 HTTP base URL（生产 HTTP adapter 唯一地址源，私有 sidecar 契约见
// docs/autofigure/sidecar-contract.md）。flag 开 + 生产缺省/非法 URL → fail-fast（否则错配只在
// enabled 时 adapter 构造/首请求才暴露——对齐 readPanelOrigin 前置校验模式）；dev/test 缺省容忍
// 空串（装配测试经 DI 注入 sidecarUrl，不经 config）。只存 config.autofigure.sidecarUrl，由装配层
// 注入生产 adapter；不落盘/不入日志。T07 不引入 adapter-local timeout——本 env 不承载超时语义
//（sidecar 请求超时由 T04 AUTOFIGURE_JOB_TIMEOUT_MS 应用 runner 唯一承担）。
describe('AutoFigure sidecar url env (slice config, T07)', () => {
  async function loadAutofigureSidecarUrl(opts: {
    env?: string
    flag?: string | undefined
    url?: string | undefined
  }): Promise<string | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    const { env = 'development', flag, url } = opts
    vi.stubEnv('NODE_ENV', env)
    if (flag === undefined) delete process.env.AUTOFIGURE_ENABLED
    else vi.stubEnv('AUTOFIGURE_ENABLED', flag)
    if (env === 'production') {
      // 隔离 sidecarUrl 变量：提供其余生产必填（对齐 loadAutofigureLlmKey 模式），否则放行用例
      // 会因缺其它必填被误判 THREW。生产 enabled 下 AUTOFIGURE_LLM_KEY 同样必填，一并注入。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
      vi.stubEnv('OPENCLAW_TEMPLATE_DIR', process.cwd())
      vi.stubEnv('PANEL_PUBLIC_ORIGIN', 'https://panel.example.com')
      vi.stubEnv('AUTOFIGURE_LLM_KEY', 'sk-prod')
    }
    if (url === undefined) delete process.env.AUTOFIGURE_SIDECAR_URL
    else vi.stubEnv('AUTOFIGURE_SIDECAR_URL', url)
    try {
      const { config } = await import('../src/config')
      return config.autofigure.sidecarUrl
    } catch (e) {
      // fail-fast：错误消息须指向该 env（验收：生产 enabled+缺/非法 → 启动期 fail-fast 含 env 名）
      if (env === 'production' && flag === 'true') {
        expect((e as Error).message).toContain('AUTOFIGURE_SIDECAR_URL')
      }
      return 'THREW'
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('dev 缺省 → 空串（本地纯逻辑调试/装配测试经 DI 注入容忍）', async () => {
    expect(await loadAutofigureSidecarUrl({})).toBe('')
  })

  it('dev 显式 http URL → 保留', async () => {
    expect(await loadAutofigureSidecarUrl({ url: 'http://autofigure:8080' })).toBe(
      'http://autofigure:8080',
    )
  })

  it('生产 enabled + 缺 URL → fail-fast（错误消息指向 AUTOFIGURE_SIDECAR_URL）', async () => {
    expect(
      await loadAutofigureSidecarUrl({ env: 'production', flag: 'true', url: undefined }),
    ).toBe('THREW')
  })

  it('生产 enabled + 非法 URL（非完整 URL）→ fail-fast', async () => {
    expect(
      await loadAutofigureSidecarUrl({ env: 'production', flag: 'true', url: 'not a url' }),
    ).toBe('THREW')
  })

  it('生产 enabled + 非 http(s) 协议 → fail-fast', async () => {
    expect(
      await loadAutofigureSidecarUrl({ env: 'production', flag: 'true', url: 'ftp://autofigure:8080' }),
    ).toBe('THREW')
  })

  it('生产 enabled + 合法 http URL → 放行并返回', async () => {
    expect(
      await loadAutofigureSidecarUrl({ env: 'production', flag: 'true', url: 'http://autofigure:8080' }),
    ).toBe('http://autofigure:8080')
  })

  it('生产 enabled + 合法 https URL → 放行并返回', async () => {
    expect(
      await loadAutofigureSidecarUrl({
        env: 'production',
        flag: 'true',
        url: 'https://autofigure.example.com',
      }),
    ).toBe('https://autofigure.example.com')
  })

  it('生产 disabled + 缺 URL → 容忍空串（flag 关不要求 sidecar 地址）', async () => {
    expect(
      await loadAutofigureSidecarUrl({ env: 'production', flag: 'false', url: undefined }),
    ).toBe('')
  })
})
