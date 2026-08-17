// 容器/编排域异常族（平移 backend/containers/fleet/values.py + ports.py，#334）。
// 区别于旧 Django「异常→HTTP 状态码」：本服务全部经信封码（#312 所有 REST HTTP 200）。
// 每个异常携带 code 字段，路由层不再逐类 catch —— 抛出的领域异常统一由
// toEnvelopeError 转译为 EnvelopeError（code 即信封码）。

import { CODE } from '../codes'

// 容器领域异常基类：携带信封码，message 默认取码表总述（可在抛出处覆盖更具体的文案）。
export class ContainerDomainError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

// 并发同名插入被 DB 唯一约束拒绝 / 进程内租约已持有（name 全局唯一，#312 锁）→ 20041
export class InstanceExists extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.NAME_CONFLICT, `实例名已存在: ${containerName}`)
  }
}

// 容器已停删但 home 目录清理失败（权限/属主）；保留 DB 行标 REMOVING 可重试 → 20045
export class InstanceCleanupError extends ContainerDomainError {
  constructor(
    public readonly containerName: string,
    public readonly path: string,
  ) {
    super(CODE.CLEANUP_FAILED, `容器已停删，但数据目录清理失败: ${path}`)
  }
}

// create 时目标 instance 目录已存在但 DB 无行（崩溃中断/外部残留/手动删 DB）→ 20044
export class InstanceDirExists extends ContainerDomainError {
  constructor(
    public readonly containerName: string,
    public readonly path: string,
  ) {
    super(CODE.ORPHAN_DIR, `该名称存在残留数据目录: ${path}`)
  }
}

// 端口分配重试用尽（池理论充足但持续冲突）；不可重试 → 90004
export class PortAllocationError extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.PORT_POOL_EXHAUSTED, `端口分配重试用尽: ${containerName}`)
  }
}

// 端口池内无可用端口（平移 ports.PortPoolExhausted）→ 90004
export class PortPoolExhausted extends ContainerDomainError {
  constructor(message: string) {
    super(CODE.PORT_POOL_EXHAUSTED, message)
  }
}

// 面板级配置缺失——LLM_API_KEY 等必填字段未设置 → 90003
// （#366：模板读取/解析失败也包成此错误，见 configWriter.ensureRenderer 转译说明）
export class ConfigurationError extends ContainerDomainError {
  constructor(public readonly field: string) {
    super(CODE.LLM_NOT_CONFIGURED, `${field} 未配置`)
  }
}

// 删除目标仍在 provisioning（在飞 create）。#313 起 delete 改置取消标志、正常路径不再抛；
// 保留此错误仅作「在飞冲突」备用码 20043（如状态异常的行）。
export class InstanceBusy extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.CONTAINER_BUSY, `容器正在创建中: ${containerName}`)
  }
}

// 配额超限（User.maxContainers）：createReserve 内按 owner 串行 count+create 收紧 check-then-act
// 竞态（Codex C4——并发不同名 create 不再双双绕过 count 双创建超配额）。20042。
export class QuotaExceeded extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.QUOTA_EXCEEDED, `容器数量已达配额上限: ${containerName}`)
  }
}

// openclaw.json 写盘失败（#591 起经 FileArchive.putArchive，原 #366 ConfigStore 宿主原子写 seam
// 已随 config 落容器内撤销）。models service 据此判定「盘未变」→ 事务回滚 DB 行 → 90003
//（ConfigWriteError 恒 = fs/docker 写失败、盘未变；reconcile 只对「盘已写而事务回滚」触发）。
// name = 面板实例名（诊断），path = 容器内 config 路径（诊断）。
export class ConfigWriteError extends Error {
  constructor(
    public readonly containerName: string,
    public readonly path: string,
  ) {
    super(`config write failed for ${containerName}: ${path}`)
    this.name = 'ConfigWriteError'
  }
}
