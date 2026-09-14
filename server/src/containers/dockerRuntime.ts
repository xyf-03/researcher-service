// DockerRuntime —— dockerode 适配层（平移 backend/containers/docker_runtime.py，#334）。
// buildRunOptions 是纯逻辑 seam（不调 daemon），run/listFleet/get/stop/remove 经 docker client 操作 daemon。
// client 延迟注入（默认 new Docker() 挂 /var/run/docker.sock）——构造时不连 daemon，仅实际调用时才连。

import Docker from 'dockerode'
import {
  GATEWAY_BIND,
  GATEWAY_INTERNAL_PORT,
  HOME_BIND,
  LABEL_APP_KEY,
  LABEL_APP_VALUE,
  LABEL_INSTANCE_KEY,
  LABEL_ONESHOT_KEY,
  LABEL_ONESHOT_VALUE,
  LABEL_PORT_KEY,
  MOUNT_WIKI,
  MOUNT_WORKSPACE,
} from './constants'
import {
  containerName,
  volumeOrder,
  type ContainerInfo,
  type ContainerRuntime,
  type ContainerSpec,
  type NamedVolumes,
  type OneShotResult,
  type OneShotSpec,
} from './runtime'
import { RunOnceError } from './errors'

// 4 个 sync flag 全关（防覆写挂载的 openclaw.json / 防明文写凭证；对官方镜像无害、兼容 fork init.sh）。
const SYNC_FLAGS_OFF: Record<string, string> = {
  SYNC_OPENCLAW_CONFIG: 'false',
  SYNC_EXTENSIONS_ON_START: 'false',
  SYNC_EXTENSIONS_MODE: 'none',
  SYNC_MODEL_CONFIG: 'false',
}

// 基础环境（locale + gateway 绑定 + 关闭外联 IM channel + 插件开关）
const BASE_ENV: Record<string, string> = {
  TZ: 'Asia/Shanghai',
  HOME: '/home/node',
  TERM: 'xterm-256color',
  NODE_ENV: 'production',
  LANG: 'en_US.UTF-8',
  LANGUAGE: 'en_US:en',
  LC_ALL: 'en_US.UTF-8',
  OPENCLAW_GATEWAY_PORT: String(GATEWAY_INTERNAL_PORT),
  OPENCLAW_GATEWAY_BIND: GATEWAY_BIND,
  OPENCLAW_GATEWAY_MODE: 'local',
  // #591：config 无独立 bind、无 OPENCLAW_CONFIG_PATH——openclaw.json 落容器内默认
  // ~/.openclaw/openclaw.json（home 卷 / bind home），gateway 走默认路径读取（静态 config，
  // 对 #366「宿主 rename + ro bind 热加载」的明确回退：改配置须重启容器生效）。
  OPENCLAW_WORKSPACE_ROOT: HOME_BIND,
  DM_POLICY: 'disabled',
  GROUP_POLICY: 'disabled',
  ALLOW_FROM: '',
  OPENCLAW_PLUGINS_ENABLED: 'true',
}

function envRecordToArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}

// 面板创建的容器（fleet 实例 / 一次性临时容器）共用的环境基线：镜像行为不变的 BASE_ENV + 关闭镜像侧
// config 同步的 SYNC_FLAGS_OFF。单一构造点——两处各写一份会在新增容器类型时漂移（一次性容器漏关
// SYNC_*，doctor 就会去改写挂载卷里的配置）。
function panelEnv(): Record<string, string> {
  return { ...BASE_ENV, ...SYNC_FLAGS_OFF }
}

// named volume 挂载的唯一构造点（fleet 三卷与一次性临时容器共用同一形状——两处手写会漂移）。
function volumeMount(source: string, target: string, readOnly = false): Docker.MountSettings {
  return { Type: 'volume', Source: source, Target: target, ...(readOnly ? { ReadOnly: true } : {}) }
}

// docker 容器日志多路复用帧解析（#696）：非 TTY 容器的 logs 响应为逐帧
// [stream(1=stdout/2=stderr),0,0,0,size_be32] + 负载；先收齐各帧负载再整体解码（跨帧切开的多字节
// 字符不裂成替换符），stdout/stderr 合并成诊断文本。首个帧头即无效（daemon 直返原文）→ 原样返回；
// 空帧/残缺帧视为帧流结束，已收齐的帧照常返回——绝不因解析错位把整段日志吞掉。
function demuxLogFrames(raw: Buffer): string {
  const payloads: Buffer[] = []
  let off = 0
  while (off + 8 <= raw.length) {
    const size = raw.readUInt32BE(off + 4)
    if (size === 0 || off + 8 + size > raw.length) break
    payloads.push(raw.subarray(off + 8, off + 8 + size))
    off += 8 + size
  }
  if (off === 0) return raw.toString('utf8') // 无有效帧头 → 原文
  return Buffer.concat(payloads).toString('utf8')
}

export class DockerRuntime implements ContainerRuntime {
  private cached: Docker | null = null

  // publishHost 默认 127.0.0.1（loopback 收敛暴露面）；生产后端容器化后 0.0.0.0。
  constructor(
    private readonly clientFactory: () => Docker = () => new Docker(),
    private readonly publishHost: string = '127.0.0.1',
  ) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // 构造 docker create 参数（纯逻辑，可单测）。
  buildRunOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
    const environment = {
      ...panelEnv(),
      GATEWAY_TOKEN: spec.gatewayToken,
      // 容器内 sidecar CLI（approve/exec 审批注册）自连 gateway 须同值 token
      OPENCLAW_GATEWAY_TOKEN: spec.gatewayToken,
      LLM_API_KEY: spec.llmApiKey,
    }
    // #590 named volume 模式（ADR 0011）：三卷 Mounts 替代 home host bind；config 无独立 bind
    // （#591：openclaw.json 落 ~/.openclaw/ 默认路径，静态 config）。
    const mounts: Docker.MountSettings[] | undefined = spec.volumes
      ? [
          volumeMount(spec.volumes.wiki, MOUNT_WIKI),
          volumeMount(spec.volumes.workspace, MOUNT_WORKSPACE),
          volumeMount(spec.volumes.home, HOME_BIND),
        ]
      : undefined
    return {
      Image: spec.image,
      name: containerName(spec.name),
      Env: envRecordToArray(environment),
      User: '0:0',
      // #378 CI 定位：PortBindings 之外还须 ExposedPorts——docker CLI `-p` 两者同设；仅 PortBindings
      // 时部分 dockerd（CI ubuntu dockerd，非 Docker Desktop）NetworkSettings.Ports={}（docker-proxy
      // 不注册映射），宿主端口恒 ECONNREFUSED（配对 smoke 容器内网关 ready 但连不上）。
      ExposedPorts: { [`${GATEWAY_INTERNAL_PORT}/tcp`]: {} },
      Labels: {
        [LABEL_APP_KEY]: LABEL_APP_VALUE,
        [LABEL_INSTANCE_KEY]: spec.name,
        [LABEL_PORT_KEY]: String(spec.hostPort),
      },
      HostConfig: {
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
        ...(spec.volumes
          ? // named volume 模式：无 home bind
            { Mounts: mounts }
          : {
              // 旧 bind 模式（#591）：仅 home 目录 rw bind。config 不再独立 ro bind——
              // openclaw.json 落 home bind 内默认路径（#366「config 独立目录 + OPENCLAW_CONFIG_PATH
              // 热加载」已回退为静态 config：改配置经 putArchive 写容器内、重启容器生效）。
              Binds: [`${spec.homeDir}:${HOME_BIND}:rw`],
            }),
        PortBindings: {
          [`${GATEWAY_INTERNAL_PORT}/tcp`]: [{ HostIp: this.publishHost, HostPort: String(spec.hostPort) }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
      },
    }
  }

  // 构造一次性临时容器 create 参数（纯逻辑，可单测，#696）。「对 fleet 列表与端口对账不可见」的三处
  // 刻意差异即在此固定：
  //  ① 标签只有 oneshot 标记——不写 app=openclaw-fleet / openclaw.instance / openclaw.port，
  //     故 listFleet（按 app label 过滤）看不到它；
  //  ② 无 PortBindings/ExposedPorts——不占宿主端口，端口对账（按发布端口聚合）看不到它；
  //  ③ Entrypoint 覆写为 spec.cmd 且 Cmd 清空——既不依赖镜像 ENTRYPOINT（官方镜像为 tini）转发
  //     命令，也不让镜像 Cmd（node openclaw.mjs gateway）被当作参数追加到命令之后。
  // 无 RestartPolicy（默认 no）：一次性容器跑完即弃，绝不自动重启。
  buildOneShotOptions(spec: OneShotSpec): Docker.ContainerCreateOptions {
    const environment = { ...panelEnv(), ...spec.env }
    return {
      Image: spec.image,
      Entrypoint: [...spec.cmd],
      Cmd: [],
      Env: envRecordToArray(environment),
      User: '0:0',
      Labels: { [LABEL_ONESHOT_KEY]: LABEL_ONESHOT_VALUE },
      HostConfig: {
        ...(spec.mounts
          ? { Mounts: spec.mounts.map((m) => volumeMount(m.source, m.target, m.readOnly === true)) }
          : {}),
      },
    }
  }

  async run(spec: ContainerSpec): Promise<string> {
    const id = await this.create(spec)
    await this.client().getContainer(id).start()
    return id
  }

  // 只创建不启动（#591：createComplete 先 create → FileArchive.putArchive 写容器内 config →
  // 再 start——首启 gateway 即读渲染配置，无需重启）。ensureImage 前置同 run。
  async create(spec: ContainerSpec): Promise<string> {
    await this.ensureImage(spec.image)
    const container = await this.client().createContainer(this.buildRunOptions(spec))
    return container.id
  }

  // create 前确保镜像已就位（Codex 第四轮③[P1]）：Engine createContainer 对本地缺失的镜像返回
  // image-not-found——干净 host / OPENCLAW_IMAGE 换成未缓存 tag 时 create 必 error。CI 此前靠手动
  // docker pull 掩盖。这里仅本地缺失时拉取（getImage().inspect() 404 → 拉；已缓存 → 跳过，避免
  // 每次 create 都重复 pull）。pull 经 modem.followProgress 消费进度流（不消费则流不 flowing、
  // pull 永不完成）。拉取失败向上抛 → createComplete 标 error 行（可重试）。
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.client().getImage(image).inspect()
      return
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e // daemon 故障等真错不吞
    }
    const stream = await this.client().pull(image)
    await new Promise<void>((resolve, reject) => {
      const modem = (
        this.client() as Docker & { modem: { followProgress(s: NodeJS.ReadableStream, f: (err: Error | null) => void): void } }
      ).modem
      modem.followProgress(stream, (err) => (err ? reject(err) : resolve()))
    })
  }

  async listFleet(): Promise<ContainerInfo[]> {
    const cs = await this.client().listContainers({
      all: true,
      filters: { label: [`${LABEL_APP_KEY}=${LABEL_APP_VALUE}`] },
    })
    return cs.map((c) => this.toInfo(c))
  }

  // 一次性临时容器（#696）：创建（无 fleet 标签/无端口，见 buildOneShotOptions）→ 启动 → 等退出
  // → 强制删容器。成功（退出码 0）返回日志文本；非 0 抛 RunOnceError（携带退出码与输出）；
  // 三路（成功/非 0/异常）都清理容器。未设超时——调用命令是面板自派的（tar/doctor），
  // 卡死由编排层（#699）的容器生命周期兜底。
  async runOnce(spec: OneShotSpec): Promise<OneShotResult> {
    await this.ensureImage(spec.image)
    const container = await this.client().createContainer(this.buildOneShotOptions(spec))
    try {
      await container.start()
      const { StatusCode } = (await container.wait()) as { StatusCode: number }
      const output = await this.logsText(container)
      if (StatusCode !== 0) throw new RunOnceError(StatusCode, output, spec.cmd)
      return { output }
    } finally {
      await this.removeOneShot(container)
    }
  }

  // 删一次性临时容器（force）。只删容器、不删卷——挂载的卷是调用方资产（如备份卷），须留存。
  // 清理失败只告警不上抛：否则会掩盖主结果（命令已成功却被报成失败；非 0 退出的诊断被删除错误替换）。
  private async removeOneShot(container: Docker.Container): Promise<void> {
    try {
      await container.remove({ force: true })
    } catch (e) {
      console.warn(`[fleet] oneshot container cleanup failed: ${(e as Error).message}`)
    }
  }

  // 读容器日志（诊断用途，尽力而为）：读失败返回空串——日志是附加信息，绝不改变命令结果判定。
  private async logsText(container: Docker.Container): Promise<string> {
    try {
      const raw = await container.logs({ stdout: true, stderr: true })
      return demuxLogFrames(Buffer.from(raw))
    } catch {
      return ''
    }
  }

  // 枚举宿主上与发布地址冲突的活动容器宿主端口（含未跟踪容器；daemon 不可达 → 空集）。
  async hostPublishedPorts(): Promise<Set<number>> {
    const published = new Set<number>()
    let cs: Docker.ContainerInfo[]
    try {
      cs = await this.client().listContainers({ all: true })
    } catch {
      return published
    }
    for (const c of cs) {
      // exited/created/dead 容器保留 PortBindings 但 daemon 已收回端口（无活跃 docker-proxy）→ 跳过
      if (c.State === 'exited' || c.State === 'created' || c.State === 'dead') continue
      for (const p of c.Ports ?? []) {
        if (p.PublicPort === undefined) continue
        const hostIp = p.IP ?? '0.0.0.0'
        // 通配绑定（空/0.0.0.0）与任意发布地址冲突；具体地址仅在同 publishHost 时冲突。
        if (this.publishHost !== '0.0.0.0' && hostIp !== '0.0.0.0' && hostIp !== this.publishHost) continue
        published.add(p.PublicPort)
      }
    }
    return published
  }

  async get(name: string): Promise<ContainerInfo | null> {
    try {
      const c = this.client().getContainer(containerName(name))
      const data = await c.inspect()
      return this.inspectToInfo(data)
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
  }

  // 启动容器（删除前置修复 chown 用；已 running 幂等）。NotFound 幂等。
  async start(name: string): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).start()
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  // 按容器 id 启动（#591：create 返回 id → startById，消除 name 竞态）。404/304 幂等同 start。
  async startById(containerId: string): Promise<void> {
    try {
      await this.client().getContainer(containerId).start()
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      if (sc === 404 || sc === 304) return
      throw e
    }
  }

  async stop(name: string): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).stop({ t: 10 })
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      // 404 = 容器已消失；304 = 容器已处于 stopped（docker stop 对已停容器返 304 Not Modified）。
      // 两者均幂等成功——否则被外部 stop 的容器会让 delete worker 在此反复抛错、永远到不了 remove()，
      // 行卡 REMOVING 重试无解（Codex P2）。
      if (sc === 404 || sc === 304) return
      throw e
    }
  }

  // 删容器（v+force；NotFound 幂等）。volumes（#590 named volume 模式）提供时连带显式
  // docker volume rm 三卷（ADR 0011：remove({v:true}) 只删匿名卷，named volume 须显式删否则越攒
  // 越多）。容器 404（外部已删）也继续删卷——外部删容器不删卷，防卷泄漏；卷 404 幂等。
  async remove(name: string, volumes?: NamedVolumes): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).remove({ v: true, force: true })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e
      // 404（容器已不存在）：不提前返回——外部删容器不删卷，卷仍须尽力清理（防泄漏）
    }
    if (volumes) {
      for (const v of volumeOrder(volumes)) {
        try {
          await this.client().getVolume(v).remove()
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode !== 404) throw e
        }
      }
    }
  }

  async execInContainer(name: string, cmd: string[]): Promise<void> {
    try {
      const c = this.client().getContainer(containerName(name))
      const exec = await c.exec({ Cmd: cmd, AttachStdout: false, AttachStderr: false })
      await exec.start({ Detach: true })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  // 同步等命令完成；退出码非 0 → 抛错（approve CLI 失败须让 caller 走 STATUS_ERROR 路径）。
  async execSync(name: string, cmd: string[]): Promise<void> {
    let c: Docker.Container
    try {
      c = this.client().getContainer(containerName(name))
      await c.inspect()
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
    const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ Detach: false })
    const output = await this.collectOutput(stream)
    const info = await exec.inspect()
    if (info.ExitCode !== 0) {
      throw new Error(
        `exec_sync failed in ${name}: exit_code=${info.ExitCode} cmd=${JSON.stringify(cmd)} output=${JSON.stringify(output.slice(0, 500))}`,
      )
    }
  }

  private collectOutput(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (d: Buffer) => chunks.push(d))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
  }

  private toInfo(c: Docker.ContainerInfo): ContainerInfo {
    const labels = c.Labels ?? {}
    const rawPort = labels[LABEL_PORT_KEY]
    const port = rawPort !== undefined ? Number.parseInt(rawPort, 10) : null
    return {
      containerId: c.Id,
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      running: c.State === 'running',
      status: c.State ?? '',
      image: c.Image ?? '',
      port: Number.isNaN(port) ? null : port,
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }

  private inspectToInfo(data: Docker.ContainerInspectInfo): ContainerInfo {
    const labels = data.Config?.Labels ?? {}
    const rawPort = labels[LABEL_PORT_KEY]
    const port = rawPort !== undefined ? Number.parseInt(rawPort, 10) : null
    return {
      containerId: data.Id,
      name: (data.Name ?? '').replace(/^\//, ''),
      running: data.State?.Status === 'running',
      status: data.State?.Status ?? '',
      image: data.Config?.Image ?? '',
      port: Number.isNaN(port) ? null : port,
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }
}
