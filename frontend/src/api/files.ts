// files API —— workspace 文件树 + 单文件只读全文（#626 T1 / #618 规格 §1）。
// 直读控制面 files REST（#586/#589 已就绪）：listWorkspaceTree 递归拉全量树、readWorkspaceFile 拉单文件全文。
// 走 apiJson（自动 #312 信封解包 + 401 刷新链，client.ts:112）。v1 只读——tabs 不回写，不实现 PUT/POST/DELETE。
//
// 镜像类型与 server/src/files/fsPort.ts:13-40 逐字段对齐（前端本地定义，不 import server 类型——
// 对齐 api/containers.ts:4-20 / api/wiki.ts 的本地 DTO 惯例）。
import { apiJson } from '@/api/client'

export interface FileEntry {
  path: string // 相对 root 的完整相对路径（无尾斜杠；目录经 type 区分）
  type: 'file' | 'directory'
  size: number
  modified: string // ISO 8601
}

export interface DirListing {
  kind: 'dir'
  path: string
  files: FileEntry[]
  // 条目数超 WALK_LIMIT 截断 → true（递归 walk 全量后服务端置位）
  truncated: boolean
}

export interface FileReading {
  kind: 'file'
  path: string
  content: string | null // 文本返回内容；binary/oversized 返回 null + 对应标志
  size: number
  modified: string
  binary: boolean
  oversized: boolean
}

// 树：一次拉全量 workspace 嵌套（基线 3：recursive=true，10k 上限 truncated 时树底提示）
export function listWorkspaceTree(name: string): Promise<DirListing> {
  return apiJson<DirListing>(
    `/api/v1/containers/${encodeURIComponent(name)}/files?root=workspace&recursive=true`,
  )
}

// 单文件全文（树点击开只读 tab 时拉；后续 agent 自动弹 tab 票 result 后亦走此拉全文）
export function readWorkspaceFile(name: string, relPath: string): Promise<FileReading> {
  return apiJson<FileReading>(
    `/api/v1/containers/${encodeURIComponent(name)}/files?root=workspace&path=${encodeURIComponent(relPath)}`,
  )
}
