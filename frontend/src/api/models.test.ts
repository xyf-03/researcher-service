// seam: models API —— URL 契约（spec §7）。codex #65 意见1：集合与详情 URL 须带尾斜杠，
// 精确匹配后端 providers/ 与 providers/<pid>/ 路由——否则 CommonMiddleware APPEND_SLASH 把 POST
// 301 到带斜杠 URL、Fetch 以 GET 重发，致创建静默失败。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { createProvider, listProviders, removeProvider, updateProvider } from '@/api/models'

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

const PAYLOAD = {
  provider_id: 'my-openai',
  api: 'openai-completions' as const,
  base_url: 'https://x/v1',
  api_key_env_id: 'LLM_API_KEY',
  auth_header: true,
  models: [{ id: 'g', name: 'G' }],
}

describe('models api URLs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listProviders GETs the collection with trailing slash', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([]))
    await listProviders('demo')
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/models/providers/')
  })

  it('createProvider POSTs to the collection with trailing slash (no silent 301→GET)', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 201))
    await createProvider('demo', PAYLOAD)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/models/providers/')
    expect(init.method).toBe('POST')
  })

  it('updateProvider PUTs to the detail URL with trailing slash', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await updateProvider('demo', 'my-openai', PAYLOAD)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/models/providers/my-openai/')
    expect(init.method).toBe('PUT')
  })

  it('removeProvider DELETEs the detail URL with trailing slash', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 204))
    await removeProvider('demo', 'my-openai')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/models/providers/my-openai/')
    expect(init.method).toBe('DELETE')
  })

  // PR #370 第四轮 #9（P0）：TS 后端越权/不存在删除恒 HTTP 200 + code:20040——旧 apiFetch+resp.ok
  // 当成功。改 apiJson 后须对 code!==0 抛。
  it('removeProvider throws ApiError(20040) on envelope forbidden/not-found', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 20040, message: '容器不存在或无权访问', data: null }),
    )
    await expect(removeProvider('demo', 'my-openai')).rejects.toMatchObject({ code: 20040 })
  })

  it('encodes pid path segment', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 204))
    await removeProvider('demo', 'a b/c')
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/models/providers/a%20b%2Fc/')
  })
})
