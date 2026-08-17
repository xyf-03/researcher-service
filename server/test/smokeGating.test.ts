// seam: T10 smoke 门控探测 —— 纯函数三条件门控 + docker 可用性同步探测边界（smokeGating.ts）。
// 覆盖：skip 条件恰好 = docker 可用 + AUTOFIGURE_SMOKE==='1' + AUTOFIGURE_LLM_KEY 非空；缺任一跳过；
// 探测失败静默 false（不抛）——与 smokeDocker.ts 的 hard-fail 语义刻意区分。
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'
import { probeDockerAvailable, shouldRunAutofigureSmoke } from './smokeGating'

const mockExec = vi.mocked(execFileSync)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shouldRunAutofigureSmoke (T10 三条件门控)', () => {
  it('docker 可用 + SMOKE=1 + key 非空 → true（真跑）', () => {
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: true, smokeFlag: '1', llmKey: 'sk-test' }),
    ).toBe(true)
  })

  it('docker 不可用 → false（skip，即使 SMOKE=1 且有 key）', () => {
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: false, smokeFlag: '1', llmKey: 'sk-test' }),
    ).toBe(false)
  })

  it('SMOKE 未设 → false（常规套件不依赖真实 key）', () => {
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: true, smokeFlag: undefined, llmKey: 'sk-test' }),
    ).toBe(false)
  })

  it('SMOKE 非 "1"（0 / true）→ false', () => {
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: true, smokeFlag: '0', llmKey: 'sk-test' }),
    ).toBe(false)
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: true, smokeFlag: 'true', llmKey: 'sk-test' }),
    ).toBe(false)
  })

  it('LLM key 缺省 / 空串 → false（不得把假/默认凭证硬编码进门控）', () => {
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: true, smokeFlag: '1', llmKey: undefined }),
    ).toBe(false)
    expect(
      shouldRunAutofigureSmoke({ dockerAvailable: true, smokeFlag: '1', llmKey: '' }),
    ).toBe(false)
  })
})

describe('probeDockerAvailable (同步 daemon 探测边界)', () => {
  it('docker info 成功 → true', () => {
    mockExec.mockReturnValue(Buffer.from('24.0.7'))
    expect(probeDockerAvailable()).toBe(true)
    expect(mockExec).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('docker info 抛错（CLI 缺失 / daemon 未起 / 无权限）→ false（不抛）', () => {
    mockExec.mockImplementation(() => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    expect(probeDockerAvailable()).toBe(false)
  })
})
