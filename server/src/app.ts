import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import type { PrismaClient } from './generated/prisma/client'
import { healthRouter } from './routes/health'
import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { traceLogsRouter } from './routes/traceLogs'
import { createContainersRouter } from './routes/containers'
import { createWikiRouter, type WikiRouterDeps } from './wiki/routes'
import { createModelsRouter, type ModelsRouterDeps } from './models/routes'
import { createFilesRouter, type FilesRouterDeps } from './files/routes'
import { createFiguresRouter, type FiguresRouterDeps } from './figures/routes'
import { Orchestrator } from './containers/orchestrator'
import { FleetDeps } from './containers/deps'
import type { ContainerRuntime } from './containers/runtime'
import type { FleetConfig } from './containers/values'
import { envelopeErrorHandler, notFound } from './middleware/errorHandler'
import './types' // Express Request 增强（req.user / req.prisma）

export interface AppDeps {
  prisma: PrismaClient
  // 容器编排接缝（#334）：测试注入假 runtime + inline queue + tmp fleet config；
  // 生产由 server.ts 装真 DockerRuntime + BullMQ 队列。缺省 = 无编排（containers 路由不挂）。
  orchestrator?: Orchestrator
  // approve 端点 docker exec 通道（#371-1 / #374）：与 orchestrator 成对注入（生产 DockerRuntime、
  // 测试 FakeRuntime）。编排器存在时缺 runtime → 装配期 fail-fast（approve 静默禁用不安全）。
  runtime?: ContainerRuntime
  // wiki 接缝（#335）：compile 触发等。缺省 = no-op（无编排）。
  wiki?: WikiRouterDeps
  // models 接缝（#336）：config 写盘（provider CRUD 后重渲染 openclaw.json）。
  // 缺省 = 不挂 models 路由（configWriter 必填，缺 writer 静默发散不安全）。
  models?: ModelsRouterDeps
  // files 接缝（#589）：FileArchive Port（生产 DockerFileArchive）。必填——缺 archive 属装配
  // 错误（静默禁用文件 CRUD 不安全），由下方条件挂载（对齐 models）。
  files?: FilesRouterDeps
  // figures 接缝（AutoFigure T01，docs/autofigure/tickets/T01-authenticated-figure-creation.md）：
  // 路由只依赖 req.prisma + 认证身份。注入即挂载——flag 门在装配层 server.ts 消费
  // config.autofigure.enabled 决定是否注入；缺省 = 不挂 figures 路由（/api/v1/figures → 90005）。
  figures?: FiguresRouterDeps
}

// createApp 工厂：PrismaClient 经依赖注入，测试可传 test DB（接缝 #2）。
export function createApp({ prisma, orchestrator, runtime, wiki, models, files, figures }: AppDeps): Application {
  const app = express()
  // wiki 内容契约无大小上限（codex PR#346）：挂载路径内请求先走 5mb limit，其余端点仍 256kb。
  // 须先于全局 parser —— body-parser 对已解析 body（req._body）会跳过，故 wiki 命中后不二次解析。
  app.use('/api/v1/containers/:name/wiki', express.json({ limit: '5mb' }))
  // files 写体（#589 PUT/POST 文本内容）对齐 wiki 的 5mb carve-out——全局 256kb 会拒大文本
  // 写入，与读侧 MAX_FILE_READ_BYTES(16MB) 契约不对称。
  app.use('/api/v1/containers/:name/files', express.json({ limit: '5mb' }))
  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.prisma = prisma
    next()
  })

  app.use('/api', healthRouter)
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/users', usersRouter)
  app.use('/api/v1/trace-logs', traceLogsRouter)
  if (orchestrator) {
    // approve 端点依赖 runtime（docker exec），与 orchestrator 成对注入（#374）；缺 runtime 属装配错误。
    if (!runtime) {
      throw new Error('[app] orchestrator 注入时必须同时注入 runtime（approve 端点 docker exec 通道）')
    }
    app.use('/api/v1/containers', createContainersRouter(orchestrator, runtime))
  }
  // wiki（#335）：只依赖 prisma + 容器行 homeDir，不依赖编排器；compile 触发经 wiki 注入。
  // 注意：Express 5 不把 app.use 挂载路径的 :name 合并进 router 的 req.params，故挂到
  // /api/v1/containers、把 `/:name/wiki/...` 路径声明在 router 内部（见 wiki/routes.ts）。
  app.use('/api/v1/containers', createWikiRouter(wiki ?? {}))
  // models（#336）：configWriter 必填，仅在有注入时挂载（对齐 orchestrator 条件挂载）。
  if (models) {
    app.use('/api/v1/containers', createModelsRouter(models))
  }
  // files（#589）：FileArchive 必填，仅在有注入时挂载（对齐 models 条件挂载；wiki/workspace
  // 两棵树统一文件 CRUD，缺 archive 静默禁用不安全）。
  if (files) {
    app.use('/api/v1/containers', createFilesRouter(files))
  }
  // figures（AutoFigure T01）：存在即挂载（对齐 models/files 条件挂载——app.ts 只认 deps 注入、
  // 不读 config；flag 门在装配层 server.ts 由 config.autofigure.enabled 决定是否注入）。
  if (figures) {
    app.use('/api/v1/figures', createFiguresRouter(figures))
  }

  app.use(notFound) // 未匹配路由 → 信封 90005（兑现「所有 REST HTTP 200」）
  app.use(envelopeErrorHandler) // 唯一错误面（必须最后挂载）
  return app
}

// 生产装配：由 server.ts 调用（DockerRuntime + BullMQ 队列），返回编排器与资源句柄供优雅关闭。
export interface FleetAssembly {
  orchestrator: Orchestrator
  deps: FleetDeps
}

export type { ContainerRuntime, FleetConfig }
