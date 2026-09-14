// 容器运行时 Port（平移 backend/containers/runtime.py + integration.openclaw.ports，#334）。
// 业务层只依赖本接口（ContainerRuntime），docker 接触面在 DockerRuntime（dockerode），
// 测试注入 FakeRuntime（接缝 #5 编排器 Port）。

import { CONTAINER_PREFIX, VOLUME_HOME_PREFIX, VOLUME_HOME_BACKUP_PREFIX, VOLUME_WIKI_PREFIX, VOLUME_WORKSPACE_PREFIX } from './constants'

// 实例名 → docker 容器名（openclaw-gw-<name>）
export function containerName(name: string): string {
  return `${CONTAINER_PREFIX}${name}`
}

// #590 named volume 拓扑（ADR 0011）：每容器三卷。wiki/workspace 卷在子路径遮蔽 home 卷，
// 属正常叠加；空卷首挂由镜像内 ~/.openclaw 骨架自动初始化（#588 派生镜像）。
export interface NamedVolumes {
  readonly wiki: string
  readonly workspace: string
  readonly home: string
}

// 按代系 id（#360）派生三卷名（openclaw-<kind>-<id>）——每代唯一，删容器连卷删、同名 recreate
// 用新卷组，防在飞 wiki/长扫描期间容器被删+同名重建给他人时读写新 owner 数据。
export function namedVolumesFor(instanceId: string): NamedVolumes {
  return {
    wiki: `${VOLUME_WIKI_PREFIX}${instanceId}`,
    workspace: `${VOLUME_WORKSPACE_PREFIX}${instanceId}`,
    home: `${VOLUME_HOME_PREFIX}${instanceId}`,
  }
}

// 三卷删除顺序单一来源（docker volume rm 顺序：wiki → workspace → home；FakeRuntime 记录与
// 测试断言同源，防四处手写顺序漂移）
export function volumeOrder(v: NamedVolumes): [string, string, string] {
  return [v.wiki, v.workspace, v.home]
}

// #699 升级备份卷名（openclaw-home-backup-<instanceId>）：独立于代系三卷命名——不在
// namedVolumesFor / volumeOrder（删除连删）范围，删容器后备份仍留存供手工救回（spec §2.4）。
export function backupVolumeFor(instanceId: string): string {
  return `${VOLUME_HOME_BACKUP_PREFIX}${instanceId}`
}

// 创建一个容器所需的语义参数（orchestrator → runtime）
export interface ContainerSpec {
  readonly name: string // 实例名（不含前缀）
  readonly image: string
  readonly hostPort: number // 宿主映射端口（端口池分配）
  readonly gatewayToken: string // GATEWAY_TOKEN env 值（敏感：仅 env 注入，不落盘）
  readonly homeDir: string // 宿主 bind-mount home（instances/<id>/home，代系绑定 #360；
  // rw bind 承载 workspace/wiki/state/logs；OPENCLAW_NAMED_VOLUMES 开启时不用）
  // #590 named volume 拓扑（ADR 0011）：提供时 buildRunOptions 生成三卷 Mounts 替代 home bind
  // （挂载点 ~/.openclaw/wiki/main + ~/.openclaw/workspace + ~/.openclaw）；缺省 undefined =
  // 旧 bind 模式（homeDir 生效）。config 无独立 bind（#591：落容器内 ~/.openclaw/openclaw.json，
  // 经 FileArchive.putArchive 写、gateway 走默认路径读——静态 config）
  readonly volumes?: NamedVolumes
  readonly llmApiKey: string // 全面板共享 LLM_API_KEY
}

// 一个容器的运行时状态快照（runtime → orchestrator）
export interface ContainerInfo {
  readonly containerId: string
  readonly name: string
  readonly running: boolean
  readonly status: string // docker status 原值：running/exited/...
  readonly image: string
  // 宿主映射端口（来自 openclaw.port label），供端口分配对账；未跟踪/无 label 时为 null
  readonly port: number | null
  // 实例名（来自 openclaw.instance label）——reconcile/delete 用它校验容器所有权；无 label 时为 null
  readonly instanceName: string | null
}

// 一次性临时容器的 named volume 挂载（#696）：doctor 挂真容器三卷（同布局）；备份挂 home 卷 + 备份卷。
// source 是卷名原文（不限于三卷——备份卷等各代资产另有命名）——调用方须经命名单一来源派生
// （真容器三卷走 namedVolumesFor，防卷名规则四处手写漂移）；target 同理取容器内挂载点单一来源
// （containers/constants 的 HOME_BIND / MOUNT_WIKI / MOUNT_WORKSPACE），不要手写路径字面量。
export interface OneShotMount {
  readonly source: string // named volume 名
  readonly target: string // 容器内挂载点
  readonly readOnly?: boolean // 只读挂载（如备份读源卷）
}

// 一次性临时容器语义参数（#696 runOnce）。与 ContainerSpec 的刻意差异：无实例名、无宿主端口、
// 无 fleet 标签（故不进 fleet 列表与端口对账）；命令覆写镜像 ENTRYPOINT（见 buildOneShotOptions）。
export interface OneShotSpec {
  readonly image: string
  readonly cmd: readonly string[]
  readonly mounts?: readonly OneShotMount[]
  // 追加/覆盖 env（与运行时基础 env 合并）。卷内 openclaw.json 的 ${...} 占位由进程运行时插值——
  // 在卷上跑 CLI（如 openclaw doctor）须拿到同一份 env 才能正确读取配置。
  readonly env?: Readonly<Record<string, string>>
}

// 一次性临时容器结果：容器 stdout+stderr 合并文本（诊断日志用，尽力而为——读不到日志时为 ''）。
export interface OneShotResult {
  readonly output: string
}

// 容器运行时接触面（docker daemon 原语）。DockerRuntime 与 FakeRuntime 结构满足本接口。
export interface ContainerRuntime {
  // 确保镜像已本地就位（缺失则 pull；#699 升级编排步骤 1 显式调用——先拉后停，拉失败=干净中止。
  // DockerRuntime 早已内置于 create/runOnce 前置；升级需要「显式先拉」把慢 pull 排在停机之前）
  ensureImage(image: string): Promise<void>
  // 创建并启动一个容器，返回 docker container id
  run(spec: ContainerSpec): Promise<string>
  // 只创建容器（不启动），返回 docker container id（#591：createComplete 先 create → 经
  // FileArchive.putArchive 写容器内 openclaw.json → 再 start，首启 gateway 即读渲染配置——
  // 静态 config 顺序，无需重启）
  create(spec: ContainerSpec): Promise<string>
  // 列出本面板（label app=openclaw-fleet）全部容器
  listFleet(): Promise<ContainerInfo[]>
  // 枚举宿主上与发布地址冲突的活动容器宿主端口（含未跟踪容器；daemon 不可达 → 空集）
  hostPublishedPorts(): Promise<Set<number>>
  // 取单个容器；不存在 → null
  get(name: string): Promise<ContainerInfo | null>
  // 启动容器（删除前置修复 chown 用——容器被外部停止后 docker 无法在 stopped 容器内 exec，须先 start）
  start(name: string): Promise<void>
  // 按容器 id 启动（#591：createComplete 的 create 返回 id → writeConfig → startById(id)——按 id
  // 启动消除「create 与 start 之间外部删/重建同名容器」的 TOCTOU；NotFound 幂等）
  startById(containerId: string): Promise<void>
  // 停容器（NotFound 幂等）
  stop(name: string): Promise<void>
  // 删容器（v+force；NotFound 幂等）。volumes（#590 named volume 模式）提供时连带显式
  // docker volume rm 三卷（ADR 0011：remove({v:true}) 只删匿名卷，named volume 须显式删；
  // 容器 404 也尽力删卷——外部删容器不删卷，防卷越攒越多；卷 404 幂等）
  remove(name: string, volumes?: NamedVolumes): Promise<void>
  // fire-and-forget 容器内执行（如 wiki compile）；NotFound 幂等
  execInContainer(name: string, cmd: string[]): Promise<void>
  // 同步等命令完成；退出码非 0 → 抛错（如 approve CLI）；NotFound 幂等
  execSync(name: string, cmd: string[]): Promise<void>
  // 一次性临时容器（#696 升级编排前置）：以指定镜像 + 指定命令跑一个跑完即弃的容器——
  // 创建（自定义命令、无 fleet 标签、无端口发布）→ 启动 → 等退出 → 强制删容器（卷一律不删，
  // 备份卷等调用方资产须留存）。退出码非 0 → 抛 RunOnceError（携带 exitCode 与输出）；
  // 成功/非 0/异常三路都清理容器。
  runOnce(spec: OneShotSpec): Promise<OneShotResult>
}
