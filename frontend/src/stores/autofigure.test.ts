// seam: autofigure capability store —— 运行时 probe → enabled/disabled/unknown（T09 约束 1/2）。
// 仅 90005 归类 disabled；401/网络/5xx/瞬态 → unknown 可重试；probe 成功复用列表为初始历史；单飞。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '@/api/client'
import { listFigures, type FigureSummaryDTO } from '@/api/figures'
import { useAutofigureStore } from '@/stores/autofigure'

vi.mock('@/api/figures', () => ({
  listFigures: vi.fn(),
}))

const SAMPLE: FigureSummaryDTO = {
  figureId: 'f-1',
  jobId: 'j-1',
  prompt: 'draw a pipeline',
  status: 'queued',
  createdAt: '2026-08-01T00:00:00Z',
}

describe('autofigure store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(listFigures).mockReset()
  })

  it('probe success → enabled + history populated + probed cached', async () => {
    vi.mocked(listFigures).mockResolvedValue([SAMPLE])
    const store = useAutofigureStore()
    const capability = await store.probe()
    expect(capability).toBe('enabled')
    expect(store.capability).toBe('enabled')
    expect(store.history).toEqual([SAMPLE])
    expect(store.probed).toBe(true)
  })

  it('probe 90005 → disabled, cached (subsequent probe does not re-fetch)', async () => {
    vi.mocked(listFigures).mockRejectedValue(new ApiError(200, '路由不存在', 90005))
    const store = useAutofigureStore()
    await store.probe()
    expect(store.capability).toBe('disabled')
    expect(store.probed).toBe(true)
    await store.probe()
    expect(listFigures).toHaveBeenCalledTimes(1)
  })

  it('probe network TypeError → unknown + retryable', async () => {
    vi.mocked(listFigures).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const store = useAutofigureStore()
    await store.probe()
    expect(store.capability).toBe('unknown')
    expect(store.probed).toBe(false)

    vi.mocked(listFigures).mockResolvedValueOnce([SAMPLE])
    await store.probe()
    expect(store.capability).toBe('enabled')
  })

  it('probe 401 (refresh failure) → unknown, not disabled', async () => {
    vi.mocked(listFigures).mockRejectedValue(new ApiError(401, '未登录或登录已过期'))
    const store = useAutofigureStore()
    await store.probe()
    expect(store.capability).toBe('unknown')
    expect(store.probed).toBe(false)
  })

  it('probe 5xx → unknown, not disabled', async () => {
    vi.mocked(listFigures).mockRejectedValue(new ApiError(500, '请求失败（500）'))
    const store = useAutofigureStore()
    await store.probe()
    expect(store.capability).toBe('unknown')
    expect(store.probed).toBe(false)
  })

  it('concurrent probe() calls share one in-flight listFigures', async () => {
    let resolve!: (v: FigureSummaryDTO[]) => void
    vi.mocked(listFigures).mockImplementation(
      () => new Promise<FigureSummaryDTO[]>((res) => {
        resolve = res
      }),
    )
    const store = useAutofigureStore()
    const p1 = store.probe()
    const p2 = store.probe()
    resolve([SAMPLE])
    await Promise.all([p1, p2])
    expect(listFigures).toHaveBeenCalledTimes(1)
    expect(store.capability).toBe('enabled')
  })

  it('refreshHistory refreshes history and marks enabled', async () => {
    vi.mocked(listFigures).mockResolvedValue([SAMPLE])
    const store = useAutofigureStore()
    await store.refreshHistory()
    expect(store.capability).toBe('enabled')
    expect(store.history).toEqual([SAMPLE])
    expect(store.probed).toBe(true)
  })

  it('refreshHistory transient failure keeps existing history and capability', async () => {
    vi.mocked(listFigures).mockResolvedValueOnce([SAMPLE])
    const store = useAutofigureStore()
    await store.probe()
    vi.mocked(listFigures).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await store.refreshHistory()
    expect(store.capability).toBe('enabled') // 不被瞬态降级
    expect(store.history).toEqual([SAMPLE]) // 保留现历史
  })
})
