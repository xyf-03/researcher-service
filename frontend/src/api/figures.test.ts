// seam: figures API —— AutoFigure 域 REST 投影（T09）。
// 契约对齐 docs/autofigure/tickets/T09-vue-figure-journey.md + 后端 figures/routes（T01–T06）：
// 幂等创建带 Idempotency-Key 头、#312 信封解包、PNG 原生字节 vs 信封错误按 Content-Type 判别。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { ApiError, apiFetch } from '@/api/client'
import {
  createFigure,
  getFigureDetail,
  getFigurePngBlob,
  listFigures,
} from '@/api/figures'

function mockResp(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    blob: async () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
  } as unknown as Response
}

const SAMPLE = {
  figureId: 'f-1',
  jobId: 'j-1',
  prompt: 'draw a pipeline',
  status: 'queued',
  createdAt: '2026-08-01T00:00:00Z',
}

describe('figures api', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('createFigure POSTs prompt body with Idempotency-Key header', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { ...SAMPLE, status: 'queued' } }),
    )
    const result = await createFigure('draw a pipeline', 'key-1')
    expect(result.figureId).toBe('f-1')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures')
    expect(init.method).toBe('POST')
    expect(init.headers).toBeInstanceOf(Headers)
    expect(init.headers.get('Idempotency-Key')).toBe('key-1')
    expect(init.body).toBe(JSON.stringify({ prompt: 'draw a pipeline' }))
  })

  it('createFigure throws ApiError 70041 on idempotency conflict envelope', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({
        code: 70041,
        message: '幂等键已用于不同输入，请勿复用同一 Idempotency-Key 提交不同创建载荷',
        data: null,
      }),
    )
    const err = await createFigure('other', 'key-1').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(70041)
    expect((err as ApiError).message).toContain('幂等键已用于不同输入')
  })

  it('createFigure throws ApiError 90002 on validation envelope (missing key)', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 90002, message: '参数校验失败', data: null }),
    )
    const err = await createFigure('p', '').catch((e) => e)
    expect((err as ApiError).code).toBe(90002)
  })

  it('listFigures GETs /api/v1/figures and unwraps envelope array', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: [SAMPLE] }),
    )
    const items = await listFigures()
    expect(items).toEqual([SAMPLE])
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures')
  })

  it('getFigureDetail GETs /api/v1/figures/:id', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({
        code: 0,
        message: 'ok',
        data: { ...SAMPLE, status: 'succeeded', errorMessage: null, updatedAt: '2026-08-01T00:01:00Z' },
      }),
    )
    const detail = await getFigureDetail('f-1')
    expect(detail.figureId).toBe('f-1')
    expect(detail.status).toBe('succeeded')
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures/f-1')
  })

  it('getFigurePngBlob returns raw Blob for image/png content-type', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 200, 'image/png'))
    const blob = await getFigurePngBlob('f-1')
    expect(blob).toBeInstanceOf(Blob)
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures/f-1/png')
  })

  it('getFigurePngBlob throws ApiError 70042 on JSON envelope error', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 70042, message: 'Figure 尚未生成完成，请稍后再试', data: null }),
    )
    const err = await getFigurePngBlob('f-1').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(70042)
  })

  it('getFigurePngBlob throws ApiError 70043 when PNG unavailable', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 70043, message: 'Figure 无可用 PNG（生成失败或产物缺失）', data: null }),
    )
    const err = await getFigurePngBlob('f-1').catch((e) => e)
    expect((err as ApiError).code).toBe(70043)
  })

  it('module surface exports no delete/remove operation (V1 no-delete)', async () => {
    const mod = await import('@/api/figures')
    const names = Object.keys(mod)
    expect(names.some((k) => /delete|remove/i.test(k))).toBe(false)
  })
})

// T09 Spec-1（二进制 body 守卫）：真实 Response 严格建模 bodyUsed/Content-Type——PNG 成功经 apiFetch
// 后 body 不得被消费（后续 blob() 可用）；getFigurePngBlob 成功 blob() 原生字节；JSON 错误信封保留
// 70040/70042/70043 精确 code；JSON 10001 信封仍触发既有刷新链（auth 行为无回归）。
describe('getFigurePngBlob binary body safety（真实 Response）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function realPngResponse(): Response {
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  function realEnvResponse(code: number, message: string): Response {
    return new Response(JSON.stringify({ code, message, data: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('image/png 200 经 apiFetch 后 body 未被消费（bodyUsed=false）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(realPngResponse())
    const resp = await apiFetch('/api/v1/figures/f-1/png')
    expect(resp.headers.get('content-type')).toContain('image/png')
    expect(resp.bodyUsed).toBe(false) // 未读 body —— 后续 resp.blob() 可用
  })

  it('getFigurePngBlob 成功 blob() 原生 PNG 字节', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(realPngResponse())
    const blob = await getFigurePngBlob('f-1')
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(8)
  })

  it('JSON 错误信封保留 70040/70042/70043 精确 code', async () => {
    const cases: Array<[number, string]> = [
      [70042, 'Figure 尚未生成完成，请稍后再试'],
      [70043, 'Figure 无可用 PNG（生成失败或产物缺失）'],
      [70040, 'figure 不存在或无权访问'],
    ]
    for (const [code, message] of cases) {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(realEnvResponse(code, message))
      const err = await getFigurePngBlob('f-1').catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe(code)
      expect((err as ApiError).message).toBe(message)
    }
  })

  it('auth refresh 无回归：PNG JSON 10001 信封仍触发刷新链并重试成功', async () => {
    const auth = useAuthStore()
    auth.token = 'revoked-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(realEnvResponse(10001, '未认证')) // 原请求：吊销 token → 刷新链
      .mockResolvedValueOnce(mockResp({ access: 'fresh-access' }, 200)) // refresh 成功
      .mockResolvedValueOnce(realPngResponse()) // 重试：新 token → PNG 字节
    const blob = await getFigurePngBlob('f-1')
    expect(blob.type).toBe('image/png')
    expect(auth.token).toBe('fresh-access')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).toBe('Bearer fresh-access')
  })
})
