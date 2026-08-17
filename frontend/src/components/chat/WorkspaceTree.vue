<script setup lang="ts">
// WorkspaceTree —— chat/ 页 workspace 递归文件树（#626 T1 / #618 规格 §2，变体 A）。
// 哑组件：props 接扁平 DirListing（files 是 recursive walk 全量相对路径数组），内部构造嵌套目录树 →
// 按折叠态拍平渲染（无递归子组件，DFS rows）。点文件 emit open(path)，点目录切换折叠。
// 空态：truncated 树底提示 / 空 workspace / treeError / null tree。
import { computed, ref } from 'vue'
import type { DirListing, FileEntry } from '@/api/files'

defineOptions({ name: 'WorkspaceTree' })

const props = withDefaults(
  defineProps<{
    tree: DirListing | null
    activePath?: string
    treeError?: string | null
  }>(),
  { activePath: '', treeError: null },
)

const emit = defineEmits<{ open: [path: string] }>()

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
  file?: FileEntry
}

// 扁平 files → 嵌套目录树（目录优先 + 字母序）。目录节点从 file path 中间段推断 + 显式 directory 条目。
function buildRoot(listing: DirListing | null): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }
  if (!listing) return root
  const dirs = new Map<string, TreeNode>([['', root]])
  const ensureDir = (full: string): TreeNode => {
    const hit = dirs.get(full)
    if (hit) return hit
    const segs = full.split('/')
    const node: TreeNode = { name: segs[segs.length - 1], path: full, isDir: true, children: [] }
    ensureDir(segs.slice(0, -1).join('/')).children.push(node)
    dirs.set(full, node)
    return node
  }
  for (const fe of listing.files) {
    if (fe.type === 'directory') {
      ensureDir(fe.path)
      continue
    }
    const segs = fe.path.split('/')
    const leaf: TreeNode = { name: segs[segs.length - 1], path: fe.path, isDir: false, children: [], file: fe }
    ensureDir(segs.slice(0, -1).join('/')).children.push(leaf)
  }
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
    for (const c of n.children) if (c.isDir) sortRec(c)
  }
  sortRec(root)
  return root
}

const root = computed(() => buildRoot(props.tree))
const collapsed = ref(new Set<string>())

interface Row { node: TreeNode; depth: number }
// 按折叠态 DFS 拍平（折叠目录的子项跳过）
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const n of nodes) {
      out.push({ node: n, depth })
      if (n.isDir && !collapsed.value.has(n.path)) walk(n.children, depth + 1)
    }
  }
  walk(root.value.children, 0)
  return out
})

function toggle(path: string): void {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

const isEmpty = computed(() => !!props.tree && props.tree.files.length === 0 && !props.tree.truncated)
</script>

<template>
  <div class="ws-tree" data-test="ws-tree">
    <div v-if="treeError" class="state" data-test="tree-error">
      <span class="ic">⚠️</span>
      <span>无法读取 workspace：{{ treeError }}</span>
    </div>
    <div v-else-if="!tree" class="state" data-test="tree-loading">
      <span class="ic">⋯</span>
      <span>正在读取 workspace…</span>
    </div>
    <div v-else-if="isEmpty" class="state" data-test="tree-empty">
      <span class="ic">📁</span>
      <span>workspace 为空——agent 创建的文件会出现在这里</span>
    </div>
    <template v-else>
      <div
        v-for="r in rows"
        :key="r.node.path"
        class="tn"
        :class="{ dir: r.node.isDir, active: !r.node.isDir && r.node.path === activePath }"
        :style="{ paddingLeft: 6 + r.depth * 14 + 'px' }"
      >
        <button
          v-if="r.node.isDir"
          type="button"
          class="tn-btn"
          :data-test="`dir-${r.node.path}`"
          @click="toggle(r.node.path)"
        >
          <span class="caret">{{ collapsed.has(r.node.path) ? '▸' : '▾' }}</span>
          <span class="ic-folder">📁</span>
          <span class="nm">{{ r.node.name }}</span>
        </button>
        <button
          v-else
          type="button"
          class="tn-btn"
          :class="{ active: r.node.path === activePath }"
          :aria-current="r.node.path === activePath ? 'true' : undefined"
          :data-test="`node-${r.node.path}`"
          :title="r.node.path"
          @click="emit('open', r.node.path)"
        >
          <span class="caret"></span>
          <span class="ic-file">📄</span>
          <span class="nm">{{ r.node.name }}</span>
        </button>
      </div>
      <div v-if="tree.truncated" class="truncated" data-test="tree-truncated">
        条目过多，仅显示前 10000 项；未列出的文件仍可被 agent 修改并在此弹出
      </div>
    </template>
  </div>
</template>

<style scoped>
.ws-tree { height: 100%; overflow-y: auto; font-size: 13px; user-select: none; padding: 4px 0; }
.tn { display: flex; align-items: center; }
.tn-btn { display: flex; align-items: center; gap: 5px; width: 100%; border: none; background: transparent; color: var(--el-text-color-regular); font: inherit; text-align: left; padding: 4px 8px; cursor: pointer; min-width: 0; }
.tn-btn:hover { background: var(--el-fill-color-light); }
.tn-btn.active, .tn.active .tn-btn { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.tn-btn:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.caret { width: 10px; flex: none; color: var(--el-text-color-secondary); text-align: center; }
.ic-folder, .ic-file { flex: none; }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.truncated { padding: 8px 10px; margin-top: 6px; border-top: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 11.5px; line-height: 1.5; }
.state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--el-text-color-secondary); font-size: 13px; text-align: center; padding: 24px 16px; }
.state .ic { font-size: 26px; }
</style>
