// AutoFigure 计算 Port（T03，docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）。
//
// 边界纪律：本 Port 是「纯计算接缝」——把一次生成委托给外部执行体（V1 测试 = fake；生产 HTTP
// 适配器 / sidecar 属 T07，本票不决策任何凭证传输形态）。它只回答「给定输入 + 服务端凭证 →
// 成功/失败结果」。
//
// 它不拥有（任何一项都不）：持久化、生命周期、领取(claim)、轮询、超时、reconcile、幂等、归属、
// REST 信封。状态机转换由 runner.ts 负责；本 Port 无状态、可换、可测。
//
// 输入/凭证分离：credential 是服务端执行上下文（config.autofigure.llmKey 注入），不是生成请求的
// 域输入——因此不入 Job payload、不落盘、不入日志、永不进 HTTP 请求体（传输形态属 T07）。测试假体
// 必须分开记录 input 与 credential（见 test/figuresFakePort.ts）。

export interface AutoFigureGenerationInput {
  prompt: string // 生成请求的域输入（规范化后的 Figure.prompt）
}

export interface AutoFigureGenerationCredential {
  apiKey: string // 服务端执行上下文，非域输入；仅装配层注入，杜绝其他来源
}

// PNG 字节类型：Prisma Bytes 的结构等价（Bytes = ReturnType<Uint8Array['slice']> = Uint8Array<ArrayBuffer>）。
// Port 侧独立声明，避免引用 Prisma 命名空间（保持计算边界轻量）；与 Figure.png 持久化类型精确兼容。
export type FigurePngBytes = Uint8Array<ArrayBuffer>

// T06 成功结果携带产物（docs/autofigure/tickets/T06-artifact-persistence-png.md）：
// xml（文本）+ png（BLOB 源，用 Prisma Bytes = Uint8Array<ArrayBuffer> 精确对齐持久化类型）+
// evaluation（文本 JSON）三字段必填——成功即产物齐备，runner 在提交 succeeded 终态时一并原子落
// Figure（running/failed 不落成功产物）。
// evaluation 契约：Port 边界已归一化的非敏感 JSON 载荷（T07 适配器负责从 raw 执行输出构造），
// runner 原样持久化，不落 raw provider/Python 响应/栈/凭证。
export interface AutoFigureGenerationSuccess {
  ok: true
  xml: string
  png: FigurePngBytes
  evaluation: string
}

export interface AutoFigureGenerationFailure {
  ok: false
  errorMessage: string // 非敏感失败原因（runner 落库 errorMessage；不暴露内部栈/凭证）
}

export type AutoFigureGenerationResult = AutoFigureGenerationSuccess | AutoFigureGenerationFailure

// T07 追加（docs/autofigure/tickets/T07-autofigure-http-adapter.md · 已批准扩 Scope）：可选执行
// 取消信号。runner 恒持有 AbortController 并在每次 invocation 透传；同一 controller 的两个触发源——
// (A) T04 应用超时（AUTOFIGURE_JOB_TIMEOUT_MS，V1 唯一 execution timeout，不新增 adapter-local
// 超时契约/错误态/重试）(B) graceful shutdown / runner.stop()（不改 Job 业务终态，遗留 running 交
// 下次 startup 的 T04 reconcile）。可选项：实现可忽略（生产 adapter 与测试 fake 均 honor abort）；
// 中止后的结果由 runner 统一归一——超时 abort → JOB_TIMEOUT_REASON，shutdown abort → 不写终态。
// 成功结果恒在 abort 前 settle（微任务先于 timer 宏任务，绝不误标超时）。
export interface AutoFigureGenerationOptions {
  signal?: AbortSignal
}

export interface AutoFigureGenerationPort {
  generate(
    input: AutoFigureGenerationInput,
    credential: AutoFigureGenerationCredential,
    options?: AutoFigureGenerationOptions,
  ): Promise<AutoFigureGenerationResult>
}
