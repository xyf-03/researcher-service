// files path 请求层校验单测（#589 · paths.ts）。覆盖 #586 US10 穿越防护矩阵：
// 绝对路径/反斜杠/`..`/NUL/超长（Unicode code points 计长）/归一化折叠/空串=树根。

import { describe, it, expect } from 'vitest'
import {
  normalizeFilePath,
  normalizeFileRoot,
  parseFileWriteBody,
  requireFilePath,
  requireFileRoot,
} from '../src/files/paths'
import { CODE } from '../src/codes'
import { EnvelopeError } from '../src/envelope'

describe('normalizeFilePath 防护矩阵（US10）', () => {
  it('空串 = 树根（列根目录合法）', () => {
    expect(normalizeFilePath('')).toEqual({ ok: true, path: '' })
  })

  it('绝对路径（/ 开头）与反斜杠开头 → 拒', () => {
    expect(normalizeFilePath('/etc/passwd').ok).toBe(false)
    expect(normalizeFilePath('\\etc\\passwd').ok).toBe(false)
  })

  it('含反斜杠（非开头）→ 拒', () => {
    expect(normalizeFilePath('a\\b.md').ok).toBe(false)
  })

  it('目录穿越（.. 段）→ 拒', () => {
    expect(normalizeFilePath('../evil.md').ok).toBe(false)
    expect(normalizeFilePath('a/../../evil.md').ok).toBe(false)
    expect(normalizeFilePath('a/..').ok).toBe(false)
  })

  it('NUL 字节 → 拒', () => {
    expect(normalizeFilePath('a\u0000b.md').ok).toBe(false)
  })

  it('缺省（undefined/null）→ 树根（query 未传 path = 列根目录）；非字符串 → 拒', () => {
    expect(normalizeFilePath(undefined)).toEqual({ ok: true, path: '' })
    expect(normalizeFilePath(null)).toEqual({ ok: true, path: '' })
    expect(normalizeFilePath(42).ok).toBe(false)
  })

  it('归一化折叠：// 与 . 段折叠重 join', () => {
    expect(normalizeFilePath('a//b/./c.md')).toEqual({ ok: true, path: 'a/b/c.md' })
    expect(normalizeFilePath('a///')).toEqual({ ok: true, path: 'a' })
    expect(normalizeFilePath('./x.md')).toEqual({ ok: true, path: 'x.md' })
  })

  it('放宽 wiki .md 限制：任意扩展/无扩展都合法（workspace 文本）', () => {
    expect(normalizeFilePath('notes.txt').ok).toBe(true)
    expect(normalizeFilePath('code/main.ts').ok).toBe(true)
    expect(normalizeFilePath('README').ok).toBe(true)
  })

  it('路径长度按 Unicode code points 计（≤512；emoji 不误拒）', () => {
    const seg = 'x😀' // 2 code points / 3 code units
    const deep = Array.from({ length: 150 }, () => seg).join('/') // 3*150-1=449 cp，4*150-1=599 cu
    expect(normalizeFilePath(deep).ok).toBe(true) // code points < 512，code units > 512
    expect(normalizeFilePath(`${'a'.repeat(513)}`)).toEqual({ ok: false, errors: ['path 过长'] })
  })

  it('文件名首尾空白保留（不做 trim）', () => {
    expect(normalizeFilePath(' leading.md')).toEqual({ ok: true, path: ' leading.md' })
  })
})

describe('normalizeFileRoot', () => {
  it('wiki / workspace 合法', () => {
    expect(normalizeFileRoot('wiki')).toEqual({ ok: true, root: 'wiki' })
    expect(normalizeFileRoot('workspace')).toEqual({ ok: true, root: 'workspace' })
  })

  it('其他值 / 大写 / 缺失 → 拒', () => {
    expect(normalizeFileRoot('home').ok).toBe(false)
    expect(normalizeFileRoot('WIKI').ok).toBe(false)
    expect(normalizeFileRoot(undefined).ok).toBe(false)
  })
})

describe('parseFileWriteBody（POST/PUT body）', () => {
  it('合法 body → {root,path,content} 逐字保留', () => {
    expect(parseFileWriteBody({ root: 'workspace', path: 'out/report.md', content: '# 正文\n' })).toEqual({
      root: 'workspace',
      path: 'out/report.md',
      content: '# 正文\n',
    })
  })

  it('root/path/content 错误一次性聚合进 data（对齐 wiki 双字段收集）', () => {
    try {
      parseFileWriteBody({ root: 'bogus', path: '../../evil', content: 42 })
      throw new Error('应当抛 90002')
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError)
      const e = err as EnvelopeError
      expect(e.code).toBe(CODE.VALIDATION_FAILED)
      expect(e.data).toHaveProperty('root')
      expect(e.data).toHaveProperty('path')
      expect(e.data).toHaveProperty('content')
    }
  })

  it('path 空串（树根）→ 90002（写操作必须指向文件）', () => {
    try {
      parseFileWriteBody({ root: 'wiki', path: '', content: 'x' })
      throw new Error('应当抛 90002')
    } catch (err) {
      expect((err as EnvelopeError).code).toBe(CODE.VALIDATION_FAILED)
      expect((err as EnvelopeError).data).toHaveProperty('path')
    }
  })

  it('path 缺省（undefined）→ 90002（body 校验不因归一化放行写树根）', () => {
    try {
      parseFileWriteBody({ root: 'wiki', content: 'x' })
      throw new Error('应当抛 90002')
    } catch (err) {
      expect((err as EnvelopeError).code).toBe(CODE.VALIDATION_FAILED)
      expect((err as EnvelopeError).data).toHaveProperty('path')
    }
  })

  it('content 含未配对 surrogate → 90002（不落盘）；emoji 放行', () => {
    try {
      parseFileWriteBody({ root: 'wiki', path: 'a.md', content: 'before\ud800after' })
      throw new Error('应当抛 90002')
    } catch (err) {
      expect((err as EnvelopeError).code).toBe(CODE.VALIDATION_FAILED)
      expect((err as EnvelopeError).data).toMatchObject({ content: expect.any(Array) })
    }
    expect(parseFileWriteBody({ root: 'wiki', path: 'a.md', content: '😀' }).content).toBe('😀')
  })
})

describe('requireFilePath / requireFileRoot（query 形态）', () => {
  it('GET 允许空 path（allowEmpty）', () => {
    expect(requireFilePath('', { allowEmpty: true })).toBe('')
    expect(() => requireFilePath('../x')).toThrow(EnvelopeError)
  })

  it('DELETE 空 path → 90002（无删除语义）', () => {
    try {
      requireFilePath('')
      throw new Error('应当抛 90002')
    } catch (err) {
      expect((err as EnvelopeError).code).toBe(CODE.VALIDATION_FAILED)
      expect((err as EnvelopeError).data).toHaveProperty('path')
    }
  })

  it('requireFileRoot 非法 → 90002 + data.root', () => {
    try {
      requireFileRoot('home')
      throw new Error('应当抛 90002')
    } catch (err) {
      const e = err as EnvelopeError
      expect(e.code).toBe(CODE.VALIDATION_FAILED)
      expect(e.data).toHaveProperty('root')
    }
  })
})
