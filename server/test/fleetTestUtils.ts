// 编排器测试装配（接缝 #5）：tmp fleet root + 最小模板 + fake runtime + inline queue。
// 每测试独立 tmp 目录（隔离）；templateDir 放最小 home 骨架，templateJson 放最小 openclaw.json 模板。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '../src/generated/prisma/client'
import { FleetDeps, type FleetDepsOverrides } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import { defaultReservedPorts, type FleetConfig } from '../src/containers/values'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import { FileNotFound } from '../src/files/errors'
import type { FileArchive } from '../src/files/fsPort'
import { FakeRuntime } from './fakeRuntime'

export interface FleetTestContext {
  orch: Orchestrator
  deps: FleetDeps
  runtime: FakeRuntime
  fleetRoot: string
  config: FleetConfig
  // #591：config 写读 fake（createComplete 经 putArchive 落容器内 openclaw.json 的断言点）
  archive: MemoryArchive
}

// #591：内存 fake FileArchive——编排测试只消费 writeConfig/readConfig（createComplete 落容器内
// config）+ seedWorkspace（#6xx named volume 下模板 workspace 灌卷，断言调用参数与先后顺序），
// 文件 CRUD 方法不实现（本域不触达）。
export class MemoryArchive implements FileArchive {
  // name → openclaw.json 文本（静态 config 落点：容器内 ~/.openclaw/openclaw.json）
  readonly configs = new Map<string, string>()
  // seedWorkspace 调用记录（参数断言）
  readonly seedCalls: Array<{ name: string; hostDir: string }> = []
  // 写盘操作序列（seedWorkspace / writeConfig 先后顺序断言）
  readonly ops: string[] = []
  async seedWorkspace(name: string, hostDir: string): Promise<void> {
    this.seedCalls.push({ name, hostDir })
    this.ops.push('seedWorkspace')
  }
  async writeConfig(name: string, content: string): Promise<void> {
    this.configs.set(name, content)
    this.ops.push('writeConfig')
  }
  async readConfig(name: string): Promise<string> {
    const c = this.configs.get(name)
    if (c === undefined) throw new FileNotFound('openclaw.json')
    return c
  }
  async read(): Promise<never> {
    throw new Error('files CRUD not used in fleet tests')
  }
  async readBytes(): Promise<never> {
    throw new Error('files CRUD not used in fleet tests')
  }
  async write(): Promise<never> {
    throw new Error('files CRUD not used in fleet tests')
  }
  async create(): Promise<never> {
    throw new Error('files CRUD not used in fleet tests')
  }
  async delete(): Promise<never> {
    throw new Error('files CRUD not used in fleet tests')
  }
}

let seq = 0

export function makeFleetTest(
  prisma: PrismaClient,
  overrides: FleetDepsOverrides & { config?: Partial<FleetConfig> } = {},
): FleetTestContext {
  const fleetRoot = mkdtempSync(path.join(tmpdir(), `fleet-test-${process.pid}-${seq++}-`))
  const templateDir = path.join(fleetRoot, 'template')
  mkdirSync(path.join(templateDir, 'workspace', 'skills', 'demo'), { recursive: true })
  writeFileSync(path.join(templateDir, 'README.md'), '# home 模板\n')
  // 模板 workspace 内容（模拟 researcher 各项 md + skills——seedWorkspace 灌卷的源）
  writeFileSync(path.join(templateDir, 'workspace', 'AGENTS.md'), '# workspace 模板\n')
  writeFileSync(path.join(templateDir, 'workspace', 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  const templateJson = path.join(fleetRoot, 'openclaw.template.json')
  writeFileSync(
    templateJson,
    JSON.stringify({ gateway: { auth: {} }, models: { providers: {} } }, null, 2),
  )

  const config: FleetConfig = {
    root: fleetRoot,
    templateDir,
    templateJson,
    image: 'ghcr.io/openclaw/openclaw:test',
    portStart: 19000,
    portEnd: 19010, // 小池便于测耗尽（11 个候选）
    llmApiKey: 'test-llm-key',
    publishHost: '127.0.0.1',
    healthHost: '127.0.0.1',
    panelOrigin: 'http://127.0.0.1:18789', // #385 测试默认与网关 seed 一致
    namedVolumes: true, // #592 本地/CI 默认 named volume 拓扑（对齐生产；旧 bind 用例显式 false 覆盖）
    reservedPorts: defaultReservedPorts(),
    encryptionKeys: DEV_ENCRYPTION_KEYS,
    ...overrides.config,
  }
  const runtime = new FakeRuntime()
  // overrides.archive 若提供须为 MemoryArchive 兼容形态（编排测试断言 configs map）
  const archive: MemoryArchive = overrides.archive === undefined ? new MemoryArchive() : (overrides.archive as MemoryArchive)
  const deps = new FleetDeps(runtime, config, {
    queue: overrides.queue ?? new InlineLifecycleQueue(),
    portInUse: overrides.portInUse ?? (async () => false),
    health: overrides.health ?? { isReachable: async () => true },
    dirRemover: overrides.dirRemover,
    lock: overrides.lock,
    serializer: overrides.serializer,
    onEvict: overrides.onEvict,
    crypto: overrides.crypto,
    archive,
  })
  const orch = new Orchestrator(deps, prisma)
  return { orch, deps, runtime, fleetRoot, config, archive }
}
