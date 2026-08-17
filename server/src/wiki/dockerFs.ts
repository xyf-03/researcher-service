// Docker WikiFileSystem 适配器（#621 · ADR 0012 wiki 收口）：named volume 拓扑（#592 起默认开）
// + 控制面容器化（#594/#595 零宿主挂载）下，wiki 数据只在 OpenClaw 容器内
// `~/.openclaw/wiki/main`（named volume / bind home 内），控制面文件系统无宿主路径可读——
// NodeWikiFileSystem 直读 DB 记账的宿主 homeDir 在该拓扑下失效（tree 空 / create 父目录缺失
// → 90002），本适配器把存储通道换成 Docker 原语（getArchive/putArchive/exec rm），以容器为视角
// 读写，bind / named volume 两拓扑通用。
//
// 形态（与 NodeFs 对照）：
//   - 读侧自实现：FileArchive.read 的 DirListing 无内容、FileReading 的 16MB/binary-null 语义
//     不合 wiki 契约（readPage content 恒 string、tree title 需 frontmatter）。snapshot() 经
//     getArchive 拉全库 tar + parseTar 收集内容，buildTree/listCategoryPages 在快照上跑与
//     NodeFs 等价的过滤/分组/title 语义；readPage 单文件 probe（无字节上限，对齐 NodeFs 全读）。
//   - 写侧委托 FileArchive（files 域 Port，root='wiki'）：write/create/delete 的原语序列
//     （幂等 start → exec mkdir → putArchive / exec rm）与错误语义现成；异常经映射膜转 wiki 族。
//   - managed 黑名单（SKIP_DIRS 段 / SKIP_FILES 末段 → WikiInvalidPath）在本层前置——
//     FileArchive 不知 wiki 的 SKIP 集合（对齐 NodeFs assertNotManaged，请求层 paths.ts 不做）。
//
// 与 NodeFs 的安全模型差异（有意，注释即契约）：
//   - symlink/TOCTOU 锚定防护无 Docker 等价物也无必要：getArchive/putArchive 以容器为视角，
//     tar 内容由控制面解析、不落控制面盘，容器内 symlink 逃逸不到控制面文件系统；路径合法性
//     由请求层 paths.ts（穿越/绝对/反斜杠/NUL）+ 本层 managed 黑名单承载。
//   - createPage 从 open(wx) 原子独占退化为 probe+putArchive 两步（Docker 原语无 O_EXCL）：
//     并发 POST 同路径可能后者覆盖前者（原 EEXIST 拒）。面板单用户单容器场景可接受。
//   - 写/删经 FileArchive 会先幂等 start stopped 容器（ADR 0012 已接受）。
//   - buildGraph（service 层）逐页 readPage → N 次 getArchive 往返：功能正确，性能后续可
//     加快照缓存优化，本票不动 service 层。

import Docker from 'dockerode'
import { containerName } from '../containers/runtime'
import { DockerFileArchive } from '../files/dockerArchive'
import { FileExists, FileInvalidPath, FileNotFound } from '../files/errors'
import type { FileArchive } from '../files/fsPort'
import { parseTar, type TarEntry } from '../files/tar'
import { FILE_ROOTS, MAX_FILE_READ_BYTES, WALK_LIMIT } from '../files/values'
import { cmp, decodeUtf8Strict, FrontmatterParser, frontmatterTitle, h1Title } from './logic'
import { SKIP_DIRS, SKIP_FILES } from './values'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from './errors'
import type {
  WikiCategoryPage,
  WikiFileSystem,
  WikiPage,
  WikiTree,
  WikiTreePage,
} from './fsPort'

// 快照 tar 全量字节上限：正常 wiki 库为几 MB 量级，但 _attachments 等 SKIP 目录的附件字节
// 也会被 getArchive 一并拉出，故取宽裕值。超限降级「空树/空聚合」（对齐 NodeFs「单目录
// 不可读→跳过」的降级精神），readPage 走单文件 probe 不受影响。
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

// readPage 单文件 probe 结果：file 携带全文（无字节上限，对齐 NodeFs read_page 全读契约）；
// dir/link 区分目录（→WikiPageNotFound）与 symlink/特殊（→WikiInvalidPath，对齐 NodeFs
// ELOOP/锚定语义）；null = 不存在。
export type WikiProbeResult =
  | { kind: 'file'; data: Buffer }
  | { kind: 'dir' }
  | { kind: 'link' }
  | null

// 注入接缝：生产全缺省（真 docker）；单测注入 fake snapshot/probeFile/archive 纯逻辑直测，
// 缺省实现的 docker 接线由 mock client 测（对齐 dockerFileArchive.test.ts 模式）。
export interface DockerWikiDeps {
  docker?: () => Docker
  archive?: FileArchive
  snapshot?: () => Promise<TarEntry[] | null>
  probeFile?: (relPath: string) => Promise<WikiProbeResult>
}

// tar 条目名归一化（对齐 dockerArchive：去 './' 前缀、去尾 '/'；根 '.' → null 跳过）。
function normalizeTarName(raw: string): string | null {
  let n = raw.startsWith('./') ? raw.slice(2) : raw
  while (n.endsWith('/')) n = n.slice(0, -1)
  if (n === '' || n === '.') return null
  return n
}

function stemOf(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

export class DockerWikiFileSystem implements WikiFileSystem {
  private readonly parser = new FrontmatterParser()
  private readonly archive: FileArchive
  private readonly snap: () => Promise<TarEntry[] | null>
  private readonly probeFile: (relPath: string) => Promise<WikiProbeResult>

  constructor(
    private readonly name: string, // 面板实例名（路由层 CONTAINER_NAME_REGEX 已过）
    deps: DockerWikiDeps = {},
  ) {
    const docker = deps.docker ?? (() => new Docker())
    this.archive = deps.archive ?? new DockerFileArchive(docker)
    this.snap = deps.snapshot ?? (() => this.defaultSnapshot(docker()))
    this.probeFile = deps.probeFile ?? ((relPath) => this.defaultProbeFile(docker(), relPath))
  }

  // —— Port: build_tree ——

  async buildTree(): Promise<WikiTree> {
    const entries = await this.snap()
    if (entries === null) return { groups: [] } // 根不可用（容器/wiki 目录缺失/快照超限）→ 空树降级
    const groups = new Map<string, WikiTreePage[]>()
    for (const t of entries) {
      const page = this.treePage(t)
      if (page === null) continue
      const top = t.name.split('/')[0]
      const pages = groups.get(top)
      if (pages) pages.push(page)
      else groups.set(top, [page])
    }
    return {
      groups: [...groups.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([kind, pages]) => ({ kind, name: kind, pages: pages.sort((x, y) => cmp(x.path, y.path)) })),
    }
  }

  // —— Port: read_page ——

  async readPage(relPath: string): Promise<WikiPage> {
    this.assertNotManaged(relPath)
    const probed = await this.probeFile(relPath)
    if (probed === null || probed.kind === 'dir') throw new WikiPageNotFound(relPath)
    if (probed.kind === 'link') throw new WikiInvalidPath(relPath)
    // 读/解码失败上抛 TypeError（read_page 不降级，对齐 NodeFs decodeUtf8Strict 语义）。
    const content = decodeUtf8Strict(probed.data)
    const { frontmatter } = this.parser.parse(content)
    const stem = stemOf(relPath.slice(relPath.lastIndexOf('/') + 1))
    return { path: relPath, title: frontmatterTitle(frontmatter) ?? stem, content }
  }

  // —— Port: list_category_pages ——

  async listCategoryPages(): Promise<WikiCategoryPage[]> {
    const entries = await this.snap()
    if (entries === null) return []
    const pages: WikiCategoryPage[] = []
    for (const t of entries) {
      if (!this.isPageEntry(t)) continue
      if (t.data === null) continue // 超大/未收集 → 跳过该页（对齐 NodeFs readText null → skip）
      let content: string
      try {
        content = decodeUtf8Strict(t.data)
      } catch {
        continue // 读不出/解码失败 → 调用方跳过该页（codex #129 P2）
      }
      const { frontmatter, body } = this.parser.parse(content)
      const stem = stemOf(t.name.slice(t.name.lastIndexOf('/') + 1))
      const title = frontmatterTitle(frontmatter) ?? h1Title(body) ?? stem
      pages.push({ path: t.name, title, content })
    }
    pages.sort((a, b) => cmp(a.path, b.path))
    return pages
  }

  // —— Port: write_page / create_page / delete_page（委托 FileArchive，root='wiki'）——

  async writePage(relPath: string, content: string): Promise<{ path: string }> {
    this.assertNotManaged(relPath)
    try {
      await this.archive.write(this.name, 'wiki', relPath, content)
    } catch (err) {
      throw this.mapArchiveError(err, relPath)
    }
    return { path: relPath }
  }

  async createPage(relPath: string, content: string): Promise<{ path: string }> {
    this.assertNotManaged(relPath)
    await this.assertParentsAreDirs(relPath) // 父段为文件/link → WikiInvalidPath（保 90002，见下）
    try {
      // FileArchive.create 语义：已存在 → FileExists；父目录不存在自动 mkdir -p（#621 有意
      // 放宽——旧 NodeFs 父目录缺失 → 90002，现为「输入合法路径即可建」，消除误导性 90002）。
      await this.archive.create(this.name, 'wiki', relPath, content)
    } catch (err) {
      throw this.mapArchiveError(err, relPath)
    }
    return { path: relPath }
  }

  async deletePage(relPath: string): Promise<void> {
    this.assertNotManaged(relPath)
    try {
      await this.archive.delete(this.name, 'wiki', relPath)
    } catch (err) {
      throw this.mapArchiveError(err, relPath)
    }
  }

  // —— internal ——

  // tree 页条目：过滤后返回 {path,title}；非页（目录/symlink/非 .md/SKIP/顶层散落）→ null。
  private treePage(t: TarEntry): WikiTreePage | null {
    if (!this.isPageEntry(t)) return null
    if (!t.name.includes('/')) return null // 顶层散落页不收（categories 才收，对齐 NodeFs buildTree）
    const stem = stemOf(t.name.slice(t.name.lastIndexOf('/') + 1))
    // title = frontmatter（全文 parse；frontmatter 在文件头，与 NodeFs 读前缀等价）→ stem。
    // 无 H1 fallback（对齐 NodeFs buildTree 的 pageTitle 语义）；超大/解码失败 → stem。
    return { path: t.name, title: this.titleFromEntry(t) ?? stem }
  }

  // 页条目判定：regular file + .md + 无 SKIP_DIRS 段 + 非 SKIP_FILES 末段。
  // symlink/other 跳过（对齐 NodeFs 不跟随）；目录条目自然排除。
  private isPageEntry(t: TarEntry): boolean {
    if (t.type !== 'file') return false
    if (!t.name.endsWith('.md')) return false
    const parts = t.name.split('/')
    if (parts.some((p) => SKIP_DIRS.has(p))) return false
    if (SKIP_FILES.has(parts[parts.length - 1])) return false
    return true
  }

  // 从快照条目解析 title：frontmatter ?? undefined（调用方补 stem/H1 兜底）；data 未收集
  // （超大）或解码失败 → undefined（对齐 NodeFs pageTitle 读失败 → 文件名 fallback）。
  private titleFromEntry(t: TarEntry): string | undefined {
    if (t.data === null) return undefined
    try {
      const { frontmatter } = this.parser.parse(decodeUtf8Strict(t.data))
      return frontmatterTitle(frontmatter)
    } catch {
      return undefined
    }
  }

  // managed 黑名单（#315 §4 第②层，对齐 NodeFs assertNotManaged）：任一段命中 SKIP_DIRS、
  // 或末段命中 SKIP_FILES → 拒。三写一读前置（FileArchive 层不知 SKIP 集合）。
  private assertNotManaged(relPath: string): void {
    const parts = relPath.split('/')
    if (parts.some((seg) => SKIP_DIRS.has(seg))) throw new WikiInvalidPath(relPath)
    if (SKIP_FILES.has(parts[parts.length - 1])) throw new WikiInvalidPath(relPath)
  }

  // createPage 父链守卫（保 nodeFs ENOTDIR → 90002 契约）：DockerFileArchive.create 的 mkdir -p
  // 遇父段为普通文件（如 notes.md/child.md，notes.md 已是文件）时 exec 退出码非 0 → 抛裸 Error
  // （不在 files 异常族，dockerArchive.ts execSync）→ 路由 90000；nodeFs 旧实现 open(wx) 抛
  // ENOTDIR → WikiInvalidPath → 90002。此处 createPage 前置逐段 probe 已存在的父段：file/link →
  // WikiInvalidPath（保 90002）；null（父段不存在）放行（mkdir -p 创建）；dir 放行。仅 createPage
  // 需要——writePage 目标须已存在（父链必是目录），deletePage 目标不存在已 30040。
  private async assertParentsAreDirs(relPath: string): Promise<void> {
    const parts = relPath.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      const probed = await this.probeFile(parent)
      if (probed === null) continue
      if (probed.kind !== 'dir') throw new WikiInvalidPath(relPath)
    }
  }

  // files 域异常 → wiki 域异常映射膜（路由只认 wiki 族：30040/30041/90002）。
  private mapArchiveError(err: unknown, relPath: string): Error {
    if (err instanceof FileNotFound) return new WikiPageNotFound(relPath)
    if (err instanceof FileExists) return new WikiPageExists(relPath)
    if (err instanceof FileInvalidPath) return new WikiInvalidPath(relPath)
    return err as Error
  }

  // —— 缺省 docker 实现（生产路径；单测注入 fake 绕过）——

  // 全库快照：getArchive(FILE_ROOTS.wiki) 拉目录 tar（穿过 named volume 挂载点读卷数据），
  // 收集全量（总量防护）→ parseTar 收内容（单文件 16MB 上限）→ strip 根前缀成相对 wiki/main。
  // daemon 404（容器不存在 / wiki 目录不存在）→ null；快照超 SNAPSHOT_MAX_BYTES → null（降级）。
  private async defaultSnapshot(docker: Docker): Promise<TarEntry[] | null> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker.getContainer(containerName(this.name)).getArchive({ path: FILE_ROOTS.wiki })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const buf = await this.collect(stream, SNAPSHOT_MAX_BYTES)
    if (buf === null) {
      // eslint-disable-next-line no-console
      console.warn(`[wiki] snapshot 超 ${SNAPSHOT_MAX_BYTES}B 降级空树: container=${this.name}`)
      return null
    }
    const entries = parseTar(buf, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
    const root = entries[0]
    if (!root) return []
    // Docker 目录 getArchive：根条目 = basename（'main'），子条目带 'main/' 前缀（对齐
    // DockerFileArchive.read 目录分支 strip 语义）。
    const prefix = normalizeTarName(root.name)
    const out: TarEntry[] = []
    for (const t of entries.slice(1)) {
      const raw = normalizeTarName(t.name)
      if (raw === null) continue
      const name = prefix !== null && raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : raw
      if (name === '') continue
      out.push({ ...t, name })
      if (out.length >= WALK_LIMIT) break // 条目数上限（对齐 files 域 WALK_LIMIT 防护）
    }
    return out
  }

  // 单文件 probe：getArchive 单文件路径，受 SNAPSHOT_MAX_BYTES（64MB）内存防护——超限返
  // WikiInvalidPath（合法 wiki 页受路由 body limit 约束远小于此，不可达；防护防失控 daemon 流）。
  private async defaultProbeFile(docker: Docker, relPath: string): Promise<WikiProbeResult> {
    let stream: NodeJS.ReadableStream
    try {
      stream = await docker
        .getContainer(containerName(this.name))
        .getArchive({ path: `${FILE_ROOTS.wiki}/${relPath}` })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
    const buf = await this.collect(stream, SNAPSHOT_MAX_BYTES)
    if (buf === null) throw new WikiInvalidPath(relPath) // 单文件超总量上限：拒（不进内存）
    const entries = parseTar(buf, { collectData: true })
    const root = entries[0]
    if (!root) return null
    if (root.type === 'directory') return { kind: 'dir' }
    if (root.type !== 'file') return { kind: 'link' } // symlink / 特殊类型
    return { kind: 'file', data: root.data ?? Buffer.alloc(0) }
  }

  // 流收集全量字节；超 maxBytes 中止（for-await break 销毁流）→ null。
  private async collect(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer | null> {
    const parts: Buffer[] = []
    let total = 0
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length
      if (total > maxBytes) return null
      parts.push(chunk)
    }
    return Buffer.concat(parts)
  }
}
