// 生产编排装配（#334）：DockerRuntime（真 docker.sock）+ BullMqLifecycleQueue（Redis）
// + FleetDeps + Orchestrator。由 server.ts 调用；测试不经此（注入 FakeRuntime + InlineLifecycleQueue）。

import { config } from '../config'
import type { PrismaClient } from '../generated/prisma/client'
import { DockerRuntime } from './dockerRuntime'
import { BullMqLifecycleQueue } from './bullmqQueue'
import { FleetDeps } from './deps'
import { Orchestrator } from './orchestrator'
import type { ContainerRuntime } from './runtime'
import { DockerFileArchive } from '../files/dockerArchive'
import type { FileArchive } from '../files/fsPort'
import { defaultReservedPorts, type FleetConfig } from './values'

export interface FleetAssembly {
  orchestrator: Orchestrator
  // runtime 暴露（#335 wiki compile 用）：docker exec 通道（openclaw wiki compile）。
  runtime: ContainerRuntime
  // #591：容器文件写读 Port（config 落容器内 openclaw.json；models writer / files 路由共用）
  archive: FileArchive
  close(): Promise<void>
}

export function assembleFleet(prisma: PrismaClient): FleetAssembly {
  const cfg: FleetConfig = {
    root: config.fleet.root,
    templateDir: config.fleet.templateDir,
    templateJson: config.fleet.templateJson,
    image: config.fleet.image,
    portStart: config.fleet.portStart,
    portEnd: config.fleet.portEnd,
    llmApiKey: config.fleet.llmApiKey,
    publishHost: config.fleet.publishHost,
    healthHost: config.fleet.healthHost,
    panelOrigin: config.fleet.panelOrigin,
    namedVolumes: config.fleet.namedVolumes,
    reservedPorts: defaultReservedPorts(),
    encryptionKeys: config.fleet.encryptionKeys,
  }
  const runtime = new DockerRuntime(undefined, cfg.publishHost)
  const archive = new DockerFileArchive()
  const queue = new BullMqLifecycleQueue({
    redisUrl: config.redisUrl,
    concurrency: config.lifecycleWorkerConcurrency,
  })
  const deps = new FleetDeps(runtime, cfg, { queue, archive })
  const orchestrator = new Orchestrator(deps, prisma)
  return {
    orchestrator,
    runtime,
    archive,
    close: async () => {
      await queue.close()
    },
  }
}
