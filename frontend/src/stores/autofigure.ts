// AutoFigure capability store（T09，docs/autofigure/tickets/T09-vue-figure-journey.md）。
// 职责：一次性运行时 capability probe（GET /api/v1/figures）→ 'enabled' | 'disabled' | 'unknown'，
// 并持有初始历史列表（probe 成功即列表——复用为初始历史，避免二次 GET，T09 约束 2）。
//
// 判定纪律（T09 约束 1）：
//   - 仅 ApiError.code === 90005（figures 路由未挂载 → flag off）归类 'disabled' 并缓存。
//   - 401（已由 apiFetch 刷新链处理）/ 网络 TypeError / 5xx / 瞬态信封 → 保持 'unknown'、
//     probed=false 可重试——绝不把瞬态错误缓存为「功能未启用」。
//   - probe 经 apiJson → apiFetch，尊重既有 auth 刷新生命周期（复用同一认证栈，不建第二个）。
// 单飞：并发 probe 复用同一 in-flight 请求（模块级 promise，client.ts singleFlightRefresh 先例）。
import { defineStore } from 'pinia'
import { ApiError } from '@/api/client'
import { listFigures, type FigureSummaryDTO } from '@/api/figures'

export type AutofigureCapability = 'unknown' | 'enabled' | 'disabled'

let inflightProbe: Promise<AutofigureCapability> | null = null

export const useAutofigureStore = defineStore('autofigure', {
  state: () => ({
    capability: 'unknown' as AutofigureCapability,
    history: [] as FigureSummaryDTO[],
    probed: false, // 仅 enabled / disabled 置 true；unknown 保持可重试
  }),
  actions: {
    async probe(force = false): Promise<AutofigureCapability> {
      if (this.probed && !force) return this.capability
      if (inflightProbe) return inflightProbe
      inflightProbe = this._runProbe().finally(() => {
        inflightProbe = null
      })
      return inflightProbe
    },

    // 提交后刷新历史：同一判定纪律；瞬态失败保留现历史，能力状态不受影响。
    async refreshHistory(): Promise<void> {
      try {
        await this._applyResult(await listFigures())
      } catch (e) {
        await this._applyError(e)
      }
    },

    async _runProbe(): Promise<AutofigureCapability> {
      try {
        await this._applyResult(await listFigures())
      } catch (e) {
        await this._applyError(e)
      }
      return this.capability
    },

    async _applyResult(figures: FigureSummaryDTO[]): Promise<void> {
      this.capability = 'enabled'
      this.history = figures
      this.probed = true
    },

    async _applyError(e: unknown): Promise<void> {
      if (e instanceof ApiError && e.code === 90005) {
        this.capability = 'disabled'
        this.probed = true
      }
      // 其余（401 已由 client 刷新链处理 / 网络 / 5xx / 瞬态信封）：保持 unknown、probed=false
    },
  },
})
