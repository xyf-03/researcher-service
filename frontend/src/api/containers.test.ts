// seam: containers API —— list/create/remove（spec §9.3 容器管理页后端契约）。
// 出处：docs/FULLSTACK-REFACTOR-SPEC.md §9.3（列表 status/health/port + 新建 + 删除）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { createInstance, listInstances, removeInstance } from '@/api/containers'

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

const SAMPLE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'img',
  container_id: 'cid',
  created_at: '2026-07-24T00:00:00Z',
}

describe('containers api', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listInstances GETs /api/v1/containers/', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([SAMPLE]))
    const items = await listInstances()
    expect(items).toEqual([SAMPLE])
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/')
  })

  // PR #370 第四轮 R4-1（P0）：TS 控制面 #312 信封下，listInstances 必须返回 data 解包后的数组，
  // 不是整个信封 {code,message,data}。调用方 ContainersView.map / ChatView.loadInstances.length
  // 依赖它是数组——apiJson 不解包会让主线「容器列表 → selectContainer → 隧道」全断。
  // 旧用例 mock 喂裸数组掩盖此路径；此用例用真实 TS 信封形状钉死契约。
  it('listInstances unwraps TS envelope data into the array', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: [SAMPLE] }),
    )
    const items = await listInstances()
    expect(Array.isArray(items)).toBe(true)
    expect(items).toEqual([SAMPLE])
  })

  it('createInstance POSTs name body to /api/v1/containers/', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(SAMPLE, 201))
    const inst = await createInstance('demo')
    expect(inst.name).toBe('demo')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'demo' }))
  })

  it('removeInstance DELETEs /api/v1/containers/<name>', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 204))
    await removeInstance('demo')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo')
    expect(init.method).toBe('DELETE')
  })

  // PR #370 第四轮 #9（P0）：TS 后端越权/不存在删除恒 HTTP 200 + code:20040（同码防探测）——
  // 旧 apiFetch+resp.ok 把它当成功（删非属主容器「成功」）。改用 apiJson 后须对 code!==0 抛，
  // 调用方（ContainersView）据 toast 提示失败。
  it('removeInstance throws ApiError(20040) on envelope forbidden/not-found', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 20040, message: '容器不存在或无权访问', data: null }),
    )
    await expect(removeInstance('others')).rejects.toMatchObject({ code: 20040 })
  })
})
