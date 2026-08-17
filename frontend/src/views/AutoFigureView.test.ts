// seam: AutoFigureView —— T09 旅程（docs/autofigure/tickets/T09-vue-figure-journey.md）。
// 覆盖：capability 探测（enabled/disabled/瞬态+重试）、提交快照幂等键生命周期（约束 3）、
// queued/running/succeeded 轮询与停止、failed 稳定态、PNG 预览/下载、A→B stale 守卫（约束 4）、
// Blob URL 回收（替换/卸载）、历史重开、无假百分比、错误码 70041/90002 应用级文案。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AutoFigureView from '@/views/AutoFigureView.vue'
import { ApiError } from '@/api/client'
import {
  createFigure,
  getFigureDetail,
  getFigurePngBlob,
  listFigures,
  type FigureAppStatus,
  type FigureDetailDTO,
  type FigureSummaryDTO,
} from '@/api/figures'

vi.mock('@/api/figures', () => ({
  createFigure: vi.fn(),
  listFigures: vi.fn(),
  getFigureDetail: vi.fn(),
  getFigurePngBlob: vi.fn(),
}))

vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  }
})

// ---- 环境桩（Blob URL / randomUUID 语义）----
// Node 22 的 URL 自带 createObjectURL（返回 blob:nodedata:...），但测试需要确定性的假 URL 与
// revoke 断言，故无条件覆盖为可控 mock（本测试文件作用域内）。jsdom 无 randomUUID → 桩化。
const createObjectURLMock = vi.fn()
const revokeObjectURLMock = vi.fn()
const randomUUIDMock = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(URL as any).createObjectURL = createObjectURLMock
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(URL as any).revokeObjectURL = revokeObjectURLMock

let uuidSeq = 0
let pinia: Pinia

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    emits: ['click'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElInput: {
    props: ['modelValue', 'type'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElTag: {
    props: ['type'],
    template: '<span><slot /></span>',
  },
}

function summary(id: string, status: FigureAppStatus, prompt = 'prompt'): FigureSummaryDTO {
  return {
    figureId: id,
    jobId: `j-${id}`,
    prompt,
    status,
    createdAt: '2026-08-01T00:00:00Z',
  }
}

function detail(id: string, status: FigureAppStatus, errorMessage: string | null = null): FigureDetailDTO {
  return { ...summary(id, status), errorMessage, updatedAt: '2026-08-01T00:01:00Z' }
}

function mountView(): VueWrapper {
  return mount(AutoFigureView, { global: { plugins: [pinia], stubs } })
}

async function setPromptAndSubmit(wrapper: VueWrapper, prompt: string): Promise<void> {
  await wrapper.find('[data-test="prompt-input"]').setValue(prompt)
  await wrapper.find('[data-test="submit-button"]').trigger('click')
  await flushPromises()
}

describe('AutoFigureView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createObjectURLMock.mockReset().mockReturnValue('blob:preview')
    revokeObjectURLMock.mockReset()
    uuidSeq = 0
    randomUUIDMock.mockReset().mockImplementation(() => `key-${++uuidSeq}`)
    pinia = createPinia()
    setActivePinia(pinia)
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: randomUUIDMock })
    vi.mocked(listFigures).mockReset().mockResolvedValue([])
    vi.mocked(createFigure).mockReset()
    vi.mocked(getFigureDetail).mockReset()
    vi.mocked(getFigurePngBlob).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // ---- capability（约束 1）----
  it('flag off（probe 90005）→ 「功能未启用」，不渲染 composer', async () => {
    vi.mocked(listFigures).mockRejectedValue(new ApiError(200, '路由不存在', 90005))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="autofigure-disabled"]').text()).toContain('功能未启用')
    expect(wrapper.find('[data-test="prompt-input"]').exists()).toBe(false)
  })

  it('probe 瞬态失败 → 检测失败态 + 重试入口 → 重试成功进入主视图', async () => {
    vi.mocked(listFigures).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="autofigure-probing"]').text()).toContain('检测失败')
    vi.mocked(listFigures).mockResolvedValueOnce([])
    await wrapper.find('[data-test="retry-probe"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="prompt-input"]').exists()).toBe(true)
  })

  // ---- composer / 提交（约束 3：Idempotency-Key 生命周期）----
  it('空 prompt → ElMessage.warning，不发创建请求', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="submit-button"]').trigger('click')
    await flushPromises()
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.warning).toHaveBeenCalledWith('请输入生成提示词')
    expect(createFigure).not.toHaveBeenCalled()
  })

  it('提交：createFigure 收到 prompt + key，current 显示排队中，无假百分比', async () => {
    vi.mocked(createFigure).mockResolvedValue({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'queued'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(createFigure).toHaveBeenCalledWith('draw a pipeline', 'key-1')
    expect(wrapper.find('[data-test="current-figure"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('排队中')
    expect(wrapper.text()).not.toContain('%') // 无假百分比
  })

  it('同一次提交瞬态失败后重试沿用同 key', async () => {
    vi.mocked(createFigure)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'queued'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="autofigure-error"]').text()).toContain('提交失败')
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    const calls = vi.mocked(createFigure).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toBe('key-1')
    expect(calls[1][1]).toBe('key-1') // 重试沿用同 key
  })

  it('Job 仍 queued/running 时重复提交沿用同 key', async () => {
    vi.mocked(createFigure).mockResolvedValue({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'queued'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    const calls = vi.mocked(createFigure).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toBe(calls[0][1])
  })

  it('终态（succeeded）后同 prompt 再提 → 新 key', async () => {
    vi.mocked(createFigure).mockResolvedValue({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'succeeded'))
    vi.mocked(getFigurePngBlob).mockResolvedValue(new Blob())
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('已完成')
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    const calls = vi.mocked(createFigure).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toBe('key-1')
    expect(calls[1][1]).toBe('key-2') // 新生成 → 新 key
  })

  it('改 prompt 再提 → 新 key', async () => {
    vi.mocked(createFigure).mockResolvedValue({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'queued'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'prompt A')
    await setPromptAndSubmit(wrapper, 'prompt B')
    const calls = vi.mocked(createFigure).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toBe('key-1')
    expect(calls[1][1]).toBe('key-2')
  })

  it('create 70041（幂等冲突）→ 应用级错误文案', async () => {
    vi.mocked(createFigure).mockRejectedValue(
      new ApiError(200, '幂等键已用于不同输入，请勿复用同一 Idempotency-Key 提交不同创建载荷', 70041),
    )
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="autofigure-error"]').text()).toContain('幂等键冲突')
  })

  // T09 Spec-3：70041 = 该 Idempotency-Key 已被服务端绑定其他输入，作废本提交快照——下次显式
  // 重试生成新 key，不再永久 70041（此前 createNotSettled 判定会无限复用冲突 key）。
  it('create 70041 → 作废旧 key，重试使用新 key（不再永久 70041）', async () => {
    vi.mocked(createFigure)
      .mockRejectedValueOnce(
        new ApiError(200, '幂等键已用于不同输入，请勿复用同一 Idempotency-Key 提交不同创建载荷', 70041),
      )
      .mockResolvedValueOnce({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'queued'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="autofigure-error"]').text()).toContain('幂等键冲突')
    // 下次显式重试（同 prompt）：旧 key 已作废 → 新 key
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    const calls = vi.mocked(createFigure).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toBe('key-1')
    expect(calls[1][1]).toBe('key-2') // 新 key，不再永久 70041
  })

  it('create 90002（校验失败）→ 信封 message', async () => {
    vi.mocked(createFigure).mockRejectedValue(new ApiError(200, '参数校验失败', 90002))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="autofigure-error"]').text()).toContain('参数校验失败')
  })

  // ---- 轮询（queued→running→succeeded，成功后停）----
  it('轮询 queued → running → succeeded，succeeded 后停止轮询并加载 PNG', async () => {
    vi.useFakeTimers()
    vi.mocked(createFigure).mockResolvedValueOnce({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail)
      .mockResolvedValueOnce(detail('f-1', 'queued'))
      .mockResolvedValueOnce(detail('f-1', 'running'))
      .mockResolvedValueOnce(detail('f-1', 'succeeded'))
    vi.mocked(getFigurePngBlob).mockResolvedValueOnce(new Blob([new Uint8Array([137, 80])], { type: 'image/png' }))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('排队中')

    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('生成中')

    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('已完成')

    const callsAfterSuccess = vi.mocked(getFigureDetail).mock.calls.length
    await vi.advanceTimersByTimeAsync(9000)
    expect(vi.mocked(getFigureDetail).mock.calls.length).toBe(callsAfterSuccess) // 已停
    expect(wrapper.find('[data-test="png-img"]').exists()).toBe(true)
  })

  it('failed 后停止轮询并渲染稳定失败态', async () => {
    vi.useFakeTimers()
    vi.mocked(createFigure).mockResolvedValueOnce({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValueOnce(detail('f-1', 'failed', '生成超时'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('失败')
    expect(wrapper.find('[data-test="failed-message"]').text()).toContain('生成超时')
    const calls = vi.mocked(getFigureDetail).mock.calls.length
    await vi.advanceTimersByTimeAsync(9000)
    expect(vi.mocked(getFigureDetail).mock.calls.length).toBe(calls)
  })

  it('卸载停止轮询', async () => {
    vi.useFakeTimers()
    vi.mocked(createFigure).mockResolvedValue({ figureId: 'f-1', jobId: 'j-1', status: 'queued' })
    vi.mocked(getFigureDetail).mockResolvedValue(detail('f-1', 'queued'))
    const wrapper = mountView()
    await flushPromises()
    await setPromptAndSubmit(wrapper, 'draw a pipeline')
    const calls = vi.mocked(getFigureDetail).mock.calls.length
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(9000)
    expect(vi.mocked(getFigureDetail).mock.calls.length).toBe(calls)
  })

  // ---- PNG 预览 / 下载 / Blob URL 生命周期（约束 4）----
  it('重开 succeeded → PNG 预览 + 下载链接（Blob URL）', async () => {
    const A = detail('f-A', 'succeeded')
    vi.mocked(listFigures).mockResolvedValue([A])
    vi.mocked(getFigureDetail).mockResolvedValue(A)
    vi.mocked(getFigurePngBlob).mockResolvedValue(new Blob([new Uint8Array([137, 80])], { type: 'image/png' }))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="reopen-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="png-img"]').attributes('src')).toBe('blob:preview')
    const download = wrapper.find('[data-test="png-download"]')
    expect(download.exists()).toBe(true)
    expect(download.attributes('href')).toBe('blob:preview')
    expect(download.attributes('download')).toBe('autofigure-f-A.png')
  })

  it('A→B 切换：已展示的 A 预览被替换时回收 A 的 URL', async () => {
    const A = detail('f-A', 'succeeded')
    const B = detail('f-B', 'succeeded')
    vi.mocked(listFigures).mockResolvedValue([B, A]) // 后端序：B 新在前
    vi.mocked(getFigureDetail).mockImplementation((id) => Promise.resolve(id === 'f-A' ? A : B))
    vi.mocked(getFigurePngBlob).mockResolvedValue(new Blob())
    const wrapper = mountView()
    await flushPromises()
    // 打开 A → A 的 PNG 立即解析 → 预览
    await wrapper.findAll('[data-test="reopen-button"]')[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="png-img"]').attributes('src')).toBe('blob:preview')
    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    // 切到 B → switchTo 回收 A 的 URL
    await wrapper.findAll('[data-test="reopen-button"]')[0].trigger('click')
    await flushPromises()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:preview')
    expect(wrapper.find('[data-test="png-img"]').attributes('src')).toBe('blob:preview')
    expect(createObjectURLMock).toHaveBeenCalledTimes(2)
  })

  it('A→B 切换：在飞 A 的 PNG 解析不覆盖 B 预览，A 不产生泄漏 URL', async () => {
    const A = detail('f-A', 'succeeded')
    const B = detail('f-B', 'succeeded')
    vi.mocked(listFigures).mockResolvedValue([B, A])
    vi.mocked(getFigureDetail).mockImplementation((id) => Promise.resolve(id === 'f-A' ? A : B))
    let resolveA!: (b: Blob) => void
    vi.mocked(getFigurePngBlob)
      .mockImplementationOnce(() => new Promise<Blob>((res) => { resolveA = res })) // A 在飞
      .mockResolvedValueOnce(new Blob([new Uint8Array([1])])) // B 立即解析
    const wrapper = mountView()
    await flushPromises()
    // 打开 A → PNG 在飞
    await wrapper.findAll('[data-test="reopen-button"]')[1].trigger('click')
    await flushPromises()
    // 切到 B → B 的 PNG 立即解析 → 预览 = B
    await wrapper.findAll('[data-test="reopen-button"]')[0].trigger('click')
    await flushPromises()
    const srcAfterB = wrapper.find('[data-test="png-img"]').attributes('src')
    expect(srcAfterB).toBe('blob:preview')
    // A 的 PNG 此刻才解析（stale）→ 不得覆盖 B、不建 URL
    resolveA(new Blob([new Uint8Array([2])]))
    await flushPromises()
    expect(wrapper.find('[data-test="png-img"]').attributes('src')).toBe(srcAfterB)
    expect(createObjectURLMock).toHaveBeenCalledTimes(1) // 只给 B 建了 URL
  })

  it('卸载时回收预览 URL', async () => {
    const A = detail('f-A', 'succeeded')
    vi.mocked(listFigures).mockResolvedValue([A])
    vi.mocked(getFigureDetail).mockResolvedValue(A)
    vi.mocked(getFigurePngBlob).mockResolvedValue(new Blob())
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="reopen-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="png-img"]').exists()).toBe(true)
    revokeObjectURLMock.mockClear()
    wrapper.unmount()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:preview')
  })

  // T09 Spec-2：unmount 失效 generation token——unmount 时在飞 PNG 请求解析后不得再 createObjectURL
  // （否则 URL 无人 revoke → Blob 泄漏），也无需 revoke（从未建成）。
  it('unmount 时在飞 PNG 请求不建 ObjectURL（gen 已失效）', async () => {
    const A = detail('f-A', 'succeeded')
    vi.mocked(listFigures).mockResolvedValue([A])
    vi.mocked(getFigureDetail).mockResolvedValue(A)
    let resolveBlob!: (b: Blob) => void
    vi.mocked(getFigurePngBlob).mockReturnValue(
      new Promise<Blob>((res) => {
        resolveBlob = res
      }),
    )
    const wrapper = mountView()
    await flushPromises()
    // 打开 A → succeeded → loadPng 在飞（getFigurePngBlob pending）
    await wrapper.find('[data-test="reopen-button"]').trigger('click')
    await flushPromises()
    expect(createObjectURLMock).not.toHaveBeenCalled()
    // unmount：onBeforeUnmount 递增 figureGeneration → 在飞响应变为 stale
    wrapper.unmount()
    // 在飞请求此刻才解析
    resolveBlob(new Blob([new Uint8Array([1])]))
    await flushPromises()
    expect(createObjectURLMock).not.toHaveBeenCalled() // 未建 URL → 无泄漏
    expect(revokeObjectURLMock).not.toHaveBeenCalled() // 也无需 revoke
  })

  // ---- 历史 / 重开 ----
  it('历史列表渲染后端顺序（不重排）', async () => {
    vi.mocked(listFigures).mockResolvedValue([
      summary('f-B', 'succeeded', 'prompt B'),
      summary('f-A', 'failed', 'prompt A'),
    ])
    const wrapper = mountView()
    await flushPromises()
    const items = wrapper.findAll('[data-test="history-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('prompt B')
    expect(items[1].text()).toContain('prompt A')
  })

  it('重开 failed → 稳定失败态（errorMessage）', async () => {
    const F = detail('f-F', 'failed', '生成超时')
    vi.mocked(listFigures).mockResolvedValue([F])
    vi.mocked(getFigureDetail).mockResolvedValue(F)
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="reopen-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="status-tag"]').text()).toContain('失败')
    expect(wrapper.find('[data-test="failed-message"]').text()).toContain('生成超时')
  })
})
