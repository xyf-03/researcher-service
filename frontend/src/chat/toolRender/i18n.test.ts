// seam: chat/toolRender/i18n —— #555 t() 本地 shim(替代官方状态式 I18nManager)单测。
// 文案表 + {count}/{names} 插值;未知名 key 原样回退(防御)。

import { describe, expect, it } from 'vitest'
import { t } from './i18n'

describe('t', () => {
  it('interpolates {count} and {names} params', () => {
    expect(t('chat.toolCards.group.commandsMany', { count: '13' })).toBe('ran 13 commands')
    expect(t('chat.toolCards.group.namedToolRepeated', { names: 'foo, bar', count: '3' })).toBe(
      'used foo, bar ×3',
    )
  })

  it('falls back to the key itself for unknown keys', () => {
    expect(t('no.such.key', { count: '1' })).toBe('no.such.key')
  })

  it('serves the full summary phrase set used by summarizeToolGroup', () => {
    expect(t('chat.toolCards.group.emptyMany', { count: '0' })).toBe('Ran 0 tool calls')
    expect(t('chat.toolCards.group.failedMany', { count: '2' })).toBe('2 failed')
  })
})
