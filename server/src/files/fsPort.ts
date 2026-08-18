// FileArchive Port（#589 · ADR 0012 统一文件 CRUD 底层经 Docker 原语）。
// 业务层（routes/paths）只依赖本接口；docker 接触面在 dockerArchive.ts（getArchive/
// putArchive/exec），测试注入内存 fake（接缝 #2）。所有方法抛 files 域异常（errors.ts）：
// 不存在 → FileNotFound、已存在（create）→ FileExists、路径语义非法 → FileInvalidPath。
//
// 域边界：本 Port 拿「已过 paths.ts 校验的相对路径 + root」，自行拼容器内绝对路径；
// 穿越/绝对路径/反斜杠/NUL 防护在 paths.ts（请求层），二进制过滤与 walk 上限在适配层
// （tar 解析处，内存防护必须发生在数据落地前）。

// 两棵树标识：wiki = 容器内 ~/.openclaw/wiki/main；workspace = ~/.openclaw/workspace
export type FileRoot = 'wiki' | 'workspace'

export interface FileEntry {
  // 相对 root 的完整相对路径（无尾斜杠；目录经 type 区分）
  path: string
  type: 'file' | 'directory'
  size: number
  modified: string // ISO 8601（tar mtime 秒精度）
}

// read() 的目录分支：列目录/递归 walk 的结果。
export interface DirListing {
  kind: 'dir'
  path: string
  files: FileEntry[]
  // 条目数超 WALK_LIMIT 截断 → true（递归 walk 与超大直接子项列表都可能触发）
  truncated: boolean
}

// read() 的文件分支：仅文本返回内容；二进制（NUL 嗅探）与超大文件（> MAX_FILE_READ_BYTES）
// 不返回内容（content: null + 对应标志），接口不被大二进制拖垮。
export interface FileReading {
  kind: 'file'
  path: string
  content: string | null
  size: number
  modified: string
  binary: boolean
  oversized: boolean
}

export interface FileArchive {
  // 列目录或读文件：根条目是目录 → dir 分支（recursive=true 递归 walk）；文件 → file 分支。
  // 路径不存在 → FileNotFound。symlink 根条目 → FileInvalidPath（不支持读链接）。
  // name = 面板实例名（已过路由层 CONTAINER_NAME_REGEX 校验；适配层转 docker 容器名）。
  read(name: string, root: FileRoot, relPath: string, recursive: boolean): Promise<DirListing | FileReading>
  // 原始字节读取（WebChat 媒体通道，files/raw 端点）：不经 NUL 嗅探/UTF-8 转码，返回文件原生
  // Buffer——与 read() 的「二进制 → content:null」语义互补（read 面向文本投影，readBytes 面向
  // 字节透传，如 workspace 图片）。超大（> MAX_FILE_READ_BYTES）/ 非文件条目 → FileInvalidPath。
  readBytes(name: string, root: FileRoot, relPath: string): Promise<Buffer>
  // 覆写已存在文件（不存在 → FileNotFound）。写前幂等 start 容器（保 exec mkdir 可用）。
  write(name: string, root: FileRoot, relPath: string, content: string): Promise<void>
  // 新建文件（已存在 → FileExists）。
  create(name: string, root: FileRoot, relPath: string, content: string): Promise<void>
  // 删除文件（不存在 → FileNotFound；指向目录 → FileInvalidPath，只支持删文件）。
  delete(name: string, root: FileRoot, relPath: string): Promise<void>
  // config 写读（#591 · 静态 config，对 #366「宿主 rename + ro bind 热加载」的回退）：
  // 容器内 ~/.openclaw/openclaw.json（home 卷 / bind home 内）的 upsert 写与全量读。
  // 内部机制（models 写盘 / create 渲染落盘），REST 不可达——不扩展 FileRoot 枚举。
  // writeConfig 不依赖 exec/start（putArchive 对 created/stopped 容器可用）→ 支持
  // 「create 容器后写 config 再 start」，首启即读到渲染配置。读不存在 → FileNotFound。
  writeConfig(name: string, content: string): Promise<void>
  readConfig(name: string): Promise<string>
}
