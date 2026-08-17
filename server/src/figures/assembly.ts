// AutoFigure 生产运行时装配（T07，docs/autofigure/tickets/T07-autofigure-http-adapter.md）。
//
// 完成 T03 handoff 的生产接线：config → 生产 HTTP adapter → T03 runner（assembleAutoFigureRunner）。
// 对齐 fleetAssembly.ts assembleFleet 先例——server.ts 保持薄，本函数是 T07 测试清单 #11-#14
// 的确定性测试面。
//
// flag 门语义：
//   - AUTOFIGURE_ENABLED=false → 返回 null：不构造 adapter、不启动 runner、不要求 sidecar URL、
//     不要求 sidecar 可达（面板启动/health 独立于 sidecar）。
//   - enabled=true → 构造 HttpAutoFigureGenerationPort + assembleAutoFigureRunner 并启动 pump，
//     返回 { runner, close } 供优雅关闭。T04 应用超时 config.autofigure.jobTimeoutMs 显式传入
//     runner timeoutMs（T04 票据：T07 装配点须显式传，runner 默认 0=关）。
//   - 不引入 adapter-local HTTP timeout、不引入自动重试（T07 批准决策）。

import type { PrismaClient } from '../generated/prisma/client'
import { assembleAutoFigureRunner, type AutoFigureRunnerHandle } from './runner'
import {
  HttpAutoFigureGenerationPort,
  type FetchImpl,
} from './httpPort'

export interface AutoFigureRuntimeDeps {
  /** config.autofigure.enabled（flag 只在装配层消费，app.ts 不读 config） */
  enabled: boolean
  prisma: PrismaClient
  /** config.autofigure.sidecarUrl（enabled 时必填；空 → adapter 构造 fail-fast） */
  sidecarUrl: string
  /** config.autofigure.llmKey（服务端凭证，只注入 Port，不落盘/不入日志） */
  llmKey: string
  /** config.autofigure.jobTimeoutMs（T04 唯一 application execution timeout，显式传给 runner） */
  jobTimeoutMs: number
  /** 测试 seam：传输替身（默认全局 fetch，对齐 makeHttpHealthProbe） */
  fetchImpl?: FetchImpl
  /** 测试 seam：runner 构造替身（默认真 assembleAutoFigureRunner；装配测试注入 spy 断言参数透传） */
  createRunner?: typeof assembleAutoFigureRunner
}

export function assembleAutoFigureRuntime(deps: AutoFigureRuntimeDeps): AutoFigureRunnerHandle | null {
  // flag 关 → 不构造 adapter（sidecar 依赖/装配不激活；无 pump，queued 恒不迁移）。
  if (!deps.enabled) return null

  const port = new HttpAutoFigureGenerationPort({
    baseUrl: deps.sidecarUrl,
    fetchImpl: deps.fetchImpl,
  })
  const create = deps.createRunner ?? assembleAutoFigureRunner
  return create({
    enabled: true,
    prisma: deps.prisma,
    port,
    llmKey: deps.llmKey,
    timeoutMs: deps.jobTimeoutMs,
  })
}
