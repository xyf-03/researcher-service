// safeLocalStorage —— localStorage 安全访问兜底（issue #668 从 chat 草稿 draftStorage 收敛）。
// 隐私模式/禁用存储等场景下访问 localStorage 可能抛错：try/catch 静默降级为 null，
// 调用方（chat 草稿、面板三态宽度持久化）自行跳过读写。单一实现，勿各处复制。
export function safeLocalStorage(): Storage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}
