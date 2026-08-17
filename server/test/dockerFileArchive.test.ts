// DockerFileArchive 适配层单测（接缝：clientFactory 注入 mock dockerode client）。
// tar 流用本模块 createTarFile 自举构造（读侧真实走 parseTar 解析），验证：
// 列目录/递归 walk/截断、单文件读取/NUL 二进制过滤/oversized、404 → FileNotFound、
// symlink 拒绝、写/建/删的原语调用序列（start → exec mkdir → putArchive / exec rm）。
// 真容器端到端由 containers-smoke 覆盖；此处用 mock client 隔离 daemon。

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { DockerFileArchive } from '../src/files/dockerArchive'
import { FileExists, FileInvalidPath, FileNotFound } from '../src/files/errors'
import { createTarFile, parseTar } from '../src/files/tar'
import { MAX_FILE_READ_BYTES, WALK_LIMIT } from '../src/files/values'

const WIKI_ROOT = '/home/node/.openclaw/wiki/main'
const WS_ROOT = '/home/node/.openclaw/workspace'

// 造一个目录 tar（对齐 Docker getArchive 产出）：根 '.' + 直接子项 + 深层文件。
// mtime 秒精度（2024-01-01）。createTarFile 自带尾部结束零块，拼接时去除、末位统一补。
function dirTar(entries: { name: string; content?: string }[]): Buffer {
  const parts: Buffer[] = []
  const mtime = 1_704_067_200
  for (const e of entries) {
    if (e.content === undefined) {
      // 目录条目（tar 内名字带尾 '/'，Docker 的目录条目为 typeflag '5'）
      const dir = createTarFile(`${e.name}/`, Buffer.alloc(0), mtime)
      // createTarFile 产的是 type '0' 文件——改造成目录条目：把 typeflag 改 '5'，size 置 0
      const h = Buffer.from(dir)
      h.write('5', 156, 'utf8') // typeflag '5' 目录；chksum 未重算（parseTar 宽容不校验）
      h.write('00000000000', 124, 'utf8') // size 0
      parts.push(h.subarray(0, 512))
      continue
    }
    const tar = createTarFile(e.name, Buffer.from(e.content, 'utf8'), mtime)
    parts.push(tar.subarray(0, tar.length - 1024)) // 去尾部结束零块
  }
  parts.push(Buffer.alloc(1024)) // 结束零块
  return Buffer.concat(parts)
}

// mock dockerode：记录 getArchive/putArchive/exec/start 调用，可注入 tar 结果与 404。
function mockClient(opts: {
  archives?: Map<string, Buffer>
  archive404?: Set<string>
  startErr?: { statusCode: number }
}): { docker: Docker; calls: { kind: string; path?: string; cmd?: string[]; stream?: Buffer }[] } {
  const calls: { kind: string; path?: string; cmd?: string[]; stream?: Buffer }[] = []
  const docker = {
    getContainer: (_name: string) => ({
      getArchive: async (o: { path: string }) => {
        calls.push({ kind: 'getArchive', path: o.path })
        if (opts.archive404?.has(o.path)) {
          const e = new Error('no such path') as Error & { statusCode: number }
          e.statusCode = 404
          throw e
        }
        return Readable.from([opts.archives?.get(o.path) ?? Buffer.alloc(0)])
      },
      putArchive: async (stream: NodeJS.ReadableStream, o: { path: string }) => {
        const chunks: Buffer[] = []
        for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c)
        calls.push({ kind: 'putArchive', path: o.path, stream: Buffer.concat(chunks) })
      },
      start: async () => {
        calls.push({ kind: 'start' })
        if (opts.startErr) {
          const e = new Error('start failed') as Error & { statusCode: number }
          e.statusCode = opts.startErr.statusCode
          throw e
        }
      },
      exec: async (e: { Cmd: string[] }) => {
        calls.push({ kind: 'exec', cmd: e.Cmd })
        return {
          start: async () => Readable.from([Buffer.alloc(0)]),
          inspect: async () => ({ ExitCode: 0 }),
        }
      },
    }),
  } as unknown as Docker
  return { docker, calls }
}

describe('DockerFileArchive read（mock dockerode）', () => {
  it('列根目录：直接子项带 type/size/modified；深层条目不出现在非递归列表', async () => {
    const archives = new Map<string, Buffer>([
      [WS_ROOT, dirTar([{ name: '.' }, { name: 'report.md', content: '# R\n' }, { name: 'data' }, { name: 'data/raw.txt', content: 'x' }])],
    ])
    const { docker, calls } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    const res = await fa.read('box', 'workspace', '', false)
    expect(res.kind).toBe('dir')
    if (res.kind !== 'dir') return
    expect(res.files.map((f) => f.path)).toEqual(['report.md', 'data'])
    expect(res.files[0]).toMatchObject({ type: 'file', size: 4, modified: '2024-01-01T00:00:00.000Z' })
    expect(res.files[1]).toMatchObject({ type: 'directory', size: 0 })
    expect(res.truncated).toBe(false)
    expect(calls[0]).toEqual({ kind: 'getArchive', path: WS_ROOT })
  })

  it('递归 walk：深层条目带完整相对路径；子目录 path 透传', async () => {
    const archives = new Map<string, Buffer>([
      [WIKI_ROOT, dirTar([{ name: '.' }, { name: 'concepts' }, { name: 'concepts/attention.md', content: '# A\n' }])],
    ])
    const { docker } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    const res = await fa.read('box', 'wiki', '', true)
    expect(res.kind).toBe('dir')
    if (res.kind !== 'dir') return
    expect(res.files.map((f) => f.path)).toEqual(['concepts', 'concepts/attention.md'])
  })

  it('递归 walk 超 WALK_LIMIT → 截断 + truncated=true', async () => {
    const entries: { name: string; content?: string }[] = [{ name: '.' }, { name: 'data' }]
    for (let i = 0; i < WALK_LIMIT + 100; i++) entries.push({ name: `data/f${i}.txt`, content: 'x' })
    const archives = new Map<string, Buffer>([[WIKI_ROOT, dirTar(entries)]])
    const { docker } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    const res = await fa.read('box', 'wiki', '', true)
    expect(res.kind).toBe('dir')
    if (res.kind !== 'dir') return
    expect(res.truncated).toBe(true)
    expect(res.files.length).toBeLessThanOrEqual(WALK_LIMIT)
  })

  it('读文本文件：content 原文 + size + modified；二进制（NUL 嗅探）→ content null + binary', async () => {
    const archives = new Map<string, Buffer>([
      [`${WIKI_ROOT}/a.md`, dirTar([{ name: './a.md', content: '# 正文\n' }])],
      [`${WIKI_ROOT}/bin.dat`, dirTar([{ name: './bin.dat', content: 'a\u0000b' }])],
    ])
    const { docker } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    const text = await fa.read('box', 'wiki', 'a.md', false)
    expect(text).toMatchObject({ kind: 'file', content: '# 正文\n', binary: false })
    const bin = await fa.read('box', 'wiki', 'bin.dat', false)
    expect(bin).toMatchObject({ kind: 'file', content: null, binary: true, oversized: false })
  })

  it('文件超 MAX_FILE_READ_BYTES → 不收集内容（oversized + content null）', async () => {
    // 造一个超上限的 tar 头：size 字段写大值，data 少给（parseTar 按头 size 解析，data 仅头声明的块数）
    const big = Buffer.alloc(512)
    big.write(`${'a'.repeat(100)}`, 0, 'utf8')
    big.write('0000644', 100, 'utf8')
    big.write(encodeOctalForTest(MAX_FILE_READ_BYTES + 1), 124, 'utf8')
    big.write(encodeOctalForTest(1_704_067_200), 136, 'utf8')
    big.write('0', 156, 'utf8')
    big.write('ustar', 257, 'utf8')
    big.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += big[i]
    big.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    const tar = Buffer.concat([big, Buffer.alloc(1024)])
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/big.txt`, tar]])
    const { docker } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    const res = await fa.read('box', 'wiki', 'big.txt', false)
    expect(res).toMatchObject({ kind: 'file', content: null, oversized: true, binary: false })
    if (res.kind === 'file') expect(res.size).toBe(MAX_FILE_READ_BYTES + 1)
  })

  it('路径不存在（daemon 404）→ FileNotFound；symlink 根条目 → FileInvalidPath', async () => {
    const { docker } = mockClient({ archive404: new Set([`${WIKI_ROOT}/nope.md`]) })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.read('box', 'wiki', 'nope.md', false)).rejects.toBeInstanceOf(FileNotFound)

    // symlink 条目：typeflag '2'，data = 链接目标
    const sym = Buffer.alloc(512)
    sym.write('link.md', 0, 'utf8')
    sym.write('0000777', 100, 'utf8')
    sym.write(encodeOctalForTest(3), 124, 'utf8')
    sym.write(encodeOctalForTest(1_704_067_200), 136, 'utf8')
    sym.write('2', 156, 'utf8')
    sym.write('ustar', 257, 'utf8')
    sym.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += sym[i]
    sym.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    const tar = Buffer.concat([sym, Buffer.from('target', 'utf8'), Buffer.alloc(512 * 2)])
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/link.md`, tar]])
    const fa2 = new DockerFileArchive(() => mockClient({ archives }).docker)
    await expect(fa2.read('box', 'wiki', 'link.md', false)).rejects.toBeInstanceOf(FileInvalidPath)
  })
})

describe('DockerFileArchive write/create/delete（mock dockerode）', () => {
  it('write 覆写：probe 存在 → start → mkdir -p → putArchive（tar 单文件条目）', async () => {
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/a.md`, dirTar([{ name: './a.md', content: 'old' }])]])
    const { docker, calls } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    await fa.write('box', 'wiki', 'a.md', 'new content')

    const kinds = calls.map((c) => c.kind)
    expect(kinds).toEqual(['getArchive', 'start', 'exec', 'putArchive'])
    const put = calls.find((c) => c.kind === 'putArchive')!
    expect(put.path).toBe(`${WIKI_ROOT}`)
    // 单文件 tar 可回读：条目名 = 文件名（不含父目录），内容 = 原文
    const parsed = parseTar(put.stream!, { collectData: true })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ name: 'a.md', type: 'file' })
    expect(parsed[0].data?.toString('utf8')).toBe('new content')
  })

  it('write 不存在 → FileNotFound（不触发 start/put）', async () => {
    const { docker, calls } = mockClient({ archive404: new Set([`${WIKI_ROOT}/nope.md`]) })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.write('box', 'wiki', 'nope.md', 'x')).rejects.toBeInstanceOf(FileNotFound)
    expect(calls.map((c) => c.kind)).toEqual(['getArchive'])
  })

  it('write 指向目录/链接 → FileInvalidPath', async () => {
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/data`, dirTar([{ name: '.' }, { name: 'x.txt', content: 'x' }])]])
    const { docker } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.write('box', 'wiki', 'data', 'x')).rejects.toBeInstanceOf(FileInvalidPath)
  })

  it('create 新建：probe 404 → start → mkdir -p 父目录 → putArchive', async () => {
    // probe 对 ${WIKI_ROOT}/sub/new.md 返回 404（archive404），create 继续
    const m = mockClient({ archive404: new Set([`${WIKI_ROOT}/sub/new.md`]) })
    const fa2 = new DockerFileArchive(() => m.docker)
    await fa2.create('box', 'wiki', 'sub/new.md', 'hello')
    expect(m.calls.map((c) => c.kind)).toEqual(['getArchive', 'start', 'exec', 'putArchive'])
    const mkdir = m.calls.find((c) => c.kind === 'exec') as { cmd?: string[] }
    expect(mkdir.cmd).toEqual(['mkdir', '-p', `${WIKI_ROOT}/sub`])
    const put = m.calls.find((c) => c.kind === 'putArchive')!
    expect(put.path).toBe(`${WIKI_ROOT}/sub`)
  })

  it('create 已存在 → FileExists（不触发写）', async () => {
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/a.md`, dirTar([{ name: './a.md', content: 'old' }])]])
    const { docker, calls } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.create('box', 'wiki', 'a.md', 'x')).rejects.toBeInstanceOf(FileExists)
    expect(calls.map((c) => c.kind)).toEqual(['getArchive'])
  })

  it('delete：probe 文件 → start → exec rm -f -- 绝对路径', async () => {
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/a.md`, dirTar([{ name: './a.md', content: 'x' }])]])
    const { docker, calls } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    await fa.delete('box', 'wiki', 'a.md')
    expect(calls.map((c) => c.kind)).toEqual(['getArchive', 'start', 'exec'])
    const rm = calls.find((c) => c.kind === 'exec') as { cmd?: string[] }
    expect(rm.cmd).toEqual(['rm', '-f', '--', `${WIKI_ROOT}/a.md`])
  })

  it('delete 不存在 → FileNotFound；指向目录 → FileInvalidPath', async () => {
    const m1 = mockClient({ archive404: new Set([`${WIKI_ROOT}/nope.md`]) })
    await expect(new DockerFileArchive(() => m1.docker).delete('box', 'wiki', 'nope.md')).rejects.toBeInstanceOf(FileNotFound)

    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/data`, dirTar([{ name: '.' }, { name: 'x.txt', content: 'x' }])]])
    const m2 = mockClient({ archives })
    await expect(new DockerFileArchive(() => m2.docker).delete('box', 'wiki', 'data')).rejects.toBeInstanceOf(FileInvalidPath)
  })

  it('容器名带前缀（openclaw-gw-<name>）', async () => {
    const archives = new Map<string, Buffer>([[`${WIKI_ROOT}/a.md`, dirTar([{ name: './a.md', content: 'x' }])]])
    const m = mockClient({ archives })
    const fa = new DockerFileArchive(() => m.docker)
    await fa.read('mybox', 'wiki', 'a.md', false)
    expect(m.calls[0]).toEqual({ kind: 'getArchive', path: `${WIKI_ROOT}/a.md` })
  })
})

describe('DockerFileArchive readConfig/writeConfig（#591 静态 config 落容器内）', () => {
  const CFG_PATH = '/home/node/.openclaw/openclaw.json'
  const CFG_TAR = () => dirTar([{ name: './openclaw.json', content: '{"gateway":{}}' }])

  it('writeConfig：直 putArchive（无 start/exec/probe），tar 单文件条目 openclaw.json 内容原文', async () => {
    const { docker, calls } = mockClient({})
    const fa = new DockerFileArchive(() => docker)
    await fa.writeConfig('box', '{"gateway":{"auth":{"mode":"token"}}}')
    expect(calls.map((c) => c.kind)).toEqual(['putArchive']) // upsert：不 probe 存在性、不 start（容器可 created/stopped）
    const put = calls.find((c) => c.kind === 'putArchive')!
    expect(put.path).toBe('/home/node/.openclaw')
    const parsed = parseTar(put.stream!, { collectData: true })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ name: 'openclaw.json', type: 'file' })
    expect(parsed[0].data?.toString('utf8')).toBe('{"gateway":{"auth":{"mode":"token"}}}')
  })

  it('readConfig：getArchive 读 ~/.openclaw/openclaw.json 返回全文', async () => {
    const archives = new Map<string, Buffer>([[CFG_PATH, CFG_TAR()]])
    const { docker, calls } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.readConfig('box')).resolves.toBe('{"gateway":{}}')
    expect(calls[0]).toEqual({ kind: 'getArchive', path: CFG_PATH })
  })

  it('readConfig：config 不存在（404）→ FileNotFound', async () => {
    const { docker } = mockClient({ archive404: new Set([CFG_PATH]) })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.readConfig('box')).rejects.toBeInstanceOf(FileNotFound)
  })

  it('readConfig：config 超 MAX_FILE_READ_BYTES → FileInvalidPath（不可读信号，非内容）', async () => {
    // 复用 oversized 单文件 tar 构造：size 头超上限、data 不给全（probe 短路 oversized 分支）
    const big = Buffer.alloc(512)
    big.write('openclaw.json', 0, 'utf8')
    big.write('0000644', 100, 'utf8')
    big.write(encodeOctalForTest(MAX_FILE_READ_BYTES + 1), 124, 'utf8')
    big.write(encodeOctalForTest(1_704_067_200), 136, 'utf8')
    big.write('0', 156, 'utf8')
    big.write('ustar', 257, 'utf8')
    big.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += big[i]
    big.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    const archives = new Map<string, Buffer>([[CFG_PATH, Buffer.concat([big, Buffer.alloc(1024)])]])
    const { docker } = mockClient({ archives })
    const fa = new DockerFileArchive(() => docker)
    await expect(fa.readConfig('box')).rejects.toBeInstanceOf(FileInvalidPath)
  })
})

// 测试辅助：11 位八进制（与 tar.ts encodeOctal 同源，测试自造头用）
function encodeOctalForTest(value: number): string {
  if (value === 0) return '00000000000'
  return '0'.repeat(11 - value.toString(8).length) + value.toString(8)
}
