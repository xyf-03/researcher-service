import { createServer } from 'node:http'
import { createApp } from './app'
import { getPrisma } from './prisma'
import { bootstrap } from './auth/bootstrap'
import { config } from './config'
import { assembleFleet } from './containers/fleetAssembly'
import { assembleAutoFigureRuntime } from './figures/assembly'
import { makeDockerCompile } from './wiki/compile'
import { TemplateModelConfigWriter } from './models/configWriter'
import { assembleTunnelServer } from './chat/tunnelAssembly'
import './types'

async function main(): Promise<void> {
  const prisma = getPrisma()
  await bootstrap(prisma) // B1 惰性首启（空表生成 admin）
  // 容器编排（#334 M2）：真 DockerRuntime + BullMQ(Redis) 队列 + worker 并发默认 2。
  const fleet = assembleFleet(prisma)
  // AutoFigure 生成运行时（T07）：config → 生产 HTTP adapter（私有 sidecar）→ T03 runner。
  // flag 关 → null（不构造 adapter、不启动 pump；面板启动/health 独立于 sidecar）。enabled →
  // 构造 adapter + 启动 runner pump（queue 由 T03 runner 内部创建）。handle 供优雅关闭 await。
  // T04 超时（config.autofigure.jobTimeoutMs）在此显式传入——T07 不引入 adapter-local timeout。
  const autofigure = assembleAutoFigureRuntime({
    enabled: config.autofigure.enabled,
    prisma,
    sidecarUrl: config.autofigure.sidecarUrl,
    llmKey: config.autofigure.llmKey,
    jobTimeoutMs: config.autofigure.jobTimeoutMs,
  })
  const app = createApp({
    prisma,
    orchestrator: fleet.orchestrator,
    // approve 端点 docker exec 通道（#374）：容器内 `openclaw devices approve <requestId>`。
    runtime: fleet.runtime,
    // wiki compile（#335）：docker exec `openclaw wiki compile`，5s 去抖、best-effort。
    wiki: { compile: makeDockerCompile(fleet.runtime) },
    // models config 写盘（#336）：模板 + FileArchive.putArchive 落容器内 ~/.openclaw/openclaw.json
    //（#591 静态 config——改配置后须重启容器生效，#366 热加载已回退）。
    models: {
      configWriter: new TemplateModelConfigWriter({
        archive: fleet.archive,
        templateJson: config.fleet.templateJson,
        llmApiKey: config.fleet.llmApiKey,
        panelOrigin: config.fleet.panelOrigin,
      }),
    },
    // files（#589 · ADR 0012）：统一文件 CRUD 经 Docker getArchive/putArchive/exec rm。
    files: { archive: fleet.archive },
    // figures（AutoFigure T01）：flag 开才装配（config.autofigure.enabled）——flag 关不注入 →
    // 路由未挂载（/api/v1/figures → 90005）。FiguresRouterDeps 为空（路由只依赖 req.prisma +
    // 认证身份），装配形态 `{}` 表达「已启用」。生成 runner（T03）与生产 HTTP adapter（T07）的
    // 接线不走 app deps——见下方 assembleAutoFigureRuntime（config → adapter → T03 runner 启动）。
    figures: config.autofigure.enabled ? {} : undefined,
  })

  // M0 同进程单端口分流：createServer(expressApp) + server.on('upgrade') 分流。
  // M5 隧道（#337 · ADR 0006）：/ws/chat/ 由隧道接管（JWT subprotocol 握手 + 归属门 + 原始帧透传
  // 到容器网关）；其余 upgrade 请求拒绝（避免裸挂导致悬空连接）。
  const tunnel = assembleTunnelServer({
    prisma,
    // #385：隧道连容器网关携带面板 origin（生产 PANEL_PUBLIC_ORIGIN；真网关 2026.7.1 校验
    // Origin 须在容器 allowedOrigins 内——该值同时由 ConfigRenderer 强制进容器 openclaw.json）。
    panelOrigin: config.fleet.panelOrigin,
    gatewayHost: config.fleet.healthHost,
    gatewayScheme: config.fleet.healthScheme,
  })
  const server = createServer(app)
  server.on('upgrade', (req, socket, head) => {
    if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy()
  })

  // 优雅关闭：drain BullMQ worker（在飞 provisioning 完成或标 ERROR）；AutoFigure runner
  //（T07：停 pump + 等待在飞生成 settle——T03 close 语义，见 runner.ts）。
  const shutdown = async (): Promise<void> => {
    await fleet.close().catch(() => {})
    await autofigure?.close().catch(() => {})
    // 先终止活动隧道（http.Server.close 会等升级后的 WS 连接自然断开——有浏览器持隧道时挂起）
    tunnel.close()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] 控制面 listening on :${config.port}`)
  })
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[server] 启动失败', e)
  process.exit(1)
})
