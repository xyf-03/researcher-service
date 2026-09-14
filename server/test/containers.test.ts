// containers REST 契约测试（接缝 #2 信封 + #334 异步生命周期）。
// 注入假 runtime + inline queue（后台 provisioning 同步跑完），断 HTTP 200 + 信封码 + 归属前置 +
// create 同步返 creating 快照 / delete 异步信封 / list 轮询观察 creating→running、removing→消失。

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { RunOnceError } from '../src/containers/errors'

// 轮询 list 直到 name 满足 predicate 或超时（detach 后台 provisioning/delete 的异步收敛；
// spec 契约即「list 轮询见 creating→running / removing→消失」）。
async function waitFor(
  request: TestContext['request'],
  access: string | undefined,
  name: string,
  predicate: (item: { status: string } | undefined) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await request.get('/api/v1/containers').set(bearer(access))
    const item = list.body.data.find((i: { name: string }) => i.name === name)
    if (predicate(item)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor timeout: ${name} 未在 ${timeoutMs}ms 内满足条件`)
}

describe('containers REST (接缝 #2 + #334)', () => {
  let ctx: TestContext

  beforeAll(async () => {
    // 先建临时 app 拿 prisma，再装编排器重建 app（同一 DB）。
    ctx = await setupTestApp()
    const fl = makeFleetTest(ctx.prisma)
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, orchestrator: fl.orch, runtime: fl.runtime })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('user GET /containers 仅含自己；admin 含全部；pairing 预取（M2 恒 unpaired）', async () => {
    const a = await seedUser(ctx.prisma, 'ua', 'pw-ua-secure')
    const b = await seedUser(ctx.prisma, 'ub', 'pw-ub-secure')
    await ctx.prisma.container.create({
      data: { name: 'a-c', port: 19000, ownerId: a.id, token: 't', homeDir: '/h/a-c', image: 'img', status: 'running' },
    })
    await ctx.prisma.container.create({
      data: { name: 'b-c', port: 19001, ownerId: b.id, token: 't', homeDir: '/h/b-c', image: 'img', status: 'running' },
    })
    const la = await login(ctx.request, 'ua', 'pw-ua-secure')
    const ra = await ctx.request.get('/api/v1/containers').set(bearer(la.access))
    expect(ra.status).toBe(200)
    expect(ra.body.code).toBe(0)
    expect(ra.body.data.map((i: { name: string }) => i.name)).toEqual(['a-c'])
    // ContainerSummary 形状 + pairing 预取
    expect(ra.body.data[0]).toHaveProperty('port')
    expect(ra.body.data[0]).toHaveProperty('status')
    expect(ra.body.data[0]).toHaveProperty('health')
    expect(ra.body.data[0]).toHaveProperty('container_id')
    expect(ra.body.data[0]).toHaveProperty('created_at')
    expect(ra.body.data[0].pairing).toEqual({ status: 'unpaired', device_id: '', scopes: [], pairing_request_id: '' })

    await seedAdmin(ctx.prisma, 'adm', 'pw-adm-secure')
    const lad = await login(ctx.request, 'adm', 'pw-adm-secure')
    const rad = await ctx.request.get('/api/v1/containers').set(bearer(lad.access))
    expect(rad.body.data.map((i: { name: string }) => i.name)).toEqual(
      expect.arrayContaining(['a-c', 'b-c']),
    )
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get('/api/v1/containers')
    expect(res.body.code).toBe(10001)
  })

  // #379 收尾：配对状态可观察——approve 端点真实落库后，容器列表 pairing 快照反映真实状态。
  // 走真实 approve 端点（#371-1）而非直种行：pending 快照 → approve → paired 快照，端到端闭环
  // （containers.test 与 pairingApprove.test 共享同一 app 装配：fl.runtime 为 FakeRuntime，记录 exec）。
  it('pairing 快照随落库状态变化：pending → approve → paired（#379）', async () => {
    const u = await seedUser(ctx.prisma, 'u-snap', 'pw-usnap-secure')
    const c = await ctx.prisma.container.create({
      data: { name: 'snap-c', port: 19062, ownerId: u.id, token: 't', homeDir: '/h/snap-c', image: 'img', status: 'running' },
    })
    const l = await login(ctx.request, 'u-snap', 'pw-usnap-secure')
    const bearerAuth = { Authorization: `Bearer ${l.access}` }
    // 待配对（无 Pairing 行 → default unpaired）
    let r = await ctx.request.get('/api/v1/containers').set(bearerAuth)
    expect(r.body.data.find((i: { name: string }) => i.name === 'snap-c').pairing).toEqual({
      status: 'unpaired', device_id: '', scopes: [], pairing_request_id: '',
    })
    // 真实落库 pending（模拟网关已发 PAIRING_REQUIRED，approve 端点记账语义的输入态）
    await ctx.prisma.pairing.create({
      data: {
        containerId: c.id,
        status: 'pending',
        deviceId: 'dev-snap',
        scopesJson: JSON.stringify(['operator.read', 'operator.write']),
        pairingRequestId: 'req-snap-1',
      },
    })
    r = await ctx.request.get('/api/v1/containers').set(bearerAuth)
    expect(r.body.data.find((i: { name: string }) => i.name === 'snap-c').pairing).toEqual({
      status: 'pending', device_id: 'dev-snap', scopes: ['operator.read', 'operator.write'], pairing_request_id: 'req-snap-1',
    })
    // 真实 approve 端点 → 落库 paired → 列表快照 paired（#371-1 端点真实执行，非直改行）
    const ap = await ctx.request.post('/api/v1/containers/snap-c/pairing/approve/req-snap-1').set(bearerAuth)
    expect(ap.body.code).toBe(0)
    expect(ap.body.data).toEqual({ status: 'paired' })
    r = await ctx.request.get('/api/v1/containers').set(bearerAuth)
    expect(r.body.data.find((i: { name: string }) => i.name === 'snap-c').pairing).toEqual({
      status: 'paired', device_id: 'dev-snap', scopes: ['operator.read', 'operator.write'], pairing_request_id: 'req-snap-1',
    })
  })

  it('POST 同步返 creating 快照（端口已分配）；inline 队列后台完成 → list 可见 running', async () => {
    await seedUser(ctx.prisma, 'ucreate', 'pw-ucreate-secure')
    const lu = await login(ctx.request, 'ucreate', 'pw-ucreate-secure')
    const res = await ctx.request
      .post('/api/v1/containers')
      .set(bearer(lu.access))
      .send({ name: 'sync-snap' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.name).toBe('sync-snap')
    expect(res.body.data.status).toBe('creating') // 同步返 creating 快照
    expect(typeof res.body.data.port).toBe('number') // 端口入队前已分配
    // detach 后 provisioning 后台收敛——轮询 list 直到 running（spec 契约：list 轮询见 creating→running）
    await waitFor(ctx.request, lu.access, 'sync-snap', (i) => i?.status === 'running')
  })

  it('POST 撞名 20041（不分占用者）', async () => {
    await seedUser(ctx.prisma, 'udup', 'pw-udup-secure')
    const lu = await login(ctx.request, 'udup', 'pw-udup-secure')
    await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'dup-name' })
    const again = await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'dup-name' })
    expect(again.body.code).toBe(20041)
  })

  it('POST 超配额 20042', async () => {
    await seedUser(ctx.prisma, 'uquota', 'pw-uquota-secure', { maxContainers: 1 })
    const lu = await login(ctx.request, 'uquota', 'pw-uquota-secure')
    await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'q-one' })
    const over = await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'q-two' })
    expect(over.body.code).toBe(20042)
  })

  it('POST name 非法 90002 + data.name', async () => {
    await seedUser(ctx.prisma, 'uinv', 'pw-uinv-secure')
    const lu = await login(ctx.request, 'uinv', 'pw-uinv-secure')
    const res = await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'Bad_Name!' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('name')
  })

  it('DELETE 异步信封 {status:removing}，list 轮询后消失', async () => {
    await seedUser(ctx.prisma, 'udel', 'pw-udel-secure')
    const lu = await login(ctx.request, 'udel', 'pw-udel-secure')
    await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'del-me' })
    const del = await ctx.request.delete('/api/v1/containers/del-me').set(bearer(lu.access))
    expect(del.status).toBe(200)
    expect(del.body.code).toBe(0)
    expect(del.body.data).toEqual({ status: 'removing' }) // 异步信封
    // detach 后 delete 后台收敛——轮询 list 直到消失（spec 契约：list 轮询见 removing→消失）
    await waitFor(ctx.request, lu.access, 'del-me', (i) => i === undefined)
  })

  it('DELETE 越权他人容器 → 20040 与「不存在」逐字节同码', async () => {
    const victim = await seedUser(ctx.prisma, 'uvictim', 'pw-uvictim-secure')
    await seedUser(ctx.prisma, 'uattacker', 'pw-uattacker-secure')
    await ctx.prisma.container.create({
      data: { name: 'victim-c', port: 19050, ownerId: victim.id, token: 't', homeDir: '/h/victim-c', image: 'img', status: 'running' },
    })
    const la = await login(ctx.request, 'uattacker', 'pw-uattacker-secure')
    // 越权删他人容器
    const cross = await ctx.request.delete('/api/v1/containers/victim-c').set(bearer(la.access))
    // 删不存在容器
    const missing = await ctx.request.delete('/api/v1/containers/never-existed').set(bearer(la.access))
    // 逐字节同码（防探测不分裂）
    expect(cross.status).toBe(missing.status)
    expect(cross.body).toEqual(missing.body)
    expect(cross.body.code).toBe(20040)
    expect(cross.body.data).toBeNull()
  })

  it('DELETE name 非法 → 90002（区别于 20040）', async () => {
    await seedUser(ctx.prisma, 'uname', 'pw-uname-secure')
    const lu = await login(ctx.request, 'uname', 'pw-uname-secure')
    const res = await ctx.request.delete('/api/v1/containers/INVALID').set(bearer(lu.access))
    expect(res.body.code).toBe(90002)
  })

  it('admin DELETE 跨用户容器 → 放行（归属前置 admin 全放行）', async () => {
    const victim = await seedUser(ctx.prisma, 'uvictim2', 'pw-uvictim2-secure')
    await ctx.prisma.container.create({
      data: { name: 'admin-del', port: 19051, ownerId: victim.id, token: 't', homeDir: '/h/admin-del', image: 'img', status: 'running' },
    })
    const admin = await login(ctx.request, 'adm', 'pw-adm-secure')
    const res = await ctx.request.delete('/api/v1/containers/admin-del').set(bearer(admin.access))
    expect(res.body.code).toBe(0)
  })

  it('凭证零落盘：token/passwordHash 不出现在任何响应体', async () => {
    await seedUser(ctx.prisma, 'usecret', 'pw-usecret-secure')
    const lu = await login(ctx.request, 'usecret', 'pw-usecret-secure')
    await ctx.request.post('/api/v1/containers').set(bearer(lu.access)).send({ name: 'secret-c' })
    const list = await ctx.request.get('/api/v1/containers').set(bearer(lu.access))
    expect(JSON.stringify(list.body)).not.toMatch(/"token"/)
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash/)
    expect(JSON.stringify(list.body)).not.toMatch(/private_key|device_token|privateKeyPem/)
  })
})

// Codex 第六轮 P2：routes containers.ts 裸 JSON.parse(scopesJson) —— 迁移/半写入的坏 JSON 让整个
// container-list 请求 500；合法 JSON 但非 string[] 也违反 string[] 响应契约。修复：防御解码，非
// 「全为字符串的数组」一律回退 []。
// 注：M2 pairing 表无写入方（route 恒走 default 分支），此为 M4 落库后的前置防御；用直接种行触发。
describe('containers GET / scopes 防御解码 (Codex 第六轮 P2)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    const fl = makeFleetTest(ctx.prisma)
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, orchestrator: fl.orch, runtime: fl.runtime })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('坏 JSON scopesJson → 不 500，回退 []（修前 JSON.parse 抛错致整列 500）', async () => {
    const u = await seedUser(ctx.prisma, 'uscope', 'pw-uscope-secure')
    const c = await ctx.prisma.container.create({
      data: { name: 'scope-c', port: 19060, ownerId: u.id, token: 't', homeDir: '/h/scope-c', image: 'img', status: 'running' },
    })
    await ctx.prisma.pairing.create({ data: { containerId: c.id, scopesJson: '{not-valid-json' } })
    const lu = await login(ctx.request, 'uscope', 'pw-uscope-secure')
    const res = await ctx.request.get('/api/v1/containers').set(bearer(lu.access))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    const item = res.body.data.find((i: { name: string }) => i.name === 'scope-c')
    expect(item.pairing.scopes).toEqual([])
  })

  it('合法 JSON 但含非字符串元素 → 回退 []（守 string[] 响应契约）', async () => {
    const u = await seedUser(ctx.prisma, 'uscope2', 'pw-uscope2-secure')
    const c = await ctx.prisma.container.create({
      data: { name: 'scope-c2', port: 19061, ownerId: u.id, token: 't', homeDir: '/h/scope-c2', image: 'img', status: 'running' },
    })
    await ctx.prisma.pairing.create({ data: { containerId: c.id, scopesJson: '[1, 2, 3]' } })
    const lu = await login(ctx.request, 'uscope2', 'pw-uscope2-secure')
    const res = await ctx.request.get('/api/v1/containers').set(bearer(lu.access))
    expect(res.status).toBe(200)
    const item = res.body.data.find((i: { name: string }) => i.name === 'scope-c2')
    expect(item.pairing.scopes).toEqual([])
  })
})

// #696 runOnce（一次性临时容器原语，升级编排前置）：经假运行时（接缝 #5）断言编排层可依赖的契约——
// 成功返回输出 / 非 0 携带退出码抛出 / 三路清理，且临时容器对 fleet 列表与端口对账不可见。
describe('runOnce 一次性临时容器（#696 假运行时）', () => {
  let ctx: TestContext
  let fl: FleetTestContext

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
  })
  // fake 的 oneshot 注入位与记录数组整个 describe 共享 → 每用例复位，断言才不靠执行顺序侥幸成立
  //（重排或单跑同样成立；同 pairingApprove.test 的 execCalls 复位先例）。
  beforeEach(() => {
    fl.runtime.oneshotExitCode = 0
    fl.runtime.oneshotOutput = ''
    fl.runtime.oneshotWaitError = null
    fl.runtime.oneshotRuns.length = 0
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('成功：临时容器记入 oneshot 记录并被清理；fleet 列表与端口对账不受影响', async () => {
    const u = await seedUser(ctx.prisma, 'u-oneshot', 'pw-oneshot-secure')
    await fl.orch.create('oneshot-fleet', u.id) // 对照：一个真 fleet 容器
    const fleetBefore = await fl.runtime.listFleet()
    const portsBefore = await fl.runtime.hostPublishedPorts()
    fl.runtime.oneshotOutput = 'tar: 0 files\n'

    const res = await fl.runtime.runOnce({
      image: 'ghcr.io/openclaw/openclaw:target',
      cmd: ['sh', '-c', 'tar czf /backup/home.tar.gz -C /home/node/.openclaw .'],
      mounts: [
        { source: 'openclaw-home-gen-9', target: '/home/node/.openclaw', readOnly: true },
        { source: 'openclaw-home-backup-gen-9', target: '/backup' },
      ],
    })

    expect(res.output).toBe('tar: 0 files\n')
    expect(fl.runtime.oneshotRuns).toHaveLength(1)
    const rec = fl.runtime.oneshotRuns[0]
    expect(rec.spec.image).toBe('ghcr.io/openclaw/openclaw:target')
    expect(rec.spec.mounts?.[1]).toEqual({ source: 'openclaw-home-backup-gen-9', target: '/backup' })
    expect(rec.removed).toBe(true) // 全路径清理
    // 对 fleet 列表与端口对账不可见（真 runtime 靠无 fleet 标签 + 无端口发布达成同一效果）
    expect(await fl.runtime.listFleet()).toEqual(fleetBefore)
    expect(await fl.runtime.hostPublishedPorts()).toEqual(portsBefore)
  })

  it('非 0 退出 → 抛 RunOnceError（退出码 + 输出），容器仍被清理', async () => {
    fl.runtime.oneshotExitCode = 7
    fl.runtime.oneshotOutput = 'legacy session store found\n'
    const err = await fl.runtime
      .runOnce({ image: 'img', cmd: ['openclaw', 'doctor', '--fix'] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunOnceError)
    expect((err as RunOnceError).exitCode).toBe(7)
    expect((err as RunOnceError).output).toContain('legacy session store')
    expect(fl.runtime.oneshotRuns.at(-1)?.removed).toBe(true)
  })

  it('等待退出时 daemon 异常 → 原错上抛，容器仍被清理', async () => {
    fl.runtime.oneshotWaitError = new Error('daemon unreachable')
    const err = await fl.runtime
      .runOnce({ image: 'img', cmd: ['sh', '-c', 'tar czf /backup/home.tar.gz .'] })
      .catch((e: unknown) => e)
    expect((err as Error).message).toBe('daemon unreachable')
    expect(fl.runtime.oneshotRuns.at(-1)?.removed).toBe(true)
  })
})
