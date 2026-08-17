// outbox 离线待发队列（sessionStorage 最小版，#564）——「已点发送但网关还没回执」的消息窄窗落盘，
// 刷新/重连后经 loadHistory 内容去重 + 复用幂等 key 自动重发（规格 docs/research/564-outbox-min-spec.md）。
// 仿 deviceTokenStore 工厂模式（storage 注入可测，生产默认全局 sessionStorage——官方同款「本标签待发」语义）。
// 0 信任读回：逐字段 normalize，坏行丢弃，坏 blob → 空（读取降级不抛）。
import { getSafeSessionStorage } from './localStorage'

export const OUTBOX_STORAGE_KEY_PREFIX = 'openclaw.panel.outbox.v1:'

export interface OutboxItem {
  id: string // createRequestId() 32-hex，兼作幂等 key（重发复用同一 id 经网关幂等去重）
  text: string
  createdAt: number
}

// 单会话上限（对齐官方 MAX_STORED_QUEUE_ITEMS=50）：超限丢最旧（宁丢一条不爆 quota）。
const MAX_QUEUE_ITEMS = 50

interface OutboxBlob {
  version: 1
  sessions: Record<string, OutboxItem[]>
}

export interface OutboxStore {
  loadOutbox(container: string): Record<string, OutboxItem[]>
  addPending(container: string, sessionKey: string, item: OutboxItem): void
  removePending(container: string, sessionKey: string, id: string): void
  takePending(container: string, sessionKey: string): OutboxItem[]
}

export function createOutboxStore(storage: Storage | null = getSafeSessionStorage()): OutboxStore {
  const keyFor = (container: string) => `${OUTBOX_STORAGE_KEY_PREFIX}${container}`

  // 逐字段 normalize：坏项（非对象/空 id/非 string text/createdAt 非法）丢弃
  function normalizeItem(v: unknown): OutboxItem | null {
    if (!v || typeof v !== 'object') return null
    const rec = v as Record<string, unknown>
    const id = typeof rec.id === 'string' && rec.id ? rec.id : ''
    const text = typeof rec.text === 'string' ? rec.text : ''
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : NaN
    if (!id || text === '' || Number.isNaN(createdAt)) return null
    return { id, text, createdAt }
  }

  function readBlob(container: string): OutboxBlob | null {
    if (!storage) return null
    const raw = storage.getItem(keyFor(container))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed?.version !== 1) return null
      const sessions: Record<string, OutboxItem[]> = {}
      const rawSessions = parsed.sessions
      if (rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
        for (const [key, list] of Object.entries(rawSessions as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue
          const items = list.map(normalizeItem).filter((i): i is OutboxItem => i !== null)
          if (items.length) sessions[key] = items
        }
      }
      return { version: 1, sessions }
    } catch {
      return null // 损坏 blob → null（读取降级）
    }
  }

  function writeBlob(container: string, blob: OutboxBlob): void {
    if (!storage) return
    try {
      storage.setItem(keyFor(container), JSON.stringify(blob))
    } catch {
      // 配额满/隐私模式写入失败：静默降级（outbox 是尽力而为，不打断聊天）
    }
  }

  return {
    loadOutbox(container) {
      return readBlob(container)?.sessions ?? {}
    },
    addPending(container, sessionKey, item) {
      const blob = readBlob(container) ?? { version: 1, sessions: {} }
      const list = blob.sessions[sessionKey] ?? []
      list.push(item)
      if (list.length > MAX_QUEUE_ITEMS) list.splice(0, list.length - MAX_QUEUE_ITEMS) // 丢最旧
      blob.sessions[sessionKey] = list
      writeBlob(container, blob)
    },
    removePending(container, sessionKey, id) {
      const blob = readBlob(container)
      if (!blob) return
      const list = blob.sessions[sessionKey]
      if (!list) return
      const next = list.filter((i) => i.id !== id)
      if (next.length) {
        blob.sessions[sessionKey] = next
        writeBlob(container, blob)
      } else {
        delete blob.sessions[sessionKey]
        // 该容器已无任何待发项：清掉整键（不留空 blob 占位）
        if (Object.keys(blob.sessions).length === 0) storage?.removeItem(keyFor(container))
        else writeBlob(container, blob)
      }
    },
    takePending(container, sessionKey) {
      return readBlob(container)?.sessions[sessionKey] ?? []
    },
  }
}
