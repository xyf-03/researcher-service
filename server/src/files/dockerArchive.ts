// DockerFileArchive —— FileArchive 的 dockerode 适配层（#589 · ADR 0012）。
// 读（list/read）经 getArchive（以容器为视角打 tar 流，穿过 named volume 挂载点读卷数据）、
// 写经 putArchive、删经容器内 exec rm。容器存在即可读（stopped 的 getArchive 由 daemon 处理，
// 不需进程）；写/删先幂等 start（保 exec mkdir / rm 可用，对齐 ADR「stopped 删除需先 start」）。
// client 延迟注入（默认 new Docker() 挂 docker.sock）——构造时不连 daemon（对齐 DockerRuntime）。
//
// 内存防护（#586 US8「接口不会被大二进制拖垮」）：probe 流式读第一个业务头，文件超
// MAX_FILE_READ_BYTES 时只保留头元数据（size/mtime）、排干剩余流不驻留字节——超大文件读请求
// 不把文件内容拉进控制面内存（列表/删除/覆写的大文件同理只读头）。

import Docker from 'dockerode'
import { Readable } from 'node:stream'
import { containerName } from '../containers/runtime'
import { HOME_BIND } from '../containers/constants'
import { FileExists, FileInvalidPath, FileNotFound } from './errors'
import type { DirListing, FileArchive, FileEntry, FileReading, FileRoot } from './fsPort'
import { FILE_ROOTS, MAX_FILE_READ_BYTES, WALK_LIMIT } from './values'
import { alignTo, createTarFile, parseNumeric, parseTar, type TarEntry } from './tar'

// #591 静态 config：容器内 openclaw.json 固定路径（gateway 默认读取位，无 OPENCLAW_CONFIG_PATH）
const CONFIG_PATH = `${HOME_BIND}/openclaw.json`

// tar 条目名归一化（对齐 Go archive/tar 产出）：去 './' 前缀、去尾 '/'；根 '.' → null（跳过）。
// 归一化后条目名即「相对 root 的完整相对路径」（getArchive 的 tar 名相对传入路径展开）。
function normalizeTarName(raw: string): string | null {
  let n = raw.startsWith('./') ? raw.slice(2) : raw
  while (n.endsWith('/')) n = n.slice(0, -1)
  if (n === '' || n === '.') return null
  return n
}

function toEntry(t: TarEntry): FileEntry {
  return {
    path: t.name,
    // symlink 等非目录条目统一按 file 呈现（spec 的 type 枚举仅 file/directory；读 symlink 已被拒）
    type: t.type === 'directory' ? 'directory' : 'file',
    size: t.size,
    modified: new Date(t.mtime * 1000).toISOString(),
  }
}

function mtimeIso(mtime: number): string {
  return new Date(mtime * 1000).toISOString()
}

// probe 结果：ok（完整 tar 已收集）/ oversized（只读头，超大文件不收集）/ null（路径不存在）
type ProbeResult =
  | { kind: 'ok'; buf: Buffer; entries: TarEntry[]; root: TarEntry }
  | { kind: 'oversized'; size: number; mtime: number }
  | null

// 排干流的全部剩余字节（超大文件场景：丢弃不驻留）
async function drainStream(it: AsyncIterator<Buffer>): Promise<void> {
  for (;;) {
    const next = await it.next()
    if (next.done) return
  }
}

export class DockerFileArchive implements FileArchive {
  private cached: Docker | null = null

  constructor(private readonly clientFactory: () => Docker = () => new Docker()) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  private absPath(root: FileRoot, relPath: string): string {
    const base = FILE_ROOTS[root]
    return relPath === '' ? base : `${base}/${relPath}`
  }

  // ---- docker 原语封装（404 语义与 exec 模式对齐 DockerRuntime） ----

  // 幂等 start（已 running → docker 返 304 幂等成功；容器消失 404 幂等成功，后续 exec 再暴露）
  private async start(name: string): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).start()
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      if (sc === 404 || sc === 304) return
      throw e
    }
  }

  // 同步等命令完成；退出码非 0 → 抛错（mkdir/rm 失败须让 caller 走错误路径）
  private async execSync(name: string, cmd: string[]): Promise<void> {
    const container = this.client().getContainer(containerName(name))
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ Detach: false })
    await drainStream(stream[Symbol.asyncIterator]()) // 排干（非 TTY 流含 demux 头，仅作结束信号）
    const info = await exec.inspect()
    if (info.ExitCode !== 0) {
      throw new Error(`exec failed in ${name}: exit_code=${info.ExitCode} cmd=${JSON.stringify(cmd)}`)
    }
  }

  // 流式 probe：读第一个业务头（容忍前置 GNU 'L' / PAX 'x' 元头）→ 超大文件只留元数据；
  // 否则收集完整 tar 解析。路径不存在（daemon 404）→ null。
  private async probe(name: string, absPath: string): Promise<ProbeResult> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await this.client().getContainer(containerName(name)).getArchive({ path: absPath })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    let carry = Buffer.alloc(0) // 未消费缓冲：chunk 可能远大于 512，多余字节保留给后续收集

    // 保证 carry 至少够 n 字节（不足则续读；流尽返回 false）
    const ensure = async (n: number): Promise<boolean> => {
      while (carry.length < n) {
        const next = await it.next()
        if (next.done) return false
        carry = Buffer.concat([carry, next.value])
      }
      return true
    }

    for (;;) {
      if (!(await ensure(512))) return null // 流空/无头 → 不存在
      const head = carry.subarray(0, 512)
      if (head.every((b) => b === 0)) return null // 零块 → 不存在
      const typeflag = String.fromCharCode(head[156])
      if (typeflag === 'L' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
        // 元头（GNU longname / PAX）：跳过其头 + 数据段（size + 对齐），继续读业务头
        const metaSize = parseNumeric(head.subarray(124, 136))
        const skip = 512 + alignTo(metaSize)
        if (!(await ensure(skip))) return null
        carry = carry.subarray(skip)
        continue
      }
      const size = parseNumeric(head.subarray(124, 136))
      if (size > MAX_FILE_READ_BYTES) {
        // 超大单文件：只留头元数据，排干剩余流（字节不驻留控制面内存）
        await drainStream(it)
        return { kind: 'oversized', size, mtime: parseNumeric(head.subarray(136, 148)) }
      }
      // 常规：收集 carry（含业务头）剩余 + 流剩余，完整解析
      const parts: Buffer[] = [carry]
      for (;;) {
        const next = await it.next()
        if (next.done) break
        parts.push(next.value)
      }
      const buf = Buffer.concat(parts)
      const entries = parseTar(buf, { collectData: false })
      const root = entries[0]
      if (!root) return null
      return { kind: 'ok', buf, entries, root }
    }
  }

  // 写/建共用后段：幂等 start → mkdir -p 父目录 → putArchive 单文件 tar
  private async ensureParentAndPut(name: string, absPath: string, content: Buffer): Promise<void> {
    await this.start(name)
    await this.execSync(name, ['mkdir', '-p', absPath.slice(0, absPath.lastIndexOf('/'))])
    const container = this.client().getContainer(containerName(name))
    const basename = absPath.split('/').pop() ?? 'file'
    const dir = absPath.slice(0, absPath.lastIndexOf('/'))
    await container.putArchive(Readable.from([createTarFile(basename, content)]), { path: dir })
  }

  // ---- FileArchive 实现 ----

  async read(name: string, root: FileRoot, relPath: string, recursive: boolean): Promise<DirListing | FileReading> {
    const absPath = this.absPath(root, relPath)
    const probed = await this.probe(name, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'oversized') {
      // 超上限：明确过滤信号（content null + oversized），不返回内容
      return {
        kind: 'file',
        path: relPath,
        content: null,
        size: probed.size,
        modified: mtimeIso(probed.mtime),
        binary: false,
        oversized: true,
      }
    }
    const { buf, entries, root: rootEntry } = probed

    if (rootEntry.type === 'directory') {
      // Docker 目录 getArchive：根条目 = basename（如 'workspace'），子条目带 'workspace/' 前缀
      // （对齐 `docker cp` 语义）；逐条 strip 根前缀得到相对 root 的路径。
      const prefix = normalizeTarName(rootEntry.name)
      const files: FileEntry[] = []
      let truncated = false
      for (const t of entries.slice(1)) {
        const raw = normalizeTarName(t.name)
        if (raw === null) continue
        const name_ = prefix !== null && raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : raw
        if (name_ === '') continue
        // 非递归只列直接子项（无 '/'）；递归收全量（条目名即完整相对路径）
        if (!recursive && name_.includes('/')) continue
        if (files.length >= WALK_LIMIT) {
          truncated = true
          break
        }
        files.push(toEntry({ ...t, name: name_ }))
      }
      const result: DirListing = { kind: 'dir', path: relPath, files, truncated }
      return result
    }

    if (rootEntry.type === 'file') {
      // 已排除 oversized（probe 短路），此处收集必成功
      const full = parseTar(buf, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
      const entry = full[0]
      if (!entry) throw new FileNotFound(relPath)
      const binary = entry.data === null ? false : entry.data.includes(0) // NUL 嗅探判二进制（US8）
      return {
        kind: 'file',
        path: relPath,
        content: binary ? null : (entry.data?.toString('utf8') ?? ''),
        size: entry.size,
        modified: mtimeIso(entry.mtime),
        binary,
        oversized: false,
      }
    }

    throw new FileInvalidPath(relPath) // symlink / 特殊类型：不支持读
  }

  async write(name: string, root: FileRoot, relPath: string, content: string): Promise<void> {
    const absPath = this.absPath(root, relPath)
    const probed = await this.probe(name, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'ok' && probed.root.type !== 'file') throw new FileInvalidPath(relPath) // 目录/链接不可覆写
    await this.ensureParentAndPut(name, absPath, Buffer.from(content, 'utf8'))
  }

  async create(name: string, root: FileRoot, relPath: string, content: string): Promise<void> {
    const absPath = this.absPath(root, relPath)
    const probed = await this.probe(name, absPath)
    if (probed !== null) throw new FileExists(relPath)
    await this.ensureParentAndPut(name, absPath, Buffer.from(content, 'utf8'))
  }

  async delete(name: string, root: FileRoot, relPath: string): Promise<void> {
    const absPath = this.absPath(root, relPath)
    const probed = await this.probe(name, absPath)
    if (probed === null) throw new FileNotFound(relPath)
    if (probed.kind === 'ok' && probed.root.type === 'directory') throw new FileInvalidPath(relPath) // 只支持删文件
    await this.start(name)
    await this.execSync(name, ['rm', '-f', '--', absPath])
  }

  // ---- #591 静态 config（内部机制，REST 不可达）----

  // upsert 写容器内 ~/.openclaw/openclaw.json：不 probe 存在性、不 start、不 exec mkdir——
  // HOME_BIND 挂载点恒存在（镜像骨架/镜像默认），putArchive 对 created/stopped/running 容器
  // 均可用（daemon 直接解包到容器 rootfs，无需进程）。create 流程即「create 容器 → writeConfig
  // → start」，首启 gateway 就读到渲染配置；改配置后须重启容器生效（静态 config，#366 回退）。
  async writeConfig(name: string, content: string): Promise<void> {
    const container = this.client().getContainer(containerName(name))
    await container.putArchive(Readable.from([createTarFile('openclaw.json', Buffer.from(content, 'utf8'))]), {
      path: HOME_BIND,
    })
  }

  // 读容器内 openclaw.json 全文；不存在（daemon 404）→ FileNotFound。
  async readConfig(name: string): Promise<string> {
    const probed = await this.probe(name, CONFIG_PATH)
    if (probed === null) throw new FileNotFound('openclaw.json')
    if (probed.kind === 'oversized' || probed.root.type !== 'file') throw new FileInvalidPath('openclaw.json')
    const full = parseTar(probed.buf, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
    const entry = full[0]
    if (!entry) throw new FileNotFound('openclaw.json')
    return (entry.data ?? Buffer.alloc(0)).toString('utf8')
  }
}
