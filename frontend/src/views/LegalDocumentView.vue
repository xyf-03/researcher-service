<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

type LegalDocument = 'terms' | 'privacy'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const errorMsg = ref('')
const markdown = ref('')

const documentType = computed(() => route.params.type as LegalDocument)
const title = computed(() => (documentType.value === 'privacy' ? '隐私政策' : '用户服务协议'))

function filePath(type: LegalDocument): string {
  return type === 'privacy' ? '/legal/privacy.md' : '/legal/terms.md'
}

async function loadDocument(): Promise<void> {
  if (!['terms', 'privacy'].includes(documentType.value)) {
    await router.replace('/login')
    return
  }
  loading.value = true
  errorMsg.value = ''
  try {
    const resp = await fetch(filePath(documentType.value))
    if (!resp.ok) throw new Error('failed to load legal document')
    markdown.value = await resp.text()
  } catch {
    errorMsg.value = '文档加载失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

onMounted(loadDocument)
watch(() => route.params.type, loadDocument)
</script>

<template>
  <main class="legal-page">
    <header class="legal-header">
      <router-link class="back-link" to="/login">返回登录</router-link>
      <h1>{{ title }}</h1>
    </header>

    <el-skeleton v-if="loading" :rows="8" animated />
    <el-alert v-else-if="errorMsg" :title="errorMsg" type="error" :closable="false" />
    <article v-else class="legal-document">
      <MarkdownRenderer :text="markdown" :streaming="false" />
    </article>
  </main>
</template>

<style scoped>
.legal-page {
  width: min(920px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0 48px;
}
.legal-header {
  margin-bottom: 20px;
}
.back-link {
  color: var(--el-color-primary);
  font-size: 14px;
  text-decoration: none;
}
.back-link:hover {
  text-decoration: underline;
}
.legal-header h1 {
  color: var(--el-text-color-primary);
  font-size: 28px;
  line-height: 1.3;
  margin: 12px 0 0;
}
.legal-document {
  color: var(--el-text-color-primary);
  font-size: 14px;
  line-height: 1.8;
}
</style>
