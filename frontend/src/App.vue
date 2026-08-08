<script setup lang="ts">
// #340-D（#328）：admin-only nav 条件渲染——仅 me.role==='admin' 时显示「账号管理」入口。
// 守卫本身（meta.requiresAdmin）负责兜底，nav 只是入口隐藏。
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const isAdmin = computed(() => auth.role === 'admin')
const loggingOut = ref(false)

async function handleLogout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await auth.logout()
    await router.replace('/login')
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
<div class="app-shell" :class="{ public: $route.meta.public }">
    <nav v-if="!$route.meta.public" class="app-nav">
      <router-link to="/">容器管理</router-link>
      <router-link to="/chat">对话</router-link>
      <router-link to="/wiki">Wiki</router-link>
      <router-link to="/categories">Categories</router-link>
      <router-link to="/models">Model 配置</router-link>
      <router-link v-if="isAdmin" to="/admin/users" data-test="nav-admin-users">账号管理</router-link>
      <router-link v-if="isAdmin" to="/admin/trace-logs" data-test="nav-trace-logs">内容消息</router-link>
      <button
        type="button"
        class="nav-logout"
        data-test="nav-logout"
        :disabled="loggingOut"
        @click="handleLogout"
      >
        {{ loggingOut ? '正在退出…' : '退出登录' }}
      </button>
    </nav>
    <div class="app-content">
      <router-view />
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100svh;
  min-height: 0;
  overflow: hidden;
}
.app-nav {
  display: flex;
  flex: none;
  gap: 18px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.app-nav a {
  color: var(--el-text-color-secondary);
  text-decoration: none;
  font-size: 14px;
}
.app-nav a.router-link-active {
  color: var(--el-color-primary);
  font-weight: 600;
}
.app-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.nav-logout {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.nav-logout:hover {
  color: var(--el-color-primary);
}
.nav-logout:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
