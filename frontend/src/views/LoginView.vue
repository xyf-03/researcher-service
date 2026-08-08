<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/errors'
import { changePassword } from '@/api/auth'

// spec §9.2：本地账号登录表单 + #340-A 强制改密（mustChangePassword=true 的账号首登须改密，
// bootstrap/发放的临时密码不残留）。提交后存 access token 并跳容器管理页。
// #340-A 改密模式：me.mustChangePassword → 显示改密表单（旧+新+确认）；成功后服务端已撤销
// 全部 refresh + 清 cookie，须用新密码重新 login 建立会话，再跳容器页。
const auth = useAuthStore()
const router = useRouter()
const mode = ref<'login' | 'change'>('login')
const form = reactive({ username: '', password: '' })
// 改密表单（#340-A）：old + new + 确认；new 至少 8 字符（与后端 passwordChangeSchema 对齐）
const changeForm = reactive({ oldPassword: '', newPassword: '', confirm: '' })
const errorMsg = ref('')
// #419-2：提交中 loading——按钮禁用防重复点击；表单走原生 submit 语义（输入框内回车即可提交）
const submitting = ref(false)

async function onSubmit(): Promise<void> {
  if (submitting.value) return // 防重复提交（loading 禁用之外的双保险）
  errorMsg.value = ''
  submitting.value = true
  try {
    await auth.login(form.username, form.password)
    await afterLogin()
  } catch (err) {
    // codex P2：仅「已解析的 API 错误」（rejectWithApiError 抛的 ApiError）逐字透传
    // 后端真实校验消息（如「这个密码太常见了。」）。fetch 因后端不可达 reject 抛原生
    // TypeError（"Failed to fetch"/"Load failed"）属网络/意外错误,不带可读 API 消息,
    // 须走模式专属本地化兜底——旧实现只判 err.message 非空会把英文浏览器报错漏给用户。
    errorMsg.value =
      err instanceof ApiError && err.message
        ? err.message
        : mode.value === 'login'
          ? '登录失败，请稍后重试'
          : '修改密码失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

// #340-A：登录后按 me.mustChangePassword 分流——true 进改密模式（强制改密，不跳容器页）
async function afterLogin(): Promise<void> {
  if (auth.mustChangePassword) {
    mode.value = 'change'
    return
  }
  await router.push('/')
}

// #340-A：提交强制改密。成功后服务端已撤销全部 refresh + 清 cookie（R1），本地清 token
// 再以新密码重新 login（refresh 无效，原会话不得复用）。
async function onChangeSubmit(): Promise<void> {
  if (submitting.value) return // 防重复提交
  errorMsg.value = ''
  if (changeForm.newPassword !== changeForm.confirm) {
    errorMsg.value = '两次输入的新密码不一致'
    return
  }
  if (changeForm.newPassword.length < 8) {
    errorMsg.value = '新密码至少 8 个字符'
    return
  }
  submitting.value = true
  try {
    await changePassword(changeForm.oldPassword, changeForm.newPassword)
    const newPassword = changeForm.newPassword // 清空前捕获：服务端已撤销全部 refresh，须以新密码重登
    auth.clearSession()
    auth.mustChangePassword = false
    changeForm.oldPassword = ''
    changeForm.newPassword = ''
    changeForm.confirm = ''
    await auth.login(form.username, newPassword)
    await afterLogin()
  } catch (err) {
    errorMsg.value =
      err instanceof ApiError && err.message ? err.message : '修改密码失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login">
    <h1>{{ mode === 'login' ? '登录' : '修改密码' }}</h1>
    <template v-if="mode === 'login'">
      <!-- #419-2：原生 form submit——输入框内回车即提交（@submit.prevent）；按钮 @click 直调
           onSubmit 兼容 jsdom/测试（trigger('click') 不派发 submit 默认动作）。submitting 防重入
           保证真实浏览器中 click + submit 双触发只跑一次。 -->
      <el-form tag="form" @submit.prevent="onSubmit">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="用户名" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" placeholder="密码" />
        </el-form-item>
        <el-form-item v-if="errorMsg">
          <span class="error">{{ errorMsg }}</span>
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="submitting" :disabled="submitting" @click="onSubmit">登录</el-button>
        <p class="legal-links">
          登录即表示你已阅读并同意
          <router-link to="/legal/terms">用户服务协议</router-link>
          和
          <router-link to="/legal/privacy">隐私政策</router-link>
        </p>
      </el-form>
    </template>
    <!-- #340-A 强制改密（C1 首登改密）：旧密 + 新密 + 确认。改密成功即撤销全部会话，需重登 -->
    <template v-else>
      <p class="hint">首次登录须先修改密码（初始/临时密码不可继续使用）。</p>
      <el-form tag="form" @submit.prevent="onChangeSubmit">
        <el-form-item label="原密码">
          <el-input v-model="changeForm.oldPassword" type="password" placeholder="原密码" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input
            v-model="changeForm.newPassword"
            type="password"
            placeholder="至少 8 个字符"
          />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="changeForm.confirm" type="password" placeholder="再次输入新密码" />
        </el-form-item>
        <el-form-item v-if="errorMsg">
          <span class="error">{{ errorMsg }}</span>
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="submitting" :disabled="submitting" @click="onChangeSubmit">确认修改</el-button>
      </el-form>
    </template>
  </div>
</template>

<style scoped>
.error {
  color: var(--el-color-danger);
}
.hint {
  color: var(--el-color-warning);
  font-size: 13px;
  margin-bottom: 12px;
}
.legal-links {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
  margin: 14px 0 0;
}
.legal-links a {
  color: var(--el-color-primary);
  text-decoration: none;
}
.legal-links a:hover {
  text-decoration: underline;
}
</style>
