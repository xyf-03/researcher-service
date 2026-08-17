// 假 docker runtime（接缝 #5：注入编排器测 5 态机 + 取消标志 + 端口入队前分配 + 补偿，不需真 daemon）。
// 全内存模拟 ContainerRuntime：run/get/stop/remove/listFleet/hostPublishedPorts/exec 各原语可注入故障。

import type { ContainerInfo, ContainerRuntime, ContainerSpec, NamedVolumes } from '../src/containers/runtime'
import { containerName, volumeOrder } from '../src/containers/runtime'
import { GATEWAY_INTERNAL_PORT, LABEL_INSTANCE_KEY, LABEL_PORT_KEY } from '../src/containers/constants'

export interface FakeContainerRecord {
  info: ContainerInfo
  spec: ContainerSpec
}

export class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, FakeContainerRecord>()
  private idSeq = 0
  // 故障注入：run 时对指定 hostPort 抛 bind 冲突（测就地换端口重试）。
  bindConflictPorts = new Set<number>()
  // run 时对指定 name 抛非 bind 错（测统一回滚）。
  failRunFor = new Set<string>()
  // run 时若 name 命中本表 → 植入外部同名容器（instanceName 用给定值，模拟另一 Docker actor 在
  // 慢 pull 期间抢先建 openclaw-gw-<name>、不带我们的 label）并抛非 bind 的名冲突错（测
  // finalizeFailedCreate 回滚须按 instance label 校验所有权，不误删外部容器）。Codex 第六轮①。
  plantExternalFor = new Map<string, string>()
  // get（inspect）时对指定 name 抛错（测 daemon 故障时 list 降级保留记账状态）。
  failGetFor = new Set<string>()
  // execSync 故障注入：对指定 name 抛错（测 approve CLI 失败 → 不推进配对状态）。
  failExecSyncFor = new Set<string>()
  // execSync 调用记录（断言 delete 的 chown / approve 的 CLI argv）。
  execCalls: { name: string; cmd: string[] }[] = []
  // #590：remove 收到 volumes 时的卷删除记录（断言 named volume 模式连带 docker volume rm 三卷）。
  removedVolumes: string[] = []

  async run(spec: ContainerSpec): Promise<string> {
    const id = await this.create(spec)
    const rec = this.containers.get(spec.name)
    if (rec) rec.info = { ...rec.info, running: true, status: 'running' }
    return id
  }

  // #591：只创建不启动（createComplete 先 create → archive.writeConfig → start，静态 config）。
  // 故障注入路径与 run 对齐（bind 冲突/非 bind 错/外部同名），status 'created'、running false。
  async create(spec: ContainerSpec): Promise<string> {
    if (this.failRunFor.has(spec.name)) {
      throw new Error(`simulated docker run failure for ${spec.name}`)
    }
    if (this.bindConflictPorts.has(spec.hostPort)) {
      throw new Error(`Bind for 127.0.0.1:${spec.hostPort} failed: port is already allocated`)
    }
    if (this.plantExternalFor.has(spec.name)) {
      // 外部 actor 抢先占用 name：植入外部容器（instanceName 故意 ≠ spec.name），抛名冲突（非 bind）。
      this.containers.set(spec.name, {
        info: {
          containerId: `external-${spec.name}`,
          name: containerName(spec.name),
          running: true,
          status: 'running',
          image: spec.image,
          port: spec.hostPort,
          instanceName: this.plantExternalFor.get(spec.name) ?? 'external-instance',
        },
        spec,
      })
      throw new Error(`Conflict. The container name "${containerName(spec.name)}" is already in use by another actor`)
    }
    const id = `fake-${spec.name}-${this.idSeq++}`
    const info: ContainerInfo = {
      containerId: id,
      name: containerName(spec.name),
      running: false,
      status: 'created',
      image: spec.image,
      port: spec.hostPort,
      instanceName: spec.name,
    }
    this.containers.set(spec.name, { info, spec })
    return id
  }

  async listFleet(): Promise<ContainerInfo[]> {
    return [...this.containers.values()].map((r) => r.info)
  }

  async hostPublishedPorts(): Promise<Set<number>> {
    const s = new Set<number>()
    for (const r of this.containers.values()) {
      if (r.info.running && typeof r.info.port === 'number') s.add(r.info.port)
    }
    return s
  }

  async get(name: string): Promise<ContainerInfo | null> {
    if (this.failGetFor.has(name)) throw new Error(`simulated daemon unreachable for ${name}`)
    return this.containers.get(name)?.info ?? null
  }

  async start(name: string): Promise<void> {
    const r = this.containers.get(name)
    if (r) r.info = { ...r.info, running: true, status: 'running' }
  }

  // #591：按容器 id 启动（createComplete 用 create 返回的 id——消除 name 竞态）；id 不存在 no-op
  async startById(containerId: string): Promise<void> {
    for (const r of this.containers.values()) {
      if (r.info.containerId === containerId) {
        r.info = { ...r.info, running: true, status: 'running' }
        return
      }
    }
  }

  async stop(name: string): Promise<void> {
    const r = this.containers.get(name)
    if (r) r.info = { ...r.info, running: false, status: 'exited' }
  }

  async remove(name: string, volumes?: NamedVolumes): Promise<void> {
    this.containers.delete(name)
    if (volumes) this.removedVolumes.push(...volumeOrder(volumes))
  }

  async execInContainer(_name: string, _cmd: string[]): Promise<void> {}

  async execSync(name: string, cmd: string[]): Promise<void> {
    if (this.failExecSyncFor.has(name)) throw new Error(`simulated approve exec failure for ${name}`)
    this.execCalls.push({ name, cmd })
  }

  // 测试辅助：断言用的 label 常量（与真 runtime 同源）。
  static readonly internalPort = GATEWAY_INTERNAL_PORT
  static readonly labelInstance = LABEL_INSTANCE_KEY
  static readonly labelPort = LABEL_PORT_KEY
}
