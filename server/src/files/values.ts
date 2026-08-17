// files 域常量（#589 · ADR 0012 文件查询经 Docker getArchive/putArchive）。
// 单一来源：root 容器内路径 / walk 上限 / 单文件读取上限。供纯逻辑（paths.ts）、
// docker 适配器（dockerArchive.ts）、测试复用。

import { HOME_BIND } from '../containers/constants'

// 两棵树在容器内的固定路径（named volume 挂载点内，#588 派生镜像烤入骨架）。
// wiki 树根 = ~/.openclaw/wiki/main；workspace 树根 = ~/.openclaw/workspace。
export const FILE_ROOTS: Record<'wiki' | 'workspace', string> = {
  wiki: `${HOME_BIND}/wiki/main`,
  workspace: `${HOME_BIND}/workspace`,
}

// 递归 walk 条目数上限（#586 US9）：巨型目录不拖垮接口——超限即停并标 truncated。
export const WALK_LIMIT = 10_000

// 单文件内容读取上限（字节）：tar 头带 size，超过则按「不可读」过滤（不收集内容），
// 防超大二进制/文本文件撑爆控制面内存（#586 US8「接口不会被大二进制拖垮」）。
export const MAX_FILE_READ_BYTES = 16 * 1024 * 1024
