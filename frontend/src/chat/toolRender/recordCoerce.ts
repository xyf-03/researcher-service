// 替代 @openclaw/normalization-core/record-coerce(monorepo workspace 包,非 npm 公开)——
// 官方 tool-call-view/patch 仅用其 asNullableRecord,实现即一行(#555 移植注意 2)。
export function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
