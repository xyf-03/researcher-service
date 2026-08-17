// seam: wiki API client —— issue #45 前端数据层（spec §6）。
// 覆盖：tree/page CRUD/graph 的 URL 拼接、method、body、path query 编码。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createPage,
  deletePage,
  getCategories,
  getGraph,
  getTree,
  readPage,
  updatePage,
} from '@/api/wiki'

// 默认 application/json——后端 #312 信封响应经 res.json() 恒带该头；apiFetch 现按 Content-Type 决定
// 是否做信封 sniff，mock 须建模真实响应头（否则非 JSON 200 会误走「跳过 sniff」分支）。
function mockResp(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response
}

describe('wiki api client', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  function lastCall(): [string, RequestInit] {
    const m = globalThis.fetch as ReturnType<typeof vi.fn>
    return [m.mock.calls[0][0] as string, (m.mock.calls[0][1] ?? {}) as RequestInit]
  }

  it('getTree hits container wiki tree endpoint', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ groups: [] }))
    await getTree('demo')
    expect(lastCall()[0]).toBe('/api/v1/containers/demo/wiki/tree')
  })

  it('readPage encodes path as query', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await readPage('demo', 'domains/cv/papers/resnet.md')
    expect(lastCall()[0]).toBe(
      '/api/v1/containers/demo/wiki/page?path=domains%2Fcv%2Fpapers%2Fresnet.md',
    )
  })

  it('updatePage PUTs path+content', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await updatePage('demo', 'concepts/a.md', '# hi')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/containers/demo/wiki/page')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'concepts/a.md', content: '# hi' })
  })

  it('createPage POSTs path+content', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 201))
    await createPage('demo', 'concepts/b.md', 'x')
    const [, init] = lastCall()
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'concepts/b.md', content: 'x' })
  })

  it('deletePage DELETEs with path query, tolerates 404', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 204))
    await deletePage('demo', 'concepts/a.md')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/containers/demo/wiki/page?path=concepts%2Fa.md')
    expect(init.method).toBe('DELETE')
  })

  // PR #370 第四轮 #9（P0）：TS 后端越权/不存在删除恒 HTTP 200 + code:20040——旧 apiFetch+resp.ok
  // 当成功。改 apiJson 后须对 code!==0 抛。
  it('deletePage throws ApiError(20040) on envelope forbidden/not-found', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 20040, message: '容器不存在或无权访问', data: null }),
    )
    await expect(deletePage('demo', 'concepts/a.md')).rejects.toMatchObject({ code: 20040 })
  })

  it('getGraph hits graph endpoint', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ nodes: [], edges: [] }))
    await getGraph('demo')
    expect(lastCall()[0]).toBe('/api/v1/containers/demo/wiki/graph')
  })

  it('getCategories hits categories endpoint and parses grouped map', async () => {
    const body = {
      idea: [{ path: 'a.md', title: 'A', category: 'idea', excerpt: '…' }],
      // 未知 category 值也按开放词表原样成组返回
      'x-new': [{ path: 'b.md', title: 'B', category: 'x-new', excerpt: '…' }],
    }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(body))
    const res = await getCategories('demo')
    expect(lastCall()[0]).toBe('/api/v1/containers/demo/wiki/categories')
    expect(res).toEqual(body)
  })
})
