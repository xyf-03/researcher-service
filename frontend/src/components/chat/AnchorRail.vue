<script setup lang="ts">
// 锚点刻度轨（issue #669 / #667 spec「消息锚点导航」）：props-in/emits-out 哑组件——
// 锚点数组（消息下标 + 轨上比例 + hover 摘要）由宿主 ChatStream 算好注入；本组件只做表现：
// 每刻度一个按钮（命中区放大、hover 出摘要 tooltip、scrollspy active 态），点击 emit jump。
// 轨 sticky 定位于滚动容器右缘（视口高），窄屏 (<720px) 保留（#667 验收）。
import { ref } from 'vue'

export interface AnchorPoint {
  index: number // 锚定消息在 messages 数组中的下标（与渲染 key 策略一致）
  ratio: number // 轨上位置比例（0=顶 1=底），宿主按滚动文档位置算出
  summary: string // hover 摘要（文本前几十字 / 媒体类型占位）
}

defineProps<{
  anchors: AnchorPoint[]
  activeIndex: number // scrollspy active 锚点序号（anchors 数组下标；-1 无 active）
  railHeight: number // 轨显式高度 px（= 滚动容器 clientHeight，宿主度量注入——sticky 0 高占位
                     // 的包含块高度为 0，纯 CSS 拿不到视口高，须由宿主注入）
}>()

const emit = defineEmits<{
  jump: [index: number]
}>()

// hover 态（JS 控制显隐而非纯 CSS :hover——行为可测；同一时刻至多展开一个 tooltip）
const hoverPos = ref(-1)
</script>

<template>
  <!-- sticky + 0 高占位：轨随视口固定在滚动容器右缘，不随内容滚走；子级 absolute 显式高度撑视口 -->
  <div v-if="anchors.length" class="rail-holder">
    <nav class="rail" data-test="anchor-rail" aria-label="消息锚点导航" :style="{ height: `${railHeight}px` }">
      <button
        v-for="(a, i) in anchors"
        :key="a.index"
        type="button"
        class="dot"
        :class="{ active: i === activeIndex }"
        :style="{ top: `${a.ratio * 100}%` }"
        :data-test="`anchor-dot-${a.index}`"
        :aria-label="a.summary"
        @click="emit('jump', a.index)"
        @mouseenter="hoverPos = i"
        @mouseleave="hoverPos = -1"
        @focus="hoverPos = i"
        @blur="hoverPos = -1"
      >
        <!-- 摘要 tooltip：不设原生 title——与自定义 tip 叠加会双 tooltip；focus 也触发（键盘可达） -->
        <span v-if="hoverPos === i" class="tip" :data-test="`anchor-tip-${a.index}`">{{ a.summary }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/* rail-holder：sticky 0 高占位（随内容流但贴视口顶），rail absolute 定位撑满 .stream 视口高。
   右缘窄条不遮挡居中的「回到底部」按钮；z-index 低于弹出的 tooltip 自身。 */
.rail-holder { position: sticky; top: 0; height: 0; z-index: 1; }
.rail {
  position: absolute;
  top: 0;
  right: 0;
  width: 20px;
  display: block; /* 高度由宿主注入（railHeight px）——sticky 0 高占位的包含块不可用 % */
}
/* 刻度按钮：absolute 按比例分布（top %）+ translateY(-50%) 居中对齐；14px 命中区（4px 刻度点外） */
.dot {
  position: absolute;
  left: 0;
  display: block;
  width: 20px;
  height: 14px; /* 命中区放大：4px 刻度点外 14px 可点 */
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  transform: translateY(-50%);
}
.dot::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--el-border-color);
  transition: background .15s, transform .15s;
}
.dot:hover::after { background: var(--el-color-primary); }
.dot.active::after { background: var(--el-color-primary); transform: translate(-50%, -50%) scale(1.6); }
/* tooltip：向左弹出，非换行单行 */
.tip {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-primary);
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 12px;
  box-shadow: var(--el-box-shadow-light);
  pointer-events: none;
  z-index: 3;
}
</style>
