// WikiService 聚合逻辑单测（#335 · 对 fake WikiFileSystem 直测，不碰磁盘/DB）。
// 契约锚点 = backend/wiki/tests/test_service_fake_fs.py + test_graph_api.py + test_categories_api.py。
// 验证：CRUD 域错误映射、listCategories 分组/排序/窗口、buildGraph 节点/边/ghost/不 dedup。
// fake 自 #621 起共享于 ./fakes（REST 契约测试 wiki.test.ts 同用）。

import { describe, it, expect } from 'vitest'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from '../src/wiki/errors'
import { WikiService } from '../src/wiki/service'
import { FakeWikiFileSystem } from './fakes'

function fixtureFs(): FakeWikiFileSystem {
  return new FakeWikiFileSystem({
    'concepts/attention.md': '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
    'concepts/transformer.md': '---\ntitle: Transformer\n---\n# T\n',
    'domains/cv/papers/resnet.md': '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
    'experiments/trial-1.md': '---\ntitle: Trial 1\n---\n# Trial 1\n',
  })
}

describe('WikiService CRUD（fake FS）', () => {
  it('build_tree：按页面真实顶层目录分组，未知目录也成组；无页目录不成组', async () => {
    const svc = new WikiService(fixtureFs())
    const tree = await svc.buildTree()
    const kinds = tree.groups.map((g) => g.kind)
    expect(kinds).toEqual(expect.arrayContaining(['concepts', 'domains', 'experiments']))
    expect(kinds).not.toContain('concept')
    expect(kinds).not.toContain('entities')
    const experiments = tree.groups.find((g) => g.kind === 'experiments')!
    expect(experiments.name).toBe('experiments')
    expect(experiments.pages.map((p) => p.path)).toEqual(['experiments/trial-1.md'])
  })

  it('read_page：原文 + frontmatter title', async () => {
    const svc = new WikiService(fixtureFs())
    const page = await svc.readPage('concepts/attention.md')
    expect(page.path).toBe('concepts/attention.md')
    expect(page.title).toBe('Attention')
    expect(page.content).toContain('# Attention')
  })

  it('read_page 缺失 → WikiPageNotFound', async () => {
    await expect(new WikiService(fixtureFs()).readPage('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('write_page 覆写；缺失 → WikiPageNotFound', async () => {
    const svc = new WikiService(fixtureFs())
    await svc.writePage('concepts/attention.md', '# 已编辑\n')
    expect((await svc.readPage('concepts/attention.md')).content).toBe('# 已编辑\n')
    await expect(svc.writePage('concepts/nope.md', 'x')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('create_page 新建；已存在 → WikiPageExists', async () => {
    const svc = new WikiService(fixtureFs())
    await svc.createPage('concepts/new.md', '# New\n')
    expect((await svc.readPage('concepts/new.md')).content).toBe('# New\n')
    await expect(svc.createPage('concepts/attention.md', 'x')).rejects.toBeInstanceOf(WikiPageExists)
  })

  it('delete_page 删除；缺失 → WikiPageNotFound', async () => {
    const svc = new WikiService(fixtureFs())
    await svc.deletePage('concepts/attention.md')
    await expect(svc.readPage('concepts/attention.md')).rejects.toBeInstanceOf(WikiPageNotFound)
    await expect(svc.deletePage('concepts/nope.md')).rejects.toBeInstanceOf(WikiPageNotFound)
  })

  it('路径越权（穿越/managed 目录/managed 文件）在 CRUD 全路径上抛 WikiInvalidPath', async () => {
    const svc = new WikiService(fixtureFs())
    const cases: Array<() => Promise<unknown>> = [
      () => svc.readPage('../../evil.md'),
      () => svc.readPage('.openclaw-wiki/evil.md'),
      () => svc.readPage('concepts/index.md'),
      () => svc.writePage('../../evil.md', 'x'),
      () => svc.createPage('.openclaw-wiki/evil.md', 'x'),
      () => svc.createPage('concepts/index.md', 'x'),
      () => svc.deletePage('../../evil.md', ),
      () => svc.deletePage('.openclaw-wiki/evil.md'),
    ]
    for (const fn of cases) {
      await expect(fn()).rejects.toBeInstanceOf(WikiInvalidPath)
    }
  })
})

describe('WikiService listCategories（fake FS）', () => {
  function catFs(): FakeWikiFileSystem {
    return new FakeWikiFileSystem({
      'thoughts/idea-1.md':
        '---\ntitle: First Idea\n---\n# First Idea\n\n`category: idea`\n\nIdea 第一段摘录。\n\n## Detail\n\n`category: 误抓`\n',
      'thoughts/crit-1.md': '# Crit One\n\n`Category: critic`\n\nCritic 摘录。\n',
      'domains/cv/papers/odd-1.md': '---\ntitle: Odd\n---\n# Odd\n\n`category: deep-think.v2`\n\nOdd 摘录。\n',
      'concepts/attention.md': '---\ntitle: Attention\n---\n# Attention\n',
      // 顶层散落页（build_tree 不收、categories 收）
      'root-note.md': '# Root Note\n\n`category: rootcat`\n\nRoot 摘录。\n',
      // 反例
      'concepts/inline-mention.md': '# Mention\n\n正文里说 `category: fake` 是混在行内的。\n',
      'concepts/before-h1.md': '`category: fake`\n\n# Late Title\n\n正文。\n',
      'concepts/after-h2.md': '# Sec Title\n\n## section\n\n`category: fake`\n',
    })
  }

  it('按 category 分组；开放词表；大小写归一；跨目录归一组；组名/组内按字典序', async () => {
    const data = await new WikiService(catFs()).listCategories()
    expect(Object.keys(data).sort()).toEqual(['critic', 'deep-think.v2', 'idea', 'rootcat'])
    expect(data.idea.map((i) => i.path)).toEqual(['thoughts/idea-1.md'])
    expect(data.critic[0].category).toBe('critic')
    expect(data['deep-think.v2'][0].path).toBe('domains/cv/papers/odd-1.md')
  })

  it('条目含 path/title/category/excerpt；title 无 frontmatter → H1；excerpt 剥标题行', async () => {
    const data = await new WikiService(catFs()).listCategories()
    const idea = data.idea[0]
    expect(idea.title).toBe('First Idea') // frontmatter title
    expect(idea.excerpt).toContain('Idea 第一段摘录')
    expect(idea.excerpt).not.toContain('# First Idea')
    expect(data.critic[0].title).toBe('Crit One') // 无 frontmatter → H1
  })

  it('窗口反例：行内混排 / H1 之前 / 首个 ## 之后的标记不抓；无标记页不进响应', async () => {
    const data = await new WikiService(catFs()).listCategories()
    expect('fake' in data).toBe(false)
    expect('误抓' in data).toBe(false)
    const allPaths = Object.values(data).flat().map((i) => i.path)
    expect(allPaths).not.toContain('concepts/attention.md')
    expect(allPaths).not.toContain('concepts/inline-mention.md')
    expect(allPaths).not.toContain('concepts/before-h1.md')
    expect(allPaths).not.toContain('concepts/after-h2.md')
  })

  it('顶层散落页带标记也进聚合（list_category_pages 收顶层）', async () => {
    const data = await new WikiService(catFs()).listCategories()
    expect(data.rootcat.map((i) => i.path)).toEqual(['root-note.md'])
  })

  it('category 值为 Object.prototype 成员名（constructor/toString）不崩溃（开放词表）', async () => {
    const fs = new FakeWikiFileSystem({
      'a/p.md': '# P\n\n`category: constructor`\n\n正文。\n',
      'b/q.md': '# Q\n\n`category: toString`\n\n正文。\n',
    })
    const data = await new WikiService(fs).listCategories()
    // category 值小写归一：toString → tostring；两个原型成员名都不崩、都成组
    expect(Object.keys(data).sort()).toEqual(['constructor', 'tostring'])
    expect(data['constructor'][0].path).toBe('a/p.md')
    expect(data['tostring'][0].path).toBe('b/q.md')
  })

  it('category 值为 __proto__ → 仍是枚举键，不触发原型 setter 而丢失（codex PR#346）', async () => {
    const fs = new FakeWikiFileSystem({
      'a/p.md': '# P\n\n`category: __proto__`\n\n正文。\n',
    })
    const data = await new WikiService(fs).listCategories()
    expect(Object.keys(data)).toContain('__proto__')
    expect(data['__proto__'][0].path).toBe('a/p.md')
    expect(data['__proto__'][0].category).toBe('__proto__')
  })

  it('category 名含非 BMP 与高 BMP 字符按 Unicode code-point 序（对齐 Python，codex 第五轮 P2）', async () => {
    const fs = new FakeWikiFileSystem({
      'a/emoji.md': '# P\n\n`category: 😀cat`\n\n正文。\n',
      'b/full.md': '# Q\n\n`category: Ａcat`\n\n正文。\n',
    })
    const data = await new WikiService(fs).listCategories()
    // code-point 序:fullwidth U+FF21(65313) < emoji U+1F600(128512) → 小写化的 ａcat 在前;
    // 默认 sort() 按 UTF-16 code-unit 序,emoji 代理对(0xD83D=55357)会排在前面 → 顺序相反
    expect(Object.keys(data)).toEqual(['ａcat', '😀cat'])
  })

  it('同 category 组内 path 按 code-point 序（非 BMP 字符，codex 第五轮 P2）', async () => {
    const fs = new FakeWikiFileSystem({
      'x/😀p.md': '# P\n\n`category: c`\n\n正文。\n',
      'x/Ａp.md': '# Q\n\n`category: c`\n\n正文。\n',
    })
    const data = await new WikiService(fs).listCategories()
    expect(data.c.map((i) => i.path)).toEqual(['x/Ａp.md', 'x/😀p.md'])
  })
})

describe('WikiService buildGraph（fake FS）', () => {
  it('节点 = tree 全部页；wikilink 不可解析 → ghost 节点', async () => {
    const graph = await new WikiService(fixtureFs()).buildGraph()
    const nodeIds = graph.nodes.map((n) => n.id)
    expect(nodeIds).toEqual(expect.arrayContaining(['concepts/attention.md', 'domains/cv/papers/resnet.md']))
    const ghost = graph.nodes.find((n) => n.id === 'self-attention')
    expect(ghost).toMatchObject({ id: 'self-attention', title: 'self-attention', ghost: true })
    expect(graph.edges).toContainEqual({ from: 'concepts/attention.md', to: 'self-attention' })
  })

  it('related_pages（字符串/列表）出边；stem 解析到真实节点', async () => {
    const graph = await new WikiService(fixtureFs()).buildGraph()
    expect(graph.edges).toContainEqual({ from: 'domains/cv/papers/resnet.md', to: 'concepts/attention.md' })
  })

  it('边不 dedup：同页多次引用同一目标产生多条同 from/to 边', async () => {
    const fs = new FakeWikiFileSystem({
      'a/x.md': '# X\n\n[[y]]\n\n再引 [[y]]\n',
    })
    const graph = await new WikiService(fs).buildGraph()
    const dup = graph.edges.filter((e) => e.from === 'a/x.md' && e.to === 'y')
    expect(dup.length).toBe(2)
  })

  it('同一 from→to 先 resolve 真节点与 ghost 并存（wikiLink 别名/related 混用）', async () => {
    const fs = new FakeWikiFileSystem({
      'a/p.md': '---\nrelated_pages: [b/t.md]\n---\n# P\n\n[[b/t]]\n',
      'b/t.md': '# T\n',
    })
    const graph = await new WikiService(fs).buildGraph()
    const edges = graph.edges.filter((e) => e.from === 'a/p.md')
    // [[b/t]] 的 stem `t` 匹配 b/t.md → 真节点；related_pages 整串 b/t.md → 真节点。两条同 to。
    expect(edges.every((e) => e.to === 'b/t.md')).toBe(true)
    expect(edges.length).toBe(2)
  })

  it('单页读不出 → 跳过该页的边，不 500', async () => {
    const fs = new FakeWikiFileSystem({ 'a/x.md': '# X\n\n[[y]]\n' })
    const original = fs.readPage.bind(fs)
    fs.readPage = async (rel) => {
      if (rel === 'a/x.md') throw new Error('read boom')
      return original(rel)
    }
    const graph = await new WikiService(fs).buildGraph()
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toHaveLength(0)
  })

  it('wikilink 目标为 Object.prototype 成员名（constructor）→ ghost 节点仍建', async () => {
    const fs = new FakeWikiFileSystem({ 'a/x.md': '# X\n\n[[constructor]]\n' })
    const graph = await new WikiService(fs).buildGraph()
    const ghost = graph.nodes.find((n) => n.id === 'constructor')
    expect(ghost).toMatchObject({ id: 'constructor', title: 'constructor', ghost: true })
    expect(graph.edges).toContainEqual({ from: 'a/x.md', to: 'constructor' })
  })

  it('wikilink 目标为 __proto__ → ghost 节点仍建（codex PR#346）', async () => {
    const fs = new FakeWikiFileSystem({ 'a/x.md': '# X\n\n[[__proto__]]\n' })
    const graph = await new WikiService(fs).buildGraph()
    const ghost = graph.nodes.find((n) => n.id === '__proto__')
    expect(ghost).toMatchObject({ id: '__proto__', title: '__proto__', ghost: true })
    expect(graph.edges).toContainEqual({ from: 'a/x.md', to: '__proto__' })
  })
})
