// T03 测试 Port 假体（test 目录，非生产代码）。
//
// 三件事：
//   1. 记录每次 generate 的 input 与 credential——**分开**记录（T03 边界纪律：凭证是服务端执行
//      上下文，不与生成输入混同；验收「凭证被注入 Port 且不与 prompt 混同」的断言点）。
//   2. 可编排结果：脚本队列（每次弹一个；空则默认成功）、抛错模式（模拟执行体崩溃）、
//      挂起模式（generate 返回受控 pending，测试 resolveNext() 驱动——驱动 concurrency=1
//      下的重叠执行场景）。
//   3. 计数 generate 调用，配合 active 守卫断言「不重复执行 / 不自动重试」。

import type {
  AutoFigureGenerationCredential,
  AutoFigureGenerationInput,
  AutoFigureGenerationOptions,
  AutoFigureGenerationPort,
  AutoFigureGenerationResult,
  AutoFigureGenerationSuccess,
} from '../src/figures/port'

// T06 默认成功产物（fake 无脚本时的兜底成功）：确定性字节/文本——PNG 带真实 magic 前缀 + 固定
// 尾字节，供「精确字节回读」断言（测试可覆盖部分字段注入自定义产物）。
export function okArtifacts(overrides: Partial<Omit<AutoFigureGenerationSuccess, 'ok'>> = {}): AutoFigureGenerationSuccess {
  return {
    ok: true,
    xml: '<mxfile host="fake" type="device"><diagram/></mxfile>',
    // PNG magic (89 50 4E 47 0D 0A 1A 0A) + 固定差异字节，字节级可断言。
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]),
    evaluation: '{"ok":true,"quality":"good"}',
    ...overrides,
  }
}

export class FakeAutoFigureGenerationPort implements AutoFigureGenerationPort {
  /** 每次 generate 的 (input, credential, signal) 记录——分开断言，不混同 */
  calls: Array<{
    input: AutoFigureGenerationInput
    credential: AutoFigureGenerationCredential
    signal?: AbortSignal
  }> = []
  /** 抛错模式：generate 抛异常（模拟执行体崩溃/网络异常 → runner 归一 failed） */
  throwOnGenerate = false
  /** 挂起模式：generate 返回受控 pending promise，由 resolveNext() 手动 settle；
   *  T07 扩 Scope：pending 期间若传入 signal 且被 abort → reject（模拟真 fetch 被取消，
   *  供 runner T04 超时中止在飞生成的集成测试断言 pump 解卡） */
  mode: 'auto' | 'pending' = 'auto'

  private readonly script: AutoFigureGenerationResult[]
  private readonly resolvers: Array<(result: AutoFigureGenerationResult) => void> = []
  private readonly enteredWaiters: Array<() => void> = []

  constructor(script: AutoFigureGenerationResult[] = []) {
    this.script = [...script]
  }

  async generate(
    input: AutoFigureGenerationInput,
    credential: AutoFigureGenerationCredential,
    options?: AutoFigureGenerationOptions,
  ): Promise<AutoFigureGenerationResult> {
    this.calls.push({ input, credential, signal: options?.signal })
    // 同步块内先发「已进入」信号，再注册 pending resolver——测试先 await generateEntered()
    // 再 resolveNext()，即保证 resolver 已就位，消除竞态。
    this.enteredWaiters.shift()?.()
    if (this.throwOnGenerate) throw new Error('simulated port crash')
    if (this.mode === 'pending') {
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          if (options.signal.aborted) {
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
            return
          }
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
            { once: true },
          )
        }
        this.resolvers.push((r) => resolve(r))
      })
    }
    return this.script.length > 0 ? (this.script.shift() as AutoFigureGenerationResult) : okArtifacts()
  }

  /** 注册一个「下一次 generate 已进入」的等待点（必须在触发 generate 之前调用） */
  generateEntered(): Promise<void> {
    return new Promise((resolve) => {
      this.enteredWaiters.push(resolve)
    })
  }

  /** pending 模式下 resolve 下一次挂起的 generate（缺省成功结果 + 确定性产物） */
  resolveNext(result: AutoFigureGenerationResult = okArtifacts()): void {
    this.resolvers.shift()?.(result)
  }
}
