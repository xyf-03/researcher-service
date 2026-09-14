// 镜像引用（image reference）钉版纯判定（零依赖模块，issue #695 / spec §2.1）。
// 唯一准据：浮动引用 = 无 tag（Docker 默认解析 :latest）或显式 :latest（含空 tag 的坏引用）；
// digest 钉定（`@sha256:…`）恒不浮动——内容按 digest 寻址，tag 移动不影响解析。
// 消费方：config.readFleetImage —— 生产环境目标镜像为浮动引用 → 启动 fail-fast（升级编排的检测
// 判定是「容器记录镜像 ≠ 当前目标」，浮动 tag 让目标随上游移动、升级不可复现）；dev/test 容忍。
// 与 auth/quota.ts 同模式：纯知识独立成模块，config 与静态断言测试共享同一准据（避免双源漂移）。

// 提取 tag：只看最后一段路径分量里的 `:`（`registry:5000/openclaw` 的 `:5000` 是端口不是 tag）。
// 返回 null = 无 tag（Docker 默认解析 :latest）；空串 = 形如 `openclaw:` 的坏引用。
// 契约边界：digest 引用（`…@sha256:…`）下返回的是 digest 的十六进制片段、**不是 tag**——本函数不识
// digest 语义，调用方若关心须自行先判 `@`（isFloatingImageRef 即先短路 `@`，故不受影响）。
export function imageTag(ref: string): string | null {
  const last = ref.slice(ref.lastIndexOf('/') + 1)
  const colon = last.lastIndexOf(':')
  return colon === -1 ? null : last.slice(colon + 1)
}

export function isFloatingImageRef(ref: string): boolean {
  if (ref.includes('@')) return false // digest 钉定
  const tag = imageTag(ref)
  return !tag || tag === 'latest'
}
