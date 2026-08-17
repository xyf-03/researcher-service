// T10（docs/autofigure/tickets/T10-dev-sidecar-smoke.md）：dev 真实 AutoFigure 生成 smoke 的门控探测。
// 门控语义（T10 批准三条件，见 docs/autofigure/grilling-decisions.md §11）：Docker available +
// AUTOFIGURE_SMOKE === '1' + AUTOFIGURE_LLM_KEY 非空 → 真跑；缺任一 → describe.skipIf 整套跳过，
// 常规套件不依赖真实 key/daemon/sidecar。不要求宿主侧 AUTOFIGURE_SIDECAR_URL（dev compose 已供 server
// 容器内默认 http://autofigure:8080，见 deploy/docker-compose.dev.yml）。
//
// 与 smokeDocker.ts（异步镜像检查，containers-smoke hard-fail「必须真跑」）的差异：本探测是同步
// execFileSync docker info（describe.skipIf 收集阶段同步求值），失败静默 false 而非抛错——T10 是
// 门控 smoke（条件缺失即跳过），不继承 containers-smoke 的 hard-fail 语义（preflight 结论）。

import { execFileSync } from 'node:child_process'

// 同步探测 docker daemon 可达（不抛：CLI 缺失 / daemon 未起 / 无权限 → false）。
// stdio:'ignore' 不向测试输出泄漏 daemon 噪声；timeout 防 UNIX socket 连接挂起。
export function probeDockerAvailable(timeoutMs = 5_000): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: timeoutMs,
    })
    return true
  } catch {
    return false
  }
}

// 门控输入纯函数（可单测）：skip 条件恰好 = docker 可用 + AUTOFIGURE_SMOKE==='1' + LLM key 非空。
// 保持批准语义字面：LLM key 非空（不 trim——trim 是未批准的额外行为），SMOKE 必须严格等于 '1'。
export function shouldRunAutofigureSmoke(opts: {
  dockerAvailable: boolean
  smokeFlag: string | undefined
  llmKey: string | undefined
}): boolean {
  return (
    opts.dockerAvailable &&
    opts.smokeFlag === '1' &&
    (opts.llmKey ?? '') !== ''
  )
}

// 装配：从真实环境读三输入（figuresSmoke.test.ts 收集阶段调用一次）。
export function autofigureSmokeGate(): boolean {
  return shouldRunAutofigureSmoke({
    dockerAvailable: probeDockerAvailable(),
    smokeFlag: process.env.AUTOFIGURE_SMOKE,
    llmKey: process.env.AUTOFIGURE_LLM_KEY,
  })
}
