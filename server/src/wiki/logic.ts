// wiki 纯逻辑协作者（#335 · #315 §3 平移 backend/wiki/service.py 纯函数/纯逻辑层）。
// 与文件系统解耦：FrontmatterParser / CategoryMarkerExtractor / WikilinkResolver。
// 组合进 WikiService（service.ts）；单测注入 fake FS 直测，不需真实磁盘。
// 按 #315 §3 命名建议用小型不可组合对象，勿套类层级。

import { CATEGORY_RE, EXCERPT_LEN, H1_RE, H2_RE, WIKILINK_RE } from './values'

// 字典序比较（对齐 Python 的 Unicode code-point 序）。
// JS 的 `a < b` 按 UTF-16 code-unit 序：非 BMP 字符（emoji 等代理对 [D800–DFFF]）会排在高 BMP
// 字符（如 fullwidth U+FF21）之前，与 Python code-point 序相反。树/图/categories 排序与
// WikilinkResolver 对重复 stem/title 先见者优先——顺序反转让同一 [[target]] 边解析到不同页面
// （codex PR#346 第三轮 nodeFs / 第五轮 service）。按 code-point 比较。
export function cmp(a: string, b: string): number {
  const ax = [...a] // 按 Unicode code-point 迭代（解开代理对）
  const bx = [...b]
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i += 1) {
    const ca = ax[i].codePointAt(0) ?? 0
    const cb = bx[i].codePointAt(0) ?? 0
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return ax.length - bx.length
}

// frontmatter 值：标量或行内 [a,b] 列表（嵌套键如 paper:/claims: 被跳过，不解析）。
export type FrontmatterValue = string | string[]
export type Frontmatter = Record<string, FrontmatterValue>

// Python str.strip(chars) 语义：先剥首尾所有 `"`、再剥首尾所有 `'`（顺序与实现同 Django）。
function stripQuotes(v: string): string {
  return v.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
}

// 简易逐行 YAML frontmatter 解析（r29 §3.4：人读浏览页只需 title 与标量标签，不引入 yaml 库）。
// 坑（#315 §3 原样保留）：content.find('---', 3) 会把正文里任意 `---`（含 `----` 分隔线）当
// frontmatter 结束——逐字平移此歧义，勿「修正」为严格 YAML。
export class FrontmatterParser {
  parse(content: string): { frontmatter: Frontmatter; body: string } {
    const frontmatter: Frontmatter = {}
    let body = content
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3)
      if (end > 0) {
        const yamlText = content.slice(3, end).trim()
        body = content.slice(end + 3).trim()
        for (const rawLine of yamlText.split('\n')) {
          const line = rawLine.trimEnd() // Python line.rstrip()
          if (!line || line.startsWith('#')) continue
          const colon = line.indexOf(':')
          if (colon < 0) continue
          const key = line.slice(0, colon).trim()
          let val: string | string[] = line.slice(colon + 1).trim()
          if (val.startsWith('[') && val.endsWith(']')) {
            val = val
              .slice(1, -1)
              .split(',')
              .filter((v) => v.trim() !== '')
              .map((v) => stripQuotes(v.trim()))
          } else if (val) {
            val = stripQuotes(val)
          } else {
            continue // 嵌套键（paper:/claims:）无行内值，跳过
          }
          if (key && val !== '') frontmatter[key] = val
        }
      }
    }
    return { frontmatter, body }
  }
}

// 从 markdown 正文提取 `` `category:` `` 机读标记 + 摘要（issue #84 / spec #75）。
// 提取只在「第一个 H1 之下、首个 `##` 之前」窗口内：行内混排、H1 之前、首个 `##` 之后的标记不抓。
// 开放词表：扫到什么值返回什么，不预设集合。
export class CategoryMarkerExtractor {
  extractCategory(body: string): string | null {
    const window = this.window(body)
    if (window === null) return null
    const m = CATEGORY_RE.exec(window)
    return m ? m[1].toLowerCase() : null
  }

  // 正文开头片段摘要：剥掉 H1 标题行与 category 标记行，压缩空白后按码点截断。
  excerpt(body: string): string {
    const lines = body.split('\n').filter((ln) => {
      if (!ln.trim()) return false
      if (ln.startsWith('# ')) return false
      if (CATEGORY_RE.test(ln)) return false
      return true
    })
    const text = lines.join(' ').replace(/\s+/g, ' ').trim()
    return Array.from(text).slice(0, EXCERPT_LEN).join('')
  }

  private window(body: string): string | null {
    const lines = body.split('\n')
    const h1 = lines.findIndex((ln) => H1_RE.test(ln))
    if (h1 < 0) return null
    const h2 = lines.findIndex((ln, i) => i > h1 && H2_RE.test(ln))
    const end = h2 < 0 ? lines.length : h2
    return lines.slice(h1 + 1, end).join('\n')
  }
}

// 把 wikilink 目标解析为节点 id（path 末段 stem / title / 整串 id 兜底，r29 §3.3 先见者优先）。
// 构造注入全部页面（{path,title}）；重复 stem/title 用 setdefault 语义（先见者不覆盖）。
export class WikilinkResolver {
  private readonly byStem = new Map<string, string>()
  private readonly byTitle = new Map<string, string>()
  private readonly ids = new Set<string>()

  constructor(pages: readonly { path: string; title: string }[]) {
    for (const p of pages) {
      const path = p.path
      this.ids.add(path)
      const stem = path.endsWith('.md')
        ? path.slice(path.lastIndexOf('/') + 1, -3)
        : path // 非 .md 时整串入 stem（与 Django else 分支一致；现实中 tree 页必 .md）
      if (!this.byStem.has(stem)) this.byStem.set(stem, path)
      if (p.title && !this.byTitle.has(p.title)) this.byTitle.set(p.title, path)
    }
  }

  resolve(target: string): string | null {
    const t = target.trim()
    if (this.ids.has(t)) return t
    let stem = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t
    if (stem.endsWith('.md')) stem = stem.slice(0, -3)
    const byStem = this.byStem.get(stem)
    if (byStem !== undefined) return byStem
    const byTitle = this.byTitle.get(t)
    if (byTitle !== undefined) return byTitle
    return null
  }
}

// 供 service.buildGraph 从正文取 wikilink 目标（[[target|别名]] 取 `|` 前、strip 空白）。
export function wikilinkTargets(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.push(m[1].split('|')[0].trim())
  }
  return out
}

// 页面标题 frontmatter 取值（Django `fm.get('paper.title') or fm.get('title')` or 链）。
// '' / 空数组视为缺失；title 若为列表（畸形边缘）收敛为字符串，前端 title 类型恒 string。
export function frontmatterTitle(frontmatter: Frontmatter): string | undefined {
  for (const key of ['paper.title', 'title'] as const) {
    const v = frontmatter[key]
    if (v === undefined) continue
    if (typeof v === 'string') return v === '' ? undefined : v
    if (Array.isArray(v) && v.length > 0) return v.join('')
  }
  return undefined
}

// UTF-8 严格解码：非法字节抛 TypeError（对齐 Python read_text(encoding='utf-8') 的
// UnicodeDecodeError；Node 默认 toString('utf8') 用 U+FFFD 静默替换，会破坏降级语义）。
// ignoreBOM:true 保留 U+FEFF（Python read_text 逐字节保留 BOM；默认 false 会吞掉——GET 不再原文
// 返回、round-trip 丢 BOM、解析层把 BOM 前缀页误识别成 frontmatter。codex PR#346）。
// （自 nodeFs.ts 搬入：Node 适配器退役后由 Docker 适配器复用。）
export function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
}

// 正文首个 `# ` 标题文本（无 frontmatter 时的标题兜底，categories 聚合用）；无 H1 返回 null。
// （自 nodeFs.ts 搬入，同上。）
export function h1Title(body: string): string | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) {
      const t = line.slice(2).trim()
      return t || null
    }
  }
  return null
}
