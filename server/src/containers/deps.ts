// 读写两侧共享依赖的单一装配点（平移 backend/containers/fleet/deps.py，#334）。
// 打包 runtime/config/provisioner/allocator/archive/lock/queue/crypto/dirRemover/portInUse/health，
// 默认绑定在此一处解析；runtime 与 config 为构造必填（调用方注入），测试可单点替换任一依赖。

import { rm } from 'node:fs/promises'
import net from 'node:net'
import type { ContainerRuntime } from './runtime'
import type { FleetConfig } from './values'
import { PortAllocator } from './ports'
import { HomeProvisioner } from './provisioner'
import { DockerFileArchive } from '../files/dockerArchive'
import type { FileArchive } from '../files/fsPort'
import { NameLeaseMap } from './leaseMap'
import { InlineLifecycleQueue, NameSerializer, type LifecycleQueue } from './lifecycleQueue'
import { AesGcmCrypto, type CryptoPort } from '../crypto'

// 目录删除器（默认 rm -rf 等价；可注入失败替身测清理失败 → 20045/REMOVING）
export type DirRemover = (target: string) => Promise<void>
export const defaultDirRemover: DirRemover = async (target) => {
  await rm(target, { recursive: true, force: true })
}

// 宿主 <host>:<port> 是否已被占用（socket bind 实测；端口分配对账）。可注入确定性冲突替身。
export type PortInUse = (port: number) => Promise<boolean>
export function makePortInUse(host: string): PortInUse {
  return (port) =>
    new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(true)) // 占用/不可绑 → 视为已用
      probe.once('listening', () => probe.close(() => resolve(false)))
      probe.listen(port, host)
    })
}

// 健康探测（gateway /health 可达性）。可注入替身。
export interface HealthProbe {
  isReachable(port: number): Promise<boolean>
}
export function makeHttpHealthProbe(host: string): HealthProbe {
  return {
    async isReachable(port: number): Promise<boolean> {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2000)
        const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal })
        clearTimeout(timer)
        return res.ok
      } catch {
        return false
      }
    },
  }
}

// chat pool 逐出钩子（delete 完成后触发；ADR 0006 下池壳被删，本切片留空挂点供桥接切片对接）。
export type EvictHook = (inst: { name: string; port: number }) => Promise<void>
export const noopEvict: EvictHook = async () => {}

export interface FleetDepsOverrides {
  dirRemover?: DirRemover
  portInUse?: PortInUse
  health?: HealthProbe
  lock?: NameLeaseMap
  queue?: LifecycleQueue
  serializer?: NameSerializer
  onEvict?: EvictHook
  crypto?: CryptoPort
  quotaSerializer?: NameSerializer
  // #591：openclaw.json 写读（putArchive/getArchive）——测试注入内存 fake；缺省真 DockerFileArchive
  archive?: FileArchive
}

export class FleetDeps {
  readonly runtime: ContainerRuntime
  readonly config: FleetConfig
  readonly dirRemover: DirRemover
  readonly portInUse: PortInUse
  readonly health: HealthProbe
  readonly provisioner: HomeProvisioner
  readonly allocator: PortAllocator
  // #591：容器文件写读 Port（config 落容器内 ~/.openclaw/openclaw.json，静态 config）
  readonly archive: FileArchive
  // 进程内互斥（不依赖 Redis）：create 双创建防护 + delete/reconcile 在飞探测
  readonly lock: NameLeaseMap
  // 后台队列（生产 BullMQ；测试 inline）+ 按 name 串行器（消 delete/create 竞态）
  readonly queue: LifecycleQueue
  readonly serializer: NameSerializer
  // 凭证加密（gateway token 落盘密文；测试可注入确定性替身）
  readonly crypto: CryptoPort
  // 按 owner 串行器（配额 check+reserve 原子化，消并发不同名绕过 maxContainers——Codex C4）
  readonly quotaSerializer: NameSerializer
  readonly onEvict: EvictHook

  constructor(runtime: ContainerRuntime, config: FleetConfig, overrides: FleetDepsOverrides = {}) {
    this.runtime = runtime
    this.config = config
    this.dirRemover = overrides.dirRemover ?? defaultDirRemover
    this.portInUse = overrides.portInUse ?? makePortInUse(config.publishHost)
    this.health = overrides.health ?? makeHttpHealthProbe(config.healthHost)
    this.provisioner = new HomeProvisioner(config.templateDir)
    this.allocator = new PortAllocator(config.portStart, config.portEnd, config.reservedPorts)
    this.archive = overrides.archive ?? new DockerFileArchive()
    this.lock = overrides.lock ?? new NameLeaseMap()
    this.queue = overrides.queue ?? new InlineLifecycleQueue()
    this.serializer = overrides.serializer ?? new NameSerializer()
    this.crypto = overrides.crypto ?? new AesGcmCrypto(config.encryptionKeys)
    this.quotaSerializer = overrides.quotaSerializer ?? new NameSerializer()
    this.onEvict = overrides.onEvict ?? noopEvict
  }
}
