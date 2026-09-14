// seam: chat/rewindPreference —— 回退「不再询问」偏好的纯函数读写（#694 / #693 spec §1.5）。
// 外部契约：官方同款 localStorage key + 值 '1'；存储不可用/抛错一律静默降级为「每次都确认」
// （读到 null → 确认；写失败 → 不打扰用户）。不测内部实现，只测可观察的键值行为。
import { describe, expect, it, beforeEach } from 'vitest'
import { SKIP_REWIND_CONFIRM_KEY, rememberSkipRewindConfirm, shouldSkipRewindConfirm } from './rewindPreference'

describe('rewindPreference（#694 回退确认偏好）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('缺省未记住 → 需要确认（每次询问）', () => {
    expect(shouldSkipRewindConfirm()).toBe(false)
  })

  it('记住后 → 跳过确认；key/值沿用官方形状（openclaw:skip-rewind-confirm = "1"）', () => {
    rememberSkipRewindConfirm()
    expect(localStorage.getItem(SKIP_REWIND_CONFIRM_KEY)).toBe('1')
    expect(shouldSkipRewindConfirm()).toBe(true)
  })

  it('值非 "1"（异形/被外部改写）→ 视为未记住', () => {
    localStorage.setItem(SKIP_REWIND_CONFIRM_KEY, 'true')
    expect(shouldSkipRewindConfirm()).toBe(false)
  })

  it('存储不可用（隐私模式）→ 读 false、写静默不抛（退化为每次确认）', () => {
    expect(shouldSkipRewindConfirm(null)).toBe(false)
    expect(() => rememberSkipRewindConfirm(null)).not.toThrow()
  })

  it('存储访问抛错（受限实现/配额）→ 同样静默降级', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    expect(shouldSkipRewindConfirm(throwing)).toBe(false)
    expect(() => rememberSkipRewindConfirm(throwing)).not.toThrow()
  })
})
