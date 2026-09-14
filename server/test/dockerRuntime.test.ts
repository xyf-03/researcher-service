// DockerRuntime 适配层单测（接缝：clientFactory 注入 mock dockerode client）。
// 聚焦 Codex C5（P2）：stop 对「外部已停容器」(304) 与「不存在」(404) 须幂等成功，
// 否则被外部 stop 的容器让 delete worker 反复抛错、永远到不了 remove()，行卡 REMOVING 无解。
// 真容器端到端由 containers-smoke 覆盖；此处用 mock client 隔离 daemon 测错误码归一。

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { DockerRuntime } from '../src/containers/dockerRuntime'
import { RunOnceError } from '../src/containers/errors'
import { namedVolumesFor } from '../src/containers/runtime'
import { LABEL_ONESHOT_KEY, LABEL_ONESHOT_VALUE } from '../src/containers/constants'

// 最小 mock：仅需 getContainer().stop() 能注入指定 statusCode 错误。
function mockDocker(stopErr?: { statusCode: number; message: string }): Docker {
  return {
    getContainer: () => ({
      stop: async () => {
        if (stopErr) {
          const e = new Error(stopErr.message) as Error & { statusCode: number }
          e.statusCode = stopErr.statusCode
          throw e
        }
      },
    }),
  } as unknown as Docker
}

describe('DockerRuntime stop 幂等（Codex C5）', () => {
  it('容器已被外部停止（304 Not Modified）→ 幂等成功不抛', async () => {
    const rt = new DockerRuntime(() => mockDocker({ statusCode: 304, message: 'container already stopped' }))
    await expect(rt.stop('box')).resolves.toBeUndefined()
  })

  it('容器不存在（404）→ 幂等成功不抛', async () => {
    const rt = new DockerRuntime(() => mockDocker({ statusCode: 404, message: 'no such container' }))
    await expect(rt.stop('box')).resolves.toBeUndefined()
  })

  it('其他错误码（500）→ 仍向上抛（不吞非幂等错误，避免掩盖真故障）', async () => {
    const rt = new DockerRuntime(() => mockDocker({ statusCode: 500, message: 'daemon internal error' }))
    await expect(rt.stop('box')).rejects.toThrow('daemon internal error')
  })
})

// ---- run 前拉取镜像（Codex 第四轮③[P1]）----
// run 只 createContainer+start，无 pull。Engine createContainer 对本地缺失镜像返回 image-not-found——
// 干净 host / OPENCLAW_IMAGE 换 tag 时 create 必 error（CI 此前靠手动 docker pull 掩盖）。修法：run 前
// getImage().inspect() 本地缺失(404) → pull（modem.followProgress 消费流）；已缓存 → 跳过，避免每次
// create 重复 pull。

function mockPullClient(opts: { imagePresent?: boolean; pullErr?: Error }): {
  docker: Docker
  pulls: string[]
} {
  const pulls: string[] = []
  const docker = {
    getImage: () => ({
      inspect: async () => {
        if (opts.imagePresent === false) {
          const e = new Error('no such image') as Error & { statusCode: number }
          e.statusCode = 404
          throw e
        }
        return {}
      },
    }),
    pull: async (image: string) => {
      pulls.push(image)
      if (opts.pullErr) throw opts.pullErr
      return Readable.from(['{}'])
    },
    getContainer: () => ({
      start: async () => {},
    }),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      lastCreateOptions = options
      return {
        id: 'cid-123',
        start: async () => {},
      }
    },
    modem: {
      followProgress: (_s: NodeJS.ReadableStream, onFinished: (err: Error | null) => void) =>
        onFinished(null),
    },
  } as unknown as Docker & { modem: unknown }
  return { docker: docker as unknown as Docker, pulls }
}

// 捕获最近一次 createContainer 的 options（供 bind 断链回归断言）
let lastCreateOptions: Docker.ContainerCreateOptions | undefined

describe('DockerRuntime ensureImage（Codex 第四轮③）', () => {
  const spec = (name: string, hostPort: number) => ({
    name,
    image: 'ghcr.io/openclaw/openclaw:test',
    hostPort,
    gatewayToken: 'tok',
    homeDir: '/tmp/home',
    llmApiKey: 'key',
  })

  it('本地镜像缺失 → create 前自动 pull（Engine createContainer 不因 image-not-found 失败）', async () => {
    const { docker, pulls } = mockPullClient({ imagePresent: false })
    const rt = new DockerRuntime(() => docker)
    const id = await rt.run(spec('r4-pull', 19000))
    expect(pulls).toEqual(['ghcr.io/openclaw/openclaw:test']) // 缺失 → 已拉取
    expect(id).toBe('cid-123') // create+start 成功
  })

  it('本地镜像已缓存 → 跳过 pull（避免每次 create 重复拉取）', async () => {
    const { docker, pulls } = mockPullClient({ imagePresent: true })
    const rt = new DockerRuntime(() => docker)
    await rt.run(spec('r4-cached', 19001))
    expect(pulls).toEqual([]) // 已缓存 → 不拉
  })

  it('pull 失败 → 向上抛（createComplete 标 error 行，可重试）', async () => {
    const { docker } = mockPullClient({ imagePresent: false, pullErr: new Error('registry unreachable') })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.run(spec('r4-pullfail', 19002))).rejects.toThrow('registry unreachable')
  })

  it('#591：bind 模式仅 home rw bind；无 config 独立 bind、无 OPENCLAW_CONFIG_PATH（静态 config）', async () => {
    // #366 的 config 独立目录 ro bind + OPENCLAW_CONFIG_PATH 已回退（#591）：openclaw.json 落
    // 容器内默认 ~/.openclaw/openclaw.json（home bind / 卷内），gateway 走默认路径读取——改配置
    // 须重启容器生效（静态 config）。
    const { docker } = mockPullClient({ imagePresent: true })
    const rt = new DockerRuntime(() => docker)
    await rt.run(spec('r1-bind', 19003))
    const binds = lastCreateOptions?.HostConfig?.Binds ?? []
    expect(binds).toEqual(['/tmp/home:/home/node/.openclaw:rw']) // workspace/wiki/state/logs 可写
    const env = (lastCreateOptions?.Env as string[]) ?? []
    expect(env.some((e) => e.startsWith('OPENCLAW_CONFIG_PATH='))).toBe(false)
  })

  it('#591 create：createContainer 不 start（config 写盘前置；首启读渲染配置）', async () => {
    const { docker, pulls } = mockPullClient({ imagePresent: true })
    const rt = new DockerRuntime(() => docker)
    const id = await rt.create(spec('r1-create', 19004))
    expect(id).toBe('cid-123') // createContainer 已调用
    expect(pulls).toEqual([]) // 镜像已缓存 → 未拉（ensureImage 同 run）
  })

  it('#591 run：create + start 的组合（id 级 start）', async () => {
    const { docker } = mockPullClient({ imagePresent: true })
    const rt = new DockerRuntime(() => docker)
    const id = await rt.run(spec('r1-runcombo', 19005))
    expect(id).toBe('cid-123')
  })
})

// ---- #590 named volume 拓扑（ADR 0011，OPENCLAW_NAMED_VOLUMES 开启）----
// spec.volumes（非 undefined）时：buildRunOptions 生成三卷 Mounts 替代 home/config host bind，
// env 不再指 CONFIG_BIND（容器内 openclaw.json 走默认 ~/.openclaw/，空卷首挂由镜像骨架初始化，
// #588）。remove 连带显式 docker volume rm 三卷（现有 remove({v:true}) 只删匿名卷），404 幂等。

// 卷删除 mock：getContainer().remove + getVolume(name).remove 记录，可注入卷删除错误。
function mockVolumeClient(opts: {
  containerErr?: { statusCode: number; message: string }
  volumeErr?: { statusCode: number; message: string }
}): { docker: Docker; removes: { container: boolean; volumes: string[] } } {
  const removes = { container: false, volumes: [] as string[] }
  const docker = {
    getContainer: () => ({
      remove: async () => {
        if (opts.containerErr) {
          const e = new Error(opts.containerErr.message) as Error & { statusCode: number }
          e.statusCode = opts.containerErr.statusCode
          throw e
        }
        removes.container = true
      },
    }),
    getVolume: (v: string) => ({
      remove: async () => {
        // 先记录尝试再抛错——真实 remove 每次调用都会先尝试（404 幂等语义由 runtime 处理）
        removes.volumes.push(v)
        if (opts.volumeErr) {
          const e = new Error(opts.volumeErr.message) as Error & { statusCode: number }
          e.statusCode = opts.volumeErr.statusCode
          throw e
        }
      },
    }),
  } as unknown as Docker
  return { docker, removes }
}

describe('DockerRuntime named volumes（#590）', () => {
  const spec = (name: string, hostPort: number) => ({
    name,
    image: 'ghcr.io/openclaw/openclaw:test',
    hostPort,
    gatewayToken: 'tok',
    homeDir: '/tmp/home',
    llmApiKey: 'key',
  })

  it('namedVolumesFor：按代系 id 派生三卷名（openclaw-<kind>-<id>，ADR 0011）', () => {
    expect(namedVolumesFor('gen-1')).toEqual({
      wiki: 'openclaw-wiki-gen-1',
      workspace: 'openclaw-workspace-gen-1',
      home: 'openclaw-home-gen-1',
    })
  })

  it('spec.volumes 提供时：buildRunOptions 生成三卷 Mounts（wiki/main、workspace、home），无 home bind', () => {
    const rt = new DockerRuntime(() => mockPullClient({ imagePresent: true }).docker)
    const opts = rt.buildRunOptions({ ...spec('nv-box', 19100), volumes: namedVolumesFor('gen-1') })
    expect(opts.HostConfig?.Mounts).toEqual([
      { Type: 'volume', Source: 'openclaw-wiki-gen-1', Target: '/home/node/.openclaw/wiki/main' },
      { Type: 'volume', Source: 'openclaw-workspace-gen-1', Target: '/home/node/.openclaw/workspace' },
      { Type: 'volume', Source: 'openclaw-home-gen-1', Target: '/home/node/.openclaw' },
    ])
    expect(opts.HostConfig?.Binds).toBeUndefined() // home bind 去除
    const env = (opts.Env as string[]) ?? []
    expect(env.some((e) => e.startsWith('OPENCLAW_CONFIG_PATH='))).toBe(false) // 静态 config（#591）
  })

  it('spec.volumes 缺省（flag 关）：仅 home rw bind（config bind 已随 #591 移除）', () => {
    const rt = new DockerRuntime(() => mockPullClient({ imagePresent: true }).docker)
    const opts = rt.buildRunOptions(spec('old-box', 19101))
    expect(opts.HostConfig?.Mounts).toBeUndefined()
    expect(opts.HostConfig?.Binds).toEqual(['/tmp/home:/home/node/.openclaw:rw'])
  })

  it('remove：删容器后连带 docker volume rm 三卷（wiki/workspace/home 顺序）', async () => {
    const { docker, removes } = mockVolumeClient({})
    const rt = new DockerRuntime(() => docker)
    await rt.remove('nv-box', namedVolumesFor('gen-1'))
    expect(removes.container).toBe(true)
    expect(removes.volumes).toEqual(['openclaw-wiki-gen-1', 'openclaw-workspace-gen-1', 'openclaw-home-gen-1'])
  })

  it('remove：容器 404（外部已删）→ 仍尽力删卷（防卷越攒越多）', async () => {
    const { docker, removes } = mockVolumeClient({
      containerErr: { statusCode: 404, message: 'no such container' },
    })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.remove('nv-box', namedVolumesFor('gen-1'))).resolves.toBeUndefined()
    expect(removes.volumes).toHaveLength(3)
  })

  it('remove：卷 404（已被外部清理）→ 幂等不抛', async () => {
    const { docker, removes } = mockVolumeClient({
      volumeErr: { statusCode: 404, message: 'no such volume' },
    })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.remove('nv-box', namedVolumesFor('gen-1'))).resolves.toBeUndefined()
    expect(removes.volumes).toHaveLength(3) // 三卷均尝试，各自 404 幂等
  })

  it('remove：不传 volumes（flag 关）→ 只删容器不删卷（旧行为）', async () => {
    const { docker, removes } = mockVolumeClient({})
    const rt = new DockerRuntime(() => docker)
    await rt.remove('old-box')
    expect(removes.container).toBe(true)
    expect(removes.volumes).toEqual([])
  })

  it('remove：卷删除失败（500）→ 向上抛（不吞 daemon 故障）', async () => {
    const { docker } = mockVolumeClient({ volumeErr: { statusCode: 500, message: 'daemon error' } })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.remove('nv-box', namedVolumesFor('gen-1'))).rejects.toThrow('daemon error')
  })
})

// ---- #696 oneshot 原语（升级编排前置）：以指定镜像 + 指定命令跑一次性临时容器 ----
// 关键不变量：临时容器不带任何 fleet 标签（app=openclaw-fleet / openclaw.instance / openclaw.port），
// 也不发布宿主端口——listFleet（按 app 标签过滤）与宿主端口对账（按发布端口聚合）对它天然不可见。

describe('DockerRuntime.runOnce（#696 一次性临时容器）', () => {
  it('buildOneShotOptions：仅 oneshot 标记标签、无端口发布；覆写镜像 ENTRYPOINT 且清空 Cmd', () => {
    const rt = new DockerRuntime(() => mockPullClient({ imagePresent: true }).docker)
    const opts = rt.buildOneShotOptions({
      image: 'ghcr.io/openclaw/openclaw:test',
      cmd: ['sh', '-c', 'echo hi'],
      mounts: [
        { source: 'openclaw-home-gen-1', target: '/home/node/.openclaw' },
        { source: 'openclaw-home-backup-gen-1', target: '/backup', readOnly: true },
      ],
    })
    expect(opts.Image).toBe('ghcr.io/openclaw/openclaw:test')
    // 独立标记标签——fleet 列表按 app=openclaw-fleet 过滤 → 临时容器不可见
    expect(opts.Labels).toEqual({ [LABEL_ONESHOT_KEY]: LABEL_ONESHOT_VALUE })
    // 无端口发布/暴露——宿主端口对账不可见
    expect(opts.HostConfig?.PortBindings).toBeUndefined()
    expect(opts.ExposedPorts).toBeUndefined()
    // 覆写镜像 ENTRYPOINT（官方镜像为 tini）+ 清空镜像 Cmd（否则会作为参数追加到 entrypoint 之后）
    expect(opts.Entrypoint).toEqual(['sh', '-c', 'echo hi'])
    expect(opts.Cmd).toEqual([])
    // 挂载按传入顺序（doctor 三卷 / 备份卷+home 卷），readOnly 仅显式要求时出现
    expect(opts.HostConfig?.Mounts).toEqual([
      { Type: 'volume', Source: 'openclaw-home-gen-1', Target: '/home/node/.openclaw' },
      { Type: 'volume', Source: 'openclaw-home-backup-gen-1', Target: '/backup', ReadOnly: true },
    ])
  })

  it('buildOneShotOptions：无 mounts → 无 Mounts/Binds（纯命令容器）', () => {
    const rt = new DockerRuntime(() => mockPullClient({ imagePresent: true }).docker)
    const opts = rt.buildOneShotOptions({ image: 'img', cmd: ['true'] })
    expect(opts.HostConfig?.Mounts).toBeUndefined()
    expect(opts.HostConfig?.Binds).toBeUndefined()
  })

  it('buildOneShotOptions：spec.env 覆盖/追加到基础 env（卷内配置占位插值所需）', () => {
    const rt = new DockerRuntime(() => mockPullClient({ imagePresent: true }).docker)
    const opts = rt.buildOneShotOptions({ image: 'img', cmd: ['true'], env: { GATEWAY_TOKEN: 'tok-1' } })
    const env = (opts.Env as string[]) ?? []
    expect(env).toContain('GATEWAY_TOKEN=tok-1')
    expect(env).toContain('HOME=/home/node') // 基础 env 仍在（CLI 靠 HOME 定位 ~/.openclaw）
  })
})

// docker 多路复用帧编码（非 TTY 日志形状：8 字节头 [stream,0,0,0,size_be32] + 负载）。按字节构造：
// 多字节用例要把同一字符拆到相邻两帧，故文本便捷版也走这一实现（单一构造点）。
function frameBytes(stream: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head[0] = stream // 1=stdout 2=stderr
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}
function frame(stream: number, text: string): Buffer {
  return frameBytes(stream, Buffer.from(text, 'utf8'))
}

// 一次性临时容器的 mock client：createContainer 返回可编程 container（start/wait/logs/remove），
// logs 默认回上方帧编码拼出的流。
function mockOneShotClient(opts: {
  exitCode?: number
  stdout?: string
  stderr?: string
  startErr?: Error
  waitErr?: Error
  logsErr?: Error
  removeErr?: { statusCode: number; message: string }
  rawLogs?: Buffer // 覆盖帧编码（测非帧/异常形状）
}): { docker: Docker; calls: { started: boolean; removed: boolean; removeOpts: unknown; createOpts: unknown } } {
  const calls = { started: false, removed: false, removeOpts: undefined as unknown, createOpts: undefined as unknown }
  const logs =
    opts.rawLogs ??
    Buffer.concat([
      ...(opts.stdout ? [frame(1, opts.stdout)] : []),
      ...(opts.stderr ? [frame(2, opts.stderr)] : []),
    ])
  const docker = {
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      calls.createOpts = options
      return {
        id: 'oneshot-cid',
        start: async () => {
          calls.started = true
          if (opts.startErr) throw opts.startErr
        },
        wait: async () => {
          if (opts.waitErr) throw opts.waitErr
          return { StatusCode: opts.exitCode ?? 0 }
        },
        logs: async () => {
          if (opts.logsErr) throw opts.logsErr
          return logs
        },
        remove: async (o: unknown) => {
          calls.removed = true
          calls.removeOpts = o
          if (opts.removeErr) {
            const e = new Error(opts.removeErr.message) as Error & { statusCode: number }
            e.statusCode = opts.removeErr.statusCode
            throw e
          }
        },
      }
    },
  } as unknown as Docker
  return { docker, calls }
}

describe('DockerRuntime.runOnce 退出码与清理（#696）', () => {
  const spec = { image: 'ghcr.io/openclaw/openclaw:test', cmd: ['sh', '-c', 'echo hi'] }

  it('退出码 0 → 返回 stdout+stderr 合并文本（去多路复用帧头），容器被强制删', async () => {
    const { docker, calls } = mockOneShotClient({ stdout: 'backup done\n', stderr: 'warn: none\n' })
    const rt = new DockerRuntime(() => docker)
    const res = await rt.runOnce(spec)
    expect(res.output).toBe('backup done\nwarn: none\n')
    expect(calls.started).toBe(true)
    expect(calls.removed).toBe(true)
    // 装配断点：runOnce 真把 buildOneShotOptions 的结果交给 createContainer（两者各自单测不覆盖此处，
    // 否则这条链只有真 daemon 冒烟兜底）。标签/无端口/Cmd 清空等形状细节由 buildOneShotOptions 用例负责。
    expect(calls.createOpts).toMatchObject({
      Image: spec.image,
      Entrypoint: [...spec.cmd],
      Cmd: [],
      Labels: { [LABEL_ONESHOT_KEY]: LABEL_ONESHOT_VALUE },
    })
    // 只删容器（force），不删卷——备份卷等调用方资产须留存
    expect(calls.removeOpts).toEqual({ force: true })
  })

  it('非 0 退出 → 抛 RunOnceError（携带退出码与输出），容器仍被清理', async () => {
    const { docker, calls } = mockOneShotClient({ exitCode: 7, stderr: 'doctor failed: legacy store\n' })
    const rt = new DockerRuntime(() => docker)
    const err = await rt.runOnce(spec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunOnceError)
    expect((err as RunOnceError).exitCode).toBe(7)
    expect((err as RunOnceError).output).toContain('doctor failed')
    expect(calls.removed).toBe(true)
  })

  it('启动失败（create 成功但 start 抛错）→ 原错上抛，容器仍被清理', async () => {
    const { docker, calls } = mockOneShotClient({ startErr: new Error('start blew up') })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.runOnce(spec)).rejects.toThrow('start blew up')
    expect(calls.started).toBe(true) // 确已走到 start（异常来自启动而非更早的 create）
    expect(calls.removed).toBe(true) // 已创建的容器不留残骸
  })

  it('等待退出时 daemon 报错（异常路径）→ 原错上抛，容器仍被清理', async () => {
    const { docker, calls } = mockOneShotClient({ waitErr: new Error('daemon blew up') })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.runOnce(spec)).rejects.toThrow('daemon blew up')
    expect(calls.removed).toBe(true)
  })

  it('清理失败（remove 500）→ 不掩盖主错误：非 0 退出仍抛 RunOnceError，成功仍 resolve', async () => {
    const failed = mockOneShotClient({ exitCode: 3, removeErr: { statusCode: 500, message: 'remove failed' } })
    const rt1 = new DockerRuntime(() => failed.docker)
    await expect(rt1.runOnce(spec)).rejects.toBeInstanceOf(RunOnceError)
    const ok = mockOneShotClient({ removeErr: { statusCode: 500, message: 'remove failed' } })
    const rt2 = new DockerRuntime(() => ok.docker)
    await expect(rt2.runOnce(spec)).resolves.toEqual({ output: '' })
  })

  it('logs 形状非多路复用帧（daemon 直返原文）→ 原样返回，不丢诊断日志', async () => {
    const { docker } = mockOneShotClient({ rawLogs: Buffer.from('plain text output', 'utf8') })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.runOnce(spec)).resolves.toEqual({ output: 'plain text output' })
  })

  it('多字节字符被拆到相邻两帧 → 整体解码，不裂成替换符', async () => {
    // 「报」的 UTF-8 是 3 字节 E6 8A A5——故意拆成一帧 1 字节 + 一帧 2 字节（docker 按写系统调用切帧）
    const raw = Buffer.concat([
      frameBytes(1, Buffer.from([0xe6])),
      frameBytes(1, Buffer.from([0x8a, 0xa5])),
      frameBytes(1, Buffer.from('\n')),
    ])
    const { docker } = mockOneShotClient({ rawLogs: raw })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.runOnce(spec)).resolves.toEqual({ output: '报\n' })
  })

  it('帧流末尾残帧（声明长度超出实到字节）→ 已收齐的帧照常返回，不整段吞掉', async () => {
    // 末帧头声明 8 字节、实际只到 2 字节：按「帧流结束」处理，前面完整帧仍返回
    const full = Buffer.concat([frame(1, 'kept\n'), frameBytes(1, Buffer.from('abcdefgh'))])
    const truncated = full.subarray(0, full.length - 6)
    const { docker } = mockOneShotClient({ rawLogs: truncated })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.runOnce(spec)).resolves.toEqual({ output: 'kept\n' })
  })

  it('日志读取失败 → 不改变命令结果（诊断尽力而为：成功仍 resolve，非 0 仍抛退出码）', async () => {
    const ok = mockOneShotClient({ stdout: 'x', logsErr: new Error('logs unavailable') })
    const rt1 = new DockerRuntime(() => ok.docker)
    await expect(rt1.runOnce(spec)).resolves.toEqual({ output: '' })

    const bad = mockOneShotClient({ exitCode: 9, logsErr: new Error('logs unavailable') })
    const rt2 = new DockerRuntime(() => bad.docker)
    const err = await rt2.runOnce(spec).catch((e: unknown) => e)
    expect((err as RunOnceError).exitCode).toBe(9) // 退出码不被日志故障吞掉
    expect((err as RunOnceError).output).toBe('')
  })
})
