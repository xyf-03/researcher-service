// 编排域纯值（平移 backend/containers/fleet/values.py，#334）。
// HEALTH_* 为读侧聚合用状态枚举；FleetConfig 为编排控制面配置（来自 config.ts，测试可注入 tmp 路径）。

import { RESERVED_PORT_18789 } from './ports'

// health 字段枚举（列表显示 health 变 healthy）
export const HEALTH_HEALTHY = 'healthy'
export const HEALTH_UNHEALTHY = 'unhealthy'
export const HEALTH_STOPPED = 'stopped'
export const HEALTH_PENDING = 'pending' // creating：容器未起，无 health 可探
export const HEALTH_REMOVING = 'removing' // removing：清理中

// 编排控制面配置（部署相关，来自 config.ts env；测试可注入 tmp 路径）
export interface FleetConfig {
  readonly root: string // OPENCLAW_FLEET_ROOT（instances/ 落盘根）
  readonly templateDir: string // 共享只读模板（cp -a 源）
  readonly templateJson: string // openclaw.json 模板文件路径（create 惰性读）
  readonly image: string // pin 的镜像 tag
  readonly portStart: number
  readonly portEnd: number
  readonly llmApiKey: string // 全面板共享 LLM_API_KEY
  readonly publishHost: string // 容器 gateway 端口宿主侧发布地址（127.0.0.1 / 0.0.0.0）
  readonly healthHost: string // 健康探测目标 host（与 WS 配对同源）
  // 面板对外 origin（#385）：隧道连网关的 WS Origin + 容器 allowedOrigins 强制条目（生产必填）
  readonly panelOrigin: string
  // #590/#592 named volume 拓扑开关（ADR 0011；OPENCLAW_NAMED_VOLUMES）：true（默认）时编排用
  // openclaw-wiki/workspace/home-<id> 三卷替代宿主 bind-mount home；显式 false 回退旧 bind
  readonly namedVolumes: boolean
  readonly reservedPorts: ReadonlySet<number> // 强制保留（默认含 18789）
  // 凭证加密密钥（AES-256-GCM；gateway token 真值不落盘，首个 active 加密、余仅解密供轮换）
  readonly encryptionKeys: readonly Buffer[]
}

export function defaultReservedPorts(): ReadonlySet<number> {
  return new Set([RESERVED_PORT_18789])
}
