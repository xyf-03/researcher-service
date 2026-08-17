// DockerRuntime 适配层单测（接缝：clientFactory 注入 mock dockerode client）。
// 聚焦 Codex C5（P2）：stop 对「外部已停容器」(304) 与「不存在」(404) 须幂等成功，
// 否则被外部 stop 的容器让 delete worker 反复抛错、永远到不了 remove()，行卡 REMOVING 无解。
// 真容器端到端由 containers-smoke 覆盖；此处用 mock client 隔离 daemon 测错误码归一。

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { DockerRuntime } from '../src/containers/dockerRuntime'
import { namedVolumesFor } from '../src/containers/runtime'

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
