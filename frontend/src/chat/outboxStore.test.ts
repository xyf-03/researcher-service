// seam: chat/outboxStore —— outbox 离线待发队列(sessionStorage 最小版,#564)。
// 覆盖:scope 键(容器+会话)、0 信任 normalize(坏 blob/坏行丢弃)、cap 50 丢最旧、
// add/remove/take 语义、storage 降级。规格 docs/research/564-outbox-min-spec.md §五.1/§七。
import { beforeEach, describe, expect, it } from 'vitest'
import { createOutboxStore, OUTBOX_STORAGE_KEY_PREFIX, type OutboxItem } from './outboxStore'

function makeItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return { id: 'id-1', text: '你好', createdAt: 1000, ...overrides }
}

describe('outboxStore（#564 离线待发队列，sessionStorage 最小版）', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('addPending → 单 JSON blob 落盘（键含容器名 scope，值 {version:1, sessions}）', () => {
    const store = createOutboxStore()
    store.addPending('alpha', 'sk-1', makeItem())
    const raw = JSON.parse(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}alpha`)!)
    expect(raw.version).toBe(1)
    expect(raw.sessions['sk-1']).toEqual([{ id: 'id-1', text: '你好', createdAt: 1000 }])
  })

  it('scope 隔离：不同容器/会话互不串读（A 容器待发不被 B 读走）', () => {
    const store = createOutboxStore()
    store.addPending('alpha', 'sk-1', makeItem({ id: 'a1' }))
    store.addPending('alpha', 'sk-2', makeItem({ id: 'a2' }))
    store.addPending('beta', 'sk-1', makeItem({ id: 'b1' }))
    expect(store.takePending('alpha', 'sk-1').map((i) => i.id)).toEqual(['a1'])
    expect(store.takePending('alpha', 'sk-2').map((i) => i.id)).toEqual(['a2'])
    expect(store.takePending('beta', 'sk-1').map((i) => i.id)).toEqual(['b1'])
    expect(store.takePending('beta', 'sk-2')).toEqual([])
    expect(store.loadOutbox('alpha')['sk-1'].map((i) => i.id)).toEqual(['a1'])
  })

  it('loadOutbox：坏 blob（非 JSON/非 version:1）→ {}（不抛）', () => {
    const store = createOutboxStore()
    sessionStorage.setItem(`${OUTBOX_STORAGE_KEY_PREFIX}alpha`, 'garbage{{{')
    expect(store.loadOutbox('alpha')).toEqual({})
    sessionStorage.setItem(`${OUTBOX_STORAGE_KEY_PREFIX}alpha`, JSON.stringify({ version: 2, sessions: {} }))
    expect(store.loadOutbox('alpha')).toEqual({})
    expect(store.loadOutbox('no-such-container')).toEqual({})
  })

  it('loadOutbox：坏行（非对象/缺 id/缺 text/createdAt 非法）丢弃，好行保留（0 信任 normalize）', () => {
    sessionStorage.setItem(
      `${OUTBOX_STORAGE_KEY_PREFIX}alpha`,
      JSON.stringify({
        version: 1,
        sessions: {
          'sk-1': [
            { id: 'ok-1', text: '好的', createdAt: 1 },
            { id: 'bad-no-text' },
            { text: 'bad-no-id', createdAt: 2 },
            { id: 'bad-created', text: 'x', createdAt: 'NaN' },
            { id: '', text: 'empty-id', createdAt: 3 },
            'not-an-object',
            null,
          ],
          'sk-2': [{ id: 'ok-2', text: '另一个', createdAt: 4 }],
          'sk-3': 'not-array',
        },
      }),
    )
    const store = createOutboxStore()
    const out = store.loadOutbox('alpha')
    expect(out['sk-1']).toEqual([{ id: 'ok-1', text: '好的', createdAt: 1 }])
    expect(out['sk-2']).toEqual([{ id: 'ok-2', text: '另一个', createdAt: 4 }])
    expect(out['sk-3']).toBeUndefined()
  })

  it('addPending cap 50/会话：超限丢最旧（宁丢一条不爆 quota）', () => {
    const store = createOutboxStore()
    for (let i = 0; i < 55; i += 1) store.addPending('alpha', 'sk-1', makeItem({ id: `id-${i}`, createdAt: i }))
    const items = store.takePending('alpha', 'sk-1')
    expect(items).toHaveLength(50)
    expect(items[0].id).toBe('id-5') // 最旧 id-0..4 被丢
    expect(items[49].id).toBe('id-54')
  })

  it('addPending 追加保序（队列语义，新到在后）', () => {
    const store = createOutboxStore()
    store.addPending('alpha', 'sk-1', makeItem({ id: 'a1', createdAt: 1 }))
    store.addPending('alpha', 'sk-1', makeItem({ id: 'a2', createdAt: 2 }))
    expect(store.takePending('alpha', 'sk-1').map((i) => i.id)).toEqual(['a1', 'a2'])
  })

  it('removePending：按 id 删除（ack/已受理确认点）；不存在不报错；清空后键移除', () => {
    const store = createOutboxStore()
    store.addPending('alpha', 'sk-1', makeItem({ id: 'a1' }))
    store.addPending('alpha', 'sk-1', makeItem({ id: 'a2' }))
    store.removePending('alpha', 'sk-1', 'a1')
    expect(store.takePending('alpha', 'sk-1').map((i) => i.id)).toEqual(['a2'])
    store.removePending('alpha', 'sk-1', 'no-such-id') // 幂等
    expect(store.takePending('alpha', 'sk-1').map((i) => i.id)).toEqual(['a2'])
    store.removePending('alpha', 'sk-1', 'a2')
    expect(store.takePending('alpha', 'sk-1')).toEqual([])
    expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}alpha`)).toBeNull() // 全空清键
  })

  it('takePending 只读不删（重发用：读出后 ack 才 remove）', () => {
    const store = createOutboxStore()
    store.addPending('alpha', 'sk-1', makeItem({ id: 'a1' }))
    expect(store.takePending('alpha', 'sk-1').map((i) => i.id)).toEqual(['a1'])
    expect(store.takePending('alpha', 'sk-1').map((i) => i.id)).toEqual(['a1']) // 再读仍在
  })

  it('storage 不可用（隐私模式降级为 null）→ 静默 no-op 不抛', () => {
    const store = createOutboxStore(null)
    expect(() => store.addPending('alpha', 'sk-1', makeItem())).not.toThrow()
    expect(store.loadOutbox('alpha')).toEqual({})
    expect(store.takePending('alpha', 'sk-1')).toEqual([])
    expect(() => store.removePending('alpha', 'sk-1', 'x')).not.toThrow()
  })
})
