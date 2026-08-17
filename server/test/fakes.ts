// 测试共享 fake（#621）：内存 WikiFileSystem（wiki 域 Port，src/wiki/fsPort.ts）。
// 供 wiki.test.ts（REST 契约，经 serviceFor 注入）与 wikiService.test.ts（service 聚合逻辑）共用。
// 行为语义对齐生产适配器（DockerWikiFileSystem / 退役的 NodeWikiFileSystem）：
//   - validatePath：拒 `..` / SKIP_DIRS 段 / SKIP_FILES 末段 → WikiInvalidPath（managed 黑名单）；
//   - buildTree：按顶层目录分组，顶层散落页不收；title = frontmatter → stem（**无 H1**，对齐真实现）；
//   - readPage：title = frontmatter → stem（**无 H1**）；
//   - listCategoryPages：全量（含顶层散落页）；title = frontmatter → H1 → stem。

import { FrontmatterParser, frontmatterTitle, h1Title } from '../src/wiki/logic'
import { SKIP_DIRS, SKIP_FILES } from '../src/wiki/values'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from '../src/wiki/errors'
import type {
  WikiCategoryPage,
  WikiFileSystem,
  WikiTree,
  WikiTreeGroup,
  WikiTreePage,
} from '../src/wiki/fsPort'

export class FakeWikiFileSystem implements WikiFileSystem {
  pages = new Map<string, string>()

  constructor(entries: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(entries)) this.pages.set(k, v)
  }

  private validatePath(relPath: string): void {
    const parts = relPath.split('/').filter(Boolean)
    if (parts.some((p) => p === '..')) throw new WikiInvalidPath(relPath)
    if (parts.some((p) => SKIP_DIRS.has(p))) throw new WikiInvalidPath(relPath)
    if (parts.length && SKIP_FILES.has(parts[parts.length - 1])) throw new WikiInvalidPath(relPath)
  }

  // 扫描侧 SKIP 过滤（buildTree/listCategoryPages 用）：任一段命中 SKIP_DIRS 或末段命中
  // SKIP_FILES → 跳过（对齐生产适配器 isPageEntry；写侧 CRUD 才是 validatePath 拒绝）。
  private isSkipped(relPath: string): boolean {
    const parts = relPath.split('/')
    if (parts.some((p) => SKIP_DIRS.has(p))) return true
    return SKIP_FILES.has(parts[parts.length - 1])
  }

  private stemOf(relPath: string): string {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1)
    return base.endsWith('.md') ? base.slice(0, -3) : base
  }

  // buildTree / readPage 的 title 链：frontmatter → stem（无 H1 fallback，对齐真实现）。
  private treeTitleOf(content: string, stem: string): string {
    const { frontmatter } = new FrontmatterParser().parse(content)
    return frontmatterTitle(frontmatter) ?? stem
  }

  async buildTree(): Promise<WikiTree> {
    const groups = new Map<string, WikiTreeGroup>()
    for (const rel of [...this.pages.keys()].sort()) {
      if (!rel.endsWith('.md')) continue // 只收 .md（对齐生产适配器）
      if (this.isSkipped(rel)) continue // 扫描侧 SKIP 过滤（写侧才是 validatePath 拒绝）
      const slash = rel.indexOf('/')
      if (slash < 0) continue // 顶层散落页不收（categories 才收）
      const top = rel.slice(0, slash)
      const item: WikiTreePage = { path: rel, title: this.treeTitleOf(this.pages.get(rel)!, this.stemOf(rel)) }
      if (!groups.has(top)) groups.set(top, { kind: top, name: top, pages: [] })
      groups.get(top)!.pages.push(item)
    }
    return { groups: [...groups.values()].map((g) => ({ kind: g.kind, name: g.name, pages: g.pages })) }
  }

  async readPage(relPath: string): Promise<{ path: string; title: string; content: string }> {
    this.validatePath(relPath)
    const content = this.pages.get(relPath)
    if (content === undefined) throw new WikiPageNotFound(relPath)
    return { path: relPath, title: this.treeTitleOf(content, this.stemOf(relPath)), content }
  }

  async listCategoryPages(): Promise<WikiCategoryPage[]> {
    const out: WikiCategoryPage[] = []
    for (const [rel, content] of this.pages) {
      if (!rel.endsWith('.md')) continue // 只收 .md（对齐生产适配器）
      if (this.isSkipped(rel)) continue // 扫描侧 SKIP 过滤（不抛）
      const stem = this.stemOf(rel)
      const { frontmatter, body } = new FrontmatterParser().parse(content)
      // categories 聚合的 title 链：frontmatter → H1 → stem（对齐真实现 listCategoryPages）。
      const title = frontmatterTitle(frontmatter) ?? h1Title(body) ?? stem
      out.push({ path: rel, title, content })
    }
    return out
  }

  async writePage(relPath: string, content: string): Promise<{ path: string }> {
    this.validatePath(relPath)
    if (!this.pages.has(relPath)) throw new WikiPageNotFound(relPath)
    this.pages.set(relPath, content)
    return { path: relPath }
  }

  async createPage(relPath: string, content: string): Promise<{ path: string }> {
    this.validatePath(relPath)
    if (this.pages.has(relPath)) throw new WikiPageExists(relPath)
    this.pages.set(relPath, content)
    return { path: relPath }
  }

  async deletePage(relPath: string): Promise<void> {
    this.validatePath(relPath)
    if (!this.pages.has(relPath)) throw new WikiPageNotFound(relPath)
    this.pages.delete(relPath)
  }
}
