// #694 对话回退的「不再询问」偏好——纯本地持久化（#693 spec §1.5，官方 Control UI 同构形态）。
//
// key 沿用官方同一字符串 `openclaw:skip-rewind-confirm`（值 '1' = 已记住），不做服务端同步（官方全包
// grep 无该 key 的上报路径，纯浏览器侧偏好）。
//
// 存储不可用（隐私模式 / 受限上下文 / 配额写满）一律静默降级为「每次都确认」——不抛错、不阻断回退，
// 与 deviceIdentity/deviceTokenStore 的 getSafeLocalStorage 兜底同款语义（本地偏好不值得打扰用户）。
import { getSafeLocalStorage } from './localStorage'

export const SKIP_REWIND_CONFIRM_KEY = 'openclaw:skip-rewind-confirm'

// 已记住「不再询问」→ 回退入口跳过确认 popover 直接执行（读失败 = 未记住）。
export function shouldSkipRewindConfirm(storage: Storage | null = getSafeLocalStorage()): boolean {
  try {
    return storage?.getItem(SKIP_REWIND_CONFIRM_KEY) === '1'
  } catch {
    return false
  }
}

// 记住「不再询问」（用户在确认 popover 勾选后调用）。写失败静默吞掉：本次回退照常执行，只是下次仍问。
export function rememberSkipRewindConfirm(storage: Storage | null = getSafeLocalStorage()): void {
  try {
    storage?.setItem(SKIP_REWIND_CONFIRM_KEY, '1')
  } catch {
    // 存储不可写（配额/受限）：静默降级为每次确认
  }
}
