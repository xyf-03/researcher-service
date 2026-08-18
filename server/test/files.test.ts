// files REST 契约测试（#589 · 接缝 #2 信封 + 新 Port 注入）。
// 端点 /api/v1/containers/<name>/files（GET/PUT/POST/DELETE）；信封（#312）+ 隔离归属前置
// （越权 20040 同码防探测）+ 错误映射（90002/20040/60040/60041）。经 createApp 依赖注入
// 内存 fake FileArchive 直测域契约，不碰真 docker。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { FileExists, FileInvalidPath, FileNotFound } from '../src/files/errors'
import type { DirListing, FileArchive, FileReading, FileRoot } from '../src/files/fsPort'

// 内存 fake FileArchive：目录树 + 文件内容 map；记录每次调用的（root, relPath, recursive）。
class FakeFileArchive implements FileArchive {
  // relPath → 内容；含 \u0000 视为二进制。目录不在 files 里（在 dirs）。
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>([''])
  readonly calls: { method: string; root: FileRoot; relPath: string; recursive?: boolean; content?: string }[] = []

  private entryOf(relPath: string): FileReading {
    const raw = this.files.get(relPath)!
    const binary = raw.includes('\u0000')
    return {
      kind: 'file',
      path: relPath,
      content: binary ? null : raw,
      size: Buffer.byteLength(raw),
      modified: new Date(0).toISOString(),
      binary,
      oversized: false,
    }
  }

  async read(_name: string, root: FileRoot, relPath: string, recursive: boolean): Promise<DirListing | FileReading> {
    this.calls.push({ method: 'read', root, relPath, recursive })
    if (this.dirs.has(relPath)) {
      const children: DirListing['files'] = []
      for (const p of [...this.files.keys(), ...this.dirs].filter((p) => p !== '')) {
        if (recursive ? p.startsWith(relPath === '' ? '' : `${relPath}/`) : p.split('/').length === (relPath === '' ? 1 : 2)) {
          if (relPath !== '' && !p.startsWith(`${relPath}/`)) continue
          children.push({
            path: p,
            type: this.files.has(p) ? 'file' : 'directory',
            size: this.files.get(p) ? Buffer.byteLength(this.files.get(p)!) : 0,
            modified: new Date(0).toISOString(),
          })
        }
      }
      return { kind: 'dir', path: relPath, files: children, truncated: false }
    }
    if (this.files.has(relPath)) return this.entryOf(relPath)
    throw new FileNotFound(relPath)
  }

  // files/raw 字节通道：直接返回文件原始字节（不做 NUL 嗅探/UTF-8 转码——媒体字节透传语义，
  // 与 read() 的「二进制 → content:null」互补）。不存在 → FileNotFound；指向目录 → FileInvalidPath。
  async readBytes(_name: string, root: FileRoot, relPath: string): Promise<Buffer> {
    this.calls.push({ method: 'readBytes', root, relPath })
    if (this.dirs.has(relPath)) throw new FileInvalidPath(relPath)
    const raw = this.files.get(relPath)
    if (raw === undefined) throw new FileNotFound(relPath)
    return Buffer.from(raw, 'utf8')
  }

  async write(_name: string, root: FileRoot, relPath: string, content: string): Promise<void> {
    this.calls.push({ method: 'write', root, relPath, content })
    if (!this.files.has(relPath)) throw new FileNotFound(relPath)
    this.files.set(relPath, content)
  }

  async create(_name: string, root: FileRoot, relPath: string, content: string): Promise<void> {
    this.calls.push({ method: 'create', root, relPath, content })
    if (this.files.has(relPath) || this.dirs.has(relPath)) throw new FileExists(relPath)
    this.files.set(relPath, content)
  }

  async delete(_name: string, root: FileRoot, relPath: string): Promise<void> {
    this.calls.push({ method: 'delete', root, relPath })
    if (this.dirs.has(relPath)) throw new FileInvalidPath(relPath)
    if (!this.files.has(relPath)) throw new FileNotFound(relPath)
    this.files.delete(relPath)
  }

  // #591 config 方法（files REST 不消费；仅满足 Port 契约——按容器名存 openclaw.json 文本）
  readonly configs = new Map<string, string>()
  async writeConfig(name: string, content: string): Promise<void> {
    this.configs.set(name, content)
  }
  async readConfig(name: string): Promise<string> {
    const c = this.configs.get(name)
    if (c === undefined) throw new FileNotFound('openclaw.json')
    return c
  }
}

let seq = 0

describe('files REST（接缝 #2 信封 + #589）', () => {
  let ctx: TestContext
  let archive: FakeFileArchive
  const BASE = '/api/v1/containers'

  beforeAll(async () => {
    archive = new FakeFileArchive()
    archive.files.set('report.md', '# 报告\n')
    archive.files.set('data/raw.txt', 'raw data')
    archive.files.set('data/binary.bin', 'a\u0000b')
    archive.dirs.add('data')
    ctx = await setupTestApp({ files: { archive } })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  async function seedContainer(ownerId: string, status: 'running' | 'stopped' = 'running'): Promise<string> {
    seq += 1
    const name = `file${seq}`
    await ctx.prisma.container.create({
      data: {
        name,
        port: 19100 + seq,
        ownerId,
        token: 't',
        homeDir: '/tmp/home',
        image: 'img',
        status,
      },
    })
    return name
  }

  // ---------------------------- 认证 / name / 容器归属（公共前置）----------------------------

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(`${BASE}/demo/files?root=wiki&path=`)
    expect(res.body.code).toBe(10001)
  })

  it('name 非法 → 90002 + data.name（大写/非法字符）', async () => {
    await seedUser(ctx.prisma, 'finu', 'pw-finu-secure')
    const l = await login(ctx.request, 'finu', 'pw-finu-secure')
    const res = await ctx.request.get(`${BASE}/Bad_Name/files?root=wiki&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('name')
  })

  it('容器不存在 → 20040（空 data）', async () => {
    await seedUser(ctx.prisma, 'fnotf', 'pw-fnotf-secure')
    const l = await login(ctx.request, 'fnotf', 'pw-fnotf-secure')
    const res = await ctx.request.get(`${BASE}/nope/files?root=wiki&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(20040)
    expect(res.body.data).toBeNull()
  })

  it('user 越权访问他人容器 → 20040，与「不存在」同码同文案同空 data（防探测）', async () => {
    const u = await seedUser(ctx.prisma, 'fowner', 'pw-fowner-secure')
    await seedUser(ctx.prisma, 'fvoyeur', 'pw-fvoyeur-secure')
    const name = await seedContainer(u.id)
    const lv = await login(ctx.request, 'fvoyeur', 'pw-fvoyeur-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=`).set(bearer(lv.access))
    expect(res.body.code).toBe(20040)
    expect(res.body).toEqual({ code: 20040, message: expect.any(String), data: null })
  })

  it('admin 可跨用户访问全部容器', async () => {
    const u = await seedUser(ctx.prisma, 'ftarget', 'pw-ftarget-secure')
    const name = await seedContainer(u.id)
    await seedAdmin(ctx.prisma, 'fadmin', 'pw-fadmin-secure')
    const la = await login(ctx.request, 'fadmin', 'pw-fadmin-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=`).set(bearer(la.access))
    expect(res.body.code).toBe(0)
  })

  it('容器行 stopped 也可读（容器存在即可读，US7）', async () => {
    const u = await seedUser(ctx.prisma, 'fstop', 'pw-fstop-secure')
    const name = await seedContainer(u.id, 'stopped')
    const l = await login(ctx.request, 'fstop', 'pw-fstop-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.kind).toBe('dir')
  })

  // ---------------------------- root / path 校验（90002）----------------------------

  it('root 非法 → 90002 + data.root', async () => {
    const u = await seedUser(ctx.prisma, 'froot', 'pw-froot-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'froot', 'pw-froot-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=home&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('root')
  })

  it('path 穿越/绝对路径 → 90002 + data.path（防探测优先：在容器校验之后）', async () => {
    const u = await seedUser(ctx.prisma, 'fpath', 'pw-fpath-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fpath', 'pw-fpath-secure')
    for (const bad of ['../evil.md', '/etc/passwd', 'a\\b.txt', 'a\u0000b']) {
      const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=${encodeURIComponent(bad)}`).set(bearer(l.access))
      expect(res.body.code).toBe(90002)
      expect(res.body.data).toHaveProperty('path')
    }
  })

  // ---------------------------- GET 读 ----------------------------

  it('GET 缺省 path（前端 listWorkspaceTree 形态 ?root=workspace&recursive=true）→ 200 列根目录', async () => {
    const u = await seedUser(ctx.prisma, 'fgnp', 'pw-fgnp-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fgnp', 'pw-fgnp-secure')
    // 前端 api/files.ts:37 不传 path —— 缺省 = 树根（路由注释「空 path = 树根」语义）
    const res = await ctx.request.get(`${BASE}/${name}/files?root=workspace&recursive=true`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ kind: 'dir', path: '', truncated: false })
    expect(res.body.data.files).toContainEqual(
      expect.objectContaining({ path: 'report.md', type: 'file', size: expect.any(Number), modified: expect.any(String) }),
    )
    expect(archive.calls.at(-1)).toMatchObject({ method: 'read', root: 'workspace', relPath: '', recursive: true })
  })

  it('GET path=目录 → dir 分支：{files:[{path,type,size,modified}]}', async () => {
    const u = await seedUser(ctx.prisma, 'fg1', 'pw-fg1-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fg1', 'pw-fg1-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=workspace&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ kind: 'dir', path: '', truncated: false })
    expect(res.body.data.files).toContainEqual(
      expect.objectContaining({ path: 'report.md', type: 'file', size: expect.any(Number), modified: expect.any(String) }),
    )
    expect(res.body.data.files).toContainEqual(expect.objectContaining({ path: 'data', type: 'directory' }))
    // root/path 透传
    expect(archive.calls.at(-1)).toMatchObject({ method: 'read', root: 'workspace', relPath: '', recursive: false })
  })

  it('GET recursive=true 递归 walk 出深层相对路径', async () => {
    const u = await seedUser(ctx.prisma, 'fg2', 'pw-fg2-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fg2', 'pw-fg2-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=data&recursive=true`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    const paths = res.body.data.files.map((f: { path: string }) => f.path)
    expect(paths).toContain('data/raw.txt')
    expect(archive.calls.at(-1)).toMatchObject({ root: 'wiki', relPath: 'data', recursive: true })
  })

  it('GET path=文件 → file 分支：{path,content,size,modified}；二进制 → content null + binary', async () => {
    const u = await seedUser(ctx.prisma, 'fg3', 'pw-fg3-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fg3', 'pw-fg3-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=data%2Fraw.txt`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ kind: 'file', path: 'data/raw.txt', content: 'raw data', binary: false })

    const bin = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=data%2Fbinary.bin`).set(bearer(l.access))
    expect(bin.body.code).toBe(0)
    expect(bin.body.data).toMatchObject({ content: null, binary: true })
  })

  it('GET 文件不存在 → 60040', async () => {
    const u = await seedUser(ctx.prisma, 'fg4', 'pw-fg4-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fg4', 'pw-fg4-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files?root=wiki&path=nope.md`).set(bearer(l.access))
    expect(res.body.code).toBe(60040)
    expect(res.body.data).toBeNull()
  })

  // ---------------------------- PUT / POST / DELETE 写删 ----------------------------

  it('PUT 覆写已存在；返回 {path}；root/path/content 透传', async () => {
    const u = await seedUser(ctx.prisma, 'fw1', 'pw-fw1-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fw1', 'pw-fw1-secure')
    const res = await ctx.request
      .put(`${BASE}/${name}/files`)
      .set(bearer(l.access))
      .send({ root: 'wiki', path: 'report.md', content: '# 新报告\n' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ path: 'report.md' })
    expect(archive.calls.at(-1)).toMatchObject({ method: 'write', root: 'wiki', relPath: 'report.md', content: '# 新报告\n' })
  })

  it('PUT 不存在 → 60040', async () => {
    const u = await seedUser(ctx.prisma, 'fw2', 'pw-fw2-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fw2', 'pw-fw2-secure')
    const res = await ctx.request
      .put(`${BASE}/${name}/files`)
      .set(bearer(l.access))
      .send({ root: 'wiki', path: 'nope.md', content: 'x' })
    expect(res.body.code).toBe(60040)
  })

  it('POST 新建；已存在 → 60041 冲突', async () => {
    const u = await seedUser(ctx.prisma, 'fw3', 'pw-fw3-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fw3', 'pw-fw3-secure')
    const res = await ctx.request
      .post(`${BASE}/${name}/files`)
      .set(bearer(l.access))
      .send({ root: 'workspace', path: 'fresh.md', content: 'new' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ path: 'fresh.md' })

    const conflict = await ctx.request
      .post(`${BASE}/${name}/files`)
      .set(bearer(l.access))
      .send({ root: 'workspace', path: 'fresh.md', content: 'dup' })
    expect(conflict.body.code).toBe(60041)
  })

  it('DELETE 删除文件 → null；不存在 → 60040；指向目录 → 90002', async () => {
    const u = await seedUser(ctx.prisma, 'fw4', 'pw-fw4-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fw4', 'pw-fw4-secure')
    const del = await ctx.request.delete(`${BASE}/${name}/files?root=wiki&path=data%2Fraw.txt`).set(bearer(l.access))
    expect(del.body.code).toBe(0)
    expect(del.body.data).toBeNull()
    expect(archive.calls.at(-1)).toMatchObject({ method: 'delete', root: 'wiki', relPath: 'data/raw.txt' })

    const missing = await ctx.request.delete(`${BASE}/${name}/files?root=wiki&path=data%2Fraw.txt`).set(bearer(l.access))
    expect(missing.body.code).toBe(60040)

    const dir = await ctx.request.delete(`${BASE}/${name}/files?root=wiki&path=data`).set(bearer(l.access))
    expect(dir.body.code).toBe(90002)
  })

  it('写操作 path 空串 → 90002（PUT/POST/DELETE 无树根语义）', async () => {
    const u = await seedUser(ctx.prisma, 'fw5', 'pw-fw5-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fw5', 'pw-fw5-secure')
    const put = await ctx.request.put(`${BASE}/${name}/files`).set(bearer(l.access)).send({ root: 'wiki', path: '', content: 'x' })
    expect(put.body.code).toBe(90002)
    const del = await ctx.request.delete(`${BASE}/${name}/files?root=wiki&path=`).set(bearer(l.access))
    expect(del.body.code).toBe(90002)
  })

  it('body 非 JSON / content 缺失 → 90002', async () => {
    const u = await seedUser(ctx.prisma, 'fw6', 'pw-fw6-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fw6', 'pw-fw6-secure')
    const res = await ctx.request
      .post(`${BASE}/${name}/files`)
      .set(bearer(l.access))
      .send({ root: 'wiki', path: 'a.md' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('content')
  })

  // ---------------------------- GET /:name/files/raw（WebChat 媒体字节通道）----------------------------

  it('raw png 成功读取：原生字节 + image/png + 无信封', async () => {
    const u = await seedUser(ctx.prisma, 'fraw1', 'pw-fraw1-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fraw1', 'pw-fraw1-secure')
    archive.files.set('test.png', 'PNG\r\n\nfake-png-bytes')
    const res = await ctx.request
      .get(`${BASE}/${name}/files/raw?path=${encodeURIComponent('/home/node/.openclaw/workspace/test.png')}`)
      .set(bearer(l.access))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body).not.toHaveProperty('code') // 豁免信封：原生字节
    // supertest 默认 JSON 解析 body；字节经 Buffer 判定
    expect(archive.calls.at(-1)).toMatchObject({ method: 'readBytes', root: 'workspace', relPath: 'test.png' })
  })

  it('raw 未认证 → 10001', async () => {
    const u = await seedUser(ctx.prisma, 'fraw2', 'pw-fraw2-secure')
    const name = await seedContainer(u.id)
    const res = await ctx.request.get(`${BASE}/${name}/files/raw?path=${encodeURIComponent('/home/node/.openclaw/workspace/x.png')}`)
    expect(res.body.code).toBe(10001)
  })

  it('raw 越权访问他人容器 → 20040（防探测同码）', async () => {
    const u = await seedUser(ctx.prisma, 'fraw3', 'pw-fraw3-secure')
    const name = await seedContainer(u.id)
    await seedUser(ctx.prisma, 'fraw3v', 'pw-fraw3v-secure')
    const lv = await login(ctx.request, 'fraw3v', 'pw-fraw3v-secure')
    const res = await ctx.request.get(`${BASE}/${name}/files/raw?path=${encodeURIComponent('/home/node/.openclaw/workspace/x.png')}`).set(bearer(lv.access))
    expect(res.body.code).toBe(20040)
  })

  it('raw 越界路径（.. 穿越 / 绝对路径越出 workspace）→ 90002 + data.path', async () => {
    const u = await seedUser(ctx.prisma, 'fraw4', 'pw-fraw4-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fraw4', 'pw-fraw4-secure')
    for (const bad of [
      '/home/node/.openclaw/workspace/../secret.png', // 前缀内穿越
      '/home/node/.openclaw/wiki/main/x.png', // 非 workspace 树
      '/etc/passwd', // 任意绝对路径
      '/home/node/.openclaw/workspace/a\\b.png', // 反斜杠
    ]) {
      const res = await ctx.request.get(`${BASE}/${name}/files/raw?path=${encodeURIComponent(bad)}`).set(bearer(l.access))
      expect(res.body.code).toBe(90002)
      expect(res.body.data).toHaveProperty('path')
    }
  })

  it('raw 未知扩展名 → 90002（媒体白名单外）', async () => {
    const u = await seedUser(ctx.prisma, 'fraw5', 'pw-fraw5-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fraw5', 'pw-fraw5-secure')
    archive.files.set('doc.pdf', '%PDF-fake')
    const res = await ctx.request
      .get(`${BASE}/${name}/files/raw?path=${encodeURIComponent('/home/node/.openclaw/workspace/doc.pdf')}`)
      .set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('path')
  })

  it('raw 文件不存在 → 60040', async () => {
    const u = await seedUser(ctx.prisma, 'fraw6', 'pw-fraw6-secure')
    const name = await seedContainer(u.id)
    const l = await login(ctx.request, 'fraw6', 'pw-fraw6-secure')
    const res = await ctx.request
      .get(`${BASE}/${name}/files/raw?path=${encodeURIComponent('/home/node/.openclaw/workspace/missing.png')}`)
      .set(bearer(l.access))
    expect(res.body.code).toBe(60040)
  })
})
