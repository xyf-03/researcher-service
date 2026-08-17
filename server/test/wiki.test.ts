// wiki REST 契约测试（#335 · #315 §8 checklist 对 Express 实现重跑；#621 起经 serviceFor 注入
// 内存 fake WikiFileSystem，对齐 files.test.ts 的内存 Port 注入模式——存储适配器行为由
// wikiDockerFs.test.ts 单测覆盖，本文件钉 REST ↔ Port 接线：信封/错误映射/归属/compile 时机）。
// 端点 /api/v1/containers/<name>/wiki/{tree,page,graph,categories}；信封（#312）+ 隔离归属前置
// （#312⑤，越权 20040 同码防探测）+ 错误映射（90002/20040/30040/30041）。compile 经注入 fake
// 断言触发时机（POST/DELETE 触发、PUT 不触发），不碰真 docker。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { FakeWikiFileSystem } from './fakes'
import { WikiService } from '../src/wiki/service'
import type { CompileTrigger } from '../src/wiki/compile'

let seq = 0

// wiki fixture（页集对齐旧 makeWikiHome 真目录 fixture；空目录 entities 无法在内存 fake 表示，
// 「空目录不成组」由 entities 下无页自然成立）。
function wikiFixture(): Record<string, string> {
  return {
    'concepts/attention.md': '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
    'domains/cv/papers/resnet.md': '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
    'experiments/trial-1.md': '---\ntitle: Trial 1\n---\n# Trial 1\n',
    'thoughts/idea-1.md': '# First Idea\n\n`category: idea`\n\nIdea 摘录。\n',
    '.openclaw-wiki/cache.md': 'x',
    'index.md': '# INDEX',
    'root-note.md': '# Root Note\n\n`category: rootcat`\n\nRoot 摘录。\n',
  }
}

describe('wiki REST（接缝 #2 信封 + #335）', () => {
  let ctx: TestContext
  const compileCalls: string[] = []
  // 每容器一个内存 fake WikiFileSystem（seedContainer 注册）；serviceFor 按 name 查，未注册
  // 给空 fake（对齐「容器存在但无 wiki 数据 → 空树」的降级语义）。
  const fss = new Map<string, FakeWikiFileSystem>()
  const BASE = '/api/v1/containers'

  beforeAll(async () => {
    const fakeCompile: CompileTrigger = { trigger: (name) => { compileCalls.push(name) } }
    ctx = await setupTestApp({
      wiki: {
        compile: fakeCompile,
        serviceFor: (inst) => new WikiService(fss.get(inst.name) ?? new FakeWikiFileSystem()),
      },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 每容器独立 name/port（name/port 全局唯一，跨测试不得复用）；homeDir 不再被 wiki 存储使用
  // （#621 Docker 适配器以容器为视角），DB 字段按 schema 必填给占位值。
  async function seedContainer(ownerId: string): Promise<string> {
    seq += 1
    const name = `demo${seq}`
    fss.set(name, new FakeWikiFileSystem(wikiFixture()))
    await ctx.prisma.container.create({
      data: {
        name,
        port: 19000 + seq,
        ownerId,
        token: 't',
        homeDir: '/unused',
        image: 'img',
        status: 'running',
      },
    })
    return name
  }

  // ---------------------------- 认证 / name / 容器归属（#315 §0 公共前置）----------------------------

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(`${BASE}/demo1/wiki/tree`)
    expect(res.body.code).toBe(10001)
  })

  it('name 非法 → 90002 + data.name（大写/非法字符）', async () => {
    await seedUser(ctx.prisma, 'uinv', 'pw-uinv-secure')
    const l = await login(ctx.request, 'uinv', 'pw-uinv-secure')
    const res = await ctx.request.get(`${BASE}/Bad_Name/wiki/tree`).set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('name')
  })

  it('容器不存在 → 20040（空 data）', async () => {
    await seedUser(ctx.prisma, 'unotf', 'pw-unotf-secure')
    const l = await login(ctx.request, 'unotf', 'pw-unotf-secure')
    const res = await ctx.request.get(`${BASE}/nope/wiki/tree`).set(bearer(l.access))
    expect(res.body.code).toBe(20040)
    expect(res.body.data).toBeNull()
  })

  it('user 越权访问他人容器 → 20040，与「不存在」同码同文案同空 data（防探测）', async () => {
    const u = await seedUser(ctx.prisma, 'uowner', 'pw-uowner-secure')
    await seedUser(ctx.prisma, 'uvoyeur', 'pw-uvoyeur-secure')
    const name = await seedContainer(u.id)
    const lv = await login(ctx.request, 'uvoyeur', 'pw-uvoyeur-secure')
    const res = await ctx.request.get(`${BASE}/${name}/wiki/tree`).set(bearer(lv.access))
    expect(res.body.code).toBe(20040)
    expect(res.body).toEqual({ code: 20040, message: expect.any(String), data: null })
  })

  it('admin 可跨用户访问全部容器', async () => {
    const u = await seedUser(ctx.prisma, 'uadm-target', 'pw-uadm-target-secure')
    const name = await seedContainer(u.id)
    await seedAdmin(ctx.prisma, 'adminx', 'pw-adminx-secure')
    const la = await login(ctx.request, 'adminx', 'pw-adminx-secure')
    const res = await ctx.request.get(`${BASE}/${name}/wiki/tree`).set(bearer(la.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.groups).toBeDefined()
  })

  it('顺序陷阱：越权 + 非法 path → 20040（容器校验先于 path）；非法 name + 容器缺失 → 90002', async () => {
    const u = await seedUser(ctx.prisma, 'uord', 'pw-uord-secure')
    await seedUser(ctx.prisma, 'uord-v', 'pw-uord-v-secure')
    const name = await seedContainer(u.id)
    const lv = await login(ctx.request, 'uord-v', 'pw-uord-v-secure')
    const r1 = await ctx.request.get(`${BASE}/${name}/wiki/page?path=../../evil.md`).set(bearer(lv.access))
    expect(r1.body.code).toBe(20040) // 越权优先，不透 path 校验
    const r2 = await ctx.request.get(`${BASE}/Bad_Name/wiki/page?path=../../evil.md`).set(bearer(lv.access))
    expect(r2.body.code).toBe(90002) // name 非法优先
    expect(r2.body.data).toHaveProperty('name')
  })

  // ---------------------------- GET /tree ----------------------------

  it('tree：真实子目录分组、未知目录成组、空目录不成组、跳过插件私有/占位/非 .md、title 走 frontmatter', async () => {
    const u = await seedUser(ctx.prisma, 'utree', 'pw-utree-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'utree', 'pw-utree-secure')
    const res = await ctx.request.get(`${BASE}/${name}/wiki/tree`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    const groups = res.body.data.groups as Array<{ kind: string; name: string; pages: Array<{ path: string; title: string }> }>
    const kinds = new Set(groups.map((g) => g.kind))
    expect(kinds).toEqual(expect.objectContaining(new Set(['concepts', 'domains', 'experiments', 'thoughts'])))
    expect(kinds).not.toContain('entities') // 空目录不成组
    expect(kinds).not.toContain('.openclaw-wiki')
    const all = groups.flatMap((g) => g.pages)
    expect(all.some((p) => p.path.includes('.openclaw-wiki'))).toBe(false)
    expect(all.some((p) => p.path === 'index.md')).toBe(false)
    expect(all.some((p) => p.path === 'root-note.md')).toBe(false) // 顶层散落页不收
    const concepts = groups.find((g) => g.kind === 'concepts')!
    const att = concepts.pages.find((p) => p.path === 'concepts/attention.md')!
    expect(att.title).toBe('Attention')
  })

  // ---------------------------- GET /page ----------------------------

  it('page：返回原文全文 + title', async () => {
    const u = await seedUser(ctx.prisma, 'upage', 'pw-upage-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'upage', 'pw-upage-secure')
    const res = await ctx.request
      .get(`${BASE}/${name}/wiki/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.path).toBe('concepts/attention.md')
    expect(res.body.data.title).toBe('Attention')
    expect(res.body.data.content).toContain('# Attention')
  })

  it('page 不存在 → 30040；空 path / path 注入 → 90002 + data.path', async () => {
    const u = await seedUser(ctx.prisma, 'upage2', 'pw-upage2-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'upage2', 'pw-upage2-secure')
    const missing = await ctx.request
      .get(`${BASE}/${name}/wiki/page?path=${encodeURIComponent('concepts/nope.md')}`)
      .set(bearer(l.access))
    expect(missing.body.code).toBe(30040)
    const bad = ['../../../etc/passwd.md', '..%2F..%2Fsecret.md', '/etc/passwd.md', 'concepts\\..\\secret.md', 'concepts/attention']
    for (const p of bad) {
      const res = await ctx.request.get(`${BASE}/${name}/wiki/page?path=${p}`).set(bearer(l.access))
      expect(res.body.code, `path 注入未被拒: ${p}`).toBe(90002)
      expect(res.body.data).toHaveProperty('path')
    }
    const empty = await ctx.request.get(`${BASE}/${name}/wiki/page?path=`).set(bearer(l.access))
    expect(empty.body.code).toBe(90002)
  })

  // ---------------------------- PUT /page ----------------------------

  it('PUT：byte-exact 覆写已存在页（首尾空白/尾换行保留）；返回 {path}；不触发 compile', async () => {
    const u = await seedUser(ctx.prisma, 'uput', 'pw-uput-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'uput', 'pw-uput-secure')
    compileCalls.length = 0
    const res = await ctx.request
      .put(`${BASE}/${name}/wiki/page`)
      .set(bearer(l.access))
      .send({ path: 'concepts/attention.md', content: '  # 已编辑  \n\n' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ path: 'concepts/attention.md' })
    expect(compileCalls).toEqual([]) // PUT 不触发 compile
    const read = await ctx.request
      .get(`${BASE}/${name}/wiki/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(l.access))
    expect(read.body.data.content).toBe('  # 已编辑  \n\n')
  })

  it('PUT 页不存在 → 30040；managed 路径 → 90002', async () => {
    const u = await seedUser(ctx.prisma, 'uput2', 'pw-uput2-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'uput2', 'pw-uput2-secure')
    const missing = await ctx.request
      .put(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: 'concepts/nope.md', content: 'x' })
    expect(missing.body.code).toBe(30040)
    for (const managed of ['index.md', 'AGENTS.md', 'concepts/index.md', '.openclaw-wiki/cache/foo.md']) {
      const res = await ctx.request
        .put(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: managed, content: 'x' })
      expect(res.body.code, `managed 路径写入未被拒: ${managed}`).toBe(90002)
    }
  })

  // ---------------------------- POST /page ----------------------------

  it('POST：新建页落盘 + 触发 compile；返回 {path}', async () => {
    const u = await seedUser(ctx.prisma, 'upost', 'pw-upost-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'upost', 'pw-upost-secure')
    compileCalls.length = 0
    const res = await ctx.request
      .post(`${BASE}/${name}/wiki/page`)
      .set(bearer(l.access))
      .send({ path: 'concepts/transformer.md', content: '---\ntitle: Transformer\n---\n# T\n' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ path: 'concepts/transformer.md' })
    expect(compileCalls).toEqual([name]) // 新建触发 compile
  })

  it('POST 已存在 → 30041；path 注入 / managed → 90002 且不触发 compile', async () => {
    const u = await seedUser(ctx.prisma, 'upost2', 'pw-upost2-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'upost2', 'pw-upost2-secure')
    compileCalls.length = 0
    const exists = await ctx.request
      .post(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: 'concepts/attention.md', content: 'x' })
    expect(exists.body.code).toBe(30041)
    const inject = await ctx.request
      .post(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: '../../evil.md', content: 'x' })
    expect(inject.body.code).toBe(90002)
    const managed = await ctx.request
      .post(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: '.openclaw-wiki/evil.md', content: 'x' })
    expect(managed.body.code).toBe(90002)
    expect(compileCalls).toEqual([])
  })

  // ---------------------------- DELETE /page ----------------------------

  it('DELETE：删页 + 触发 compile；成功 data null', async () => {
    const u = await seedUser(ctx.prisma, 'udel', 'pw-udel-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'udel', 'pw-udel-secure')
    compileCalls.length = 0
    const res = await ctx.request
      .delete(`${BASE}/${name}/wiki/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toBeNull()
    expect(compileCalls).toEqual([name])
  })

  it('DELETE 页不存在 → 30040；path 注入 → 90002 且不触发 compile', async () => {
    const u = await seedUser(ctx.prisma, 'udel2', 'pw-udel2-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'udel2', 'pw-udel2-secure')
    compileCalls.length = 0
    const missing = await ctx.request
      .delete(`${BASE}/${name}/wiki/page?path=${encodeURIComponent('concepts/nope.md')}`)
      .set(bearer(l.access))
    expect(missing.body.code).toBe(30040)
    const inject = await ctx.request.delete(`${BASE}/${name}/wiki/page?path=../../secret.md`).set(bearer(l.access))
    expect(inject.body.code).toBe(90002)
    const managed = await ctx.request.delete(`${BASE}/${name}/wiki/page?path=index.md`).set(bearer(l.access))
    expect(managed.body.code).toBe(90002)
    expect(compileCalls).toEqual([])
  })

  // ---------------------------- NUL / body limit（codex PR#346）----------------------------

  it('path 含 NUL 字节 → 90002 + data.path（GET query 与 POST/PUT body 一致，codex PR#346）', async () => {
    const u = await seedUser(ctx.prisma, 'unul', 'pw-unul-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'unul', 'pw-unul-secure')
    const nulPath = 'concepts/a\u0000.md'
    const g = await ctx.request
      .get(`${BASE}/${name}/wiki/page?path=${encodeURIComponent(nulPath)}`)
      .set(bearer(l.access))
    expect(g.body.code).toBe(90002)
    expect(g.body.data).toHaveProperty('path')
    const p = await ctx.request
      .post(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: nulPath, content: 'x' })
    expect(p.body.code).toBe(90002)
    expect(p.body.data).toHaveProperty('path')
    const put = await ctx.request
      .put(`${BASE}/${name}/wiki/page`).set(bearer(l.access)).send({ path: nulPath, content: 'x' })
    expect(put.body.code).toBe(90002)
    expect(put.body.data).toHaveProperty('path')
  })

  it('PUT 大页面（>256kb 通用 body limit）保存成功：wiki 走独立大 limit（codex PR#346）', async () => {
    const u = await seedUser(ctx.prisma, 'ubig', 'pw-ubig-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'ubig', 'pw-ubig-secure')
    const big = `# Big\n\n${'x'.repeat(300_000)}\n`
    const res = await ctx.request
      .put(`${BASE}/${name}/wiki/page`)
      .set(bearer(l.access))
      .send({ path: 'concepts/attention.md', content: big })
    expect(res.body.code).toBe(0)
    const read = await ctx.request
      .get(`${BASE}/${name}/wiki/page?path=${encodeURIComponent('concepts/attention.md')}`)
      .set(bearer(l.access))
    expect(read.body.data.content).toHaveLength(big.length)
  })

  it('body 超限（非 wiki 端点仍受 256kb）→ 90002，非 90000（entity.too.large 显式映射）', async () => {
    const res = await ctx.request
      .post('/api/v1/auth/login')
      .send({ username: 'x'.repeat(300_000), password: 'y'.repeat(300_000) })
    expect(res.body.code).toBe(90002)
  })

  // ---------------------------- GET /graph ----------------------------

  it('graph：节点来自 tree；wikilink 不可解析 → ghost 节点；related_pages 出边', async () => {
    const u = await seedUser(ctx.prisma, 'ugraph', 'pw-ugraph-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'ugraph', 'pw-ugraph-secure')
    const res = await ctx.request.get(`${BASE}/${name}/wiki/graph`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    const nodeIds = new Set(res.body.data.nodes.map((n: { id: string }) => n.id))
    expect(nodeIds).toEqual(expect.objectContaining(new Set(['concepts/attention.md', 'domains/cv/papers/resnet.md'])))
    const edges = res.body.data.edges as Array<{ from: string; to: string }>
    expect(edges).toContainEqual({ from: 'concepts/attention.md', to: 'self-attention' })
    expect(edges).toContainEqual({ from: 'domains/cv/papers/resnet.md', to: 'concepts/attention.md' })
    const ghost = res.body.data.nodes.find((n: { id: string }) => n.id === 'self-attention')
    expect(ghost).toMatchObject({ id: 'self-attention', title: 'self-attention', ghost: true })
  })

  // ---------------------------- GET /categories ----------------------------

  it('categories：按 category 分组（含顶层散落页）、开放词表、条目含 path/title/category/excerpt', async () => {
    const u = await seedUser(ctx.prisma, 'ucat', 'pw-ucat-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'ucat', 'pw-ucat-secure')
    const res = await ctx.request.get(`${BASE}/${name}/wiki/categories`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    const data = res.body.data as Record<string, Array<{ path: string; title: string; category: string; excerpt: string }>>
    expect(Object.keys(data).sort()).toEqual(['idea', 'rootcat'])
    expect(data.idea.map((i) => i.path)).toEqual(['thoughts/idea-1.md'])
    expect(data.idea[0].title).toBe('First Idea') // 无 frontmatter → H1
    expect(data.idea[0].category).toBe('idea')
    expect(data.idea[0].excerpt).toContain('Idea 摘录')
    expect(data.rootcat.map((i) => i.path)).toEqual(['root-note.md']) // 顶层散落页进 categories
    const allPaths = Object.values(data).flat().map((i) => i.path)
    expect(allPaths).not.toContain('concepts/attention.md') // 无标记页不进
  })
})
