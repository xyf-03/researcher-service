// 五位分层码表（#312 最终准据 + #319 转译码 + #333 执行期新增 10005）。
// 单一来源：所有信封码在此定义，路由/中间件引用常量名而非裸数字。
//
// 段：0 成功 · 1xxxx 通用/鉴权/账号 · 2xxxx 容器 · 3xxxx wiki · 4xxxx models ·
//     6xxxx files · 7xxxx figures · 9xxxx 系统/校验。完整表见 docs/research/319-api-contract.md §1。

export const CODE = {
  OK: 0,
  // 1xxxx 通用 / 鉴权
  UNAUTHENTICATED: 10001, // 无/坏 access token（转译 401）
  LOGIN_FAILED: 10002, // 用户名/密码错（转译 401）
  REFRESH_INVALID: 10003, // refresh 缺失/无效/已撤销/重放
  FORBIDDEN: 10004, // 角色不足（user 调 admin-only / 跨用户，转译 403）
  MUST_CHANGE_PASSWORD: 10005, // #333 新增：mustChangePassword 拦截（规格未定义码，执行期微调）
  // 1xxxx 账号管理（#328）
  USER_NOT_FOUND: 10041, // 用户不存在 / 越权（同码防探测）
  USERNAME_INVALID: 10042, // 用户名格式非法
  QUOTA_INVALID: 10043, // 配额非法
  CANNOT_DISABLE_SELF: 10044, // 不可禁用自己
  // 3xxxx wiki（#335 平移 wiki 域；#319 §1.3 转译码）
  WIKI_PAGE_NOT_FOUND: 30040, // 页不存在 / 越权（同码防探测）
  WIKI_PAGE_EXISTS: 30041, // 新建页已存在（POST 409 转译）
  // 4xxxx models（#336 平移 models 域；#319 §1.3 转译码）
  PROVIDER_NOT_FOUND: 40040, // provider 不存在 / 越权（同码防探测）
  PROVIDER_ID_CONFLICT: 40041, // 同容器 provider_id 冲突（POST/PUT，unique 约束）
  // 6xxxx files（#589 统一文件 CRUD；6xxxx 段为 319 §1.1 未分配段，按「40 不存在 / 41 冲突」锁式）
  FILE_NOT_FOUND: 60040, // 文件不存在（GET/PUT/DELETE）
  FILE_EXISTS: 60041, // 新建文件已存在（POST 冲突）
  // 7xxxx figures（AutoFigure，docs/autofigure/tickets/）：
  // T05 读路径（T05-figure-history-ownership.md）：70040 = 不存在/越权同码防探测（镜像各域
  // 20040/30040/40040/60040 的 getInstanceForUser 锁式）。T02 幂等冲突 70041（对齐「41 冲突」锁）。
  // T06 PNG 下载（T06-artifact-persistence-png.md · spec §3「未完成/失败给明确应用级响应，不返回
  // 模糊 500」）：70042/70043 为 70040/70041 之后的域专用续号（对齐 20042 quota/20043 busy 的
  // 「40 不存在 / 41 冲突 / 42+ 域专用」锁式；确切码值经 spec §4 / grilling §9 委托实现定准）。
  FIGURE_NOT_FOUND: 70040, // Figure 不存在 / 越权（同码防探测，T05）
  IDEMPOTENCY_CONFLICT: 70041, // 同用户 + 同 key + 不同输入 → 稳定幂等冲突（不建任何行）
  FIGURE_PNG_NOT_READY: 70042, // PNG 未就绪（queued/running 未完成，明确应用级「未就绪」响应）
  FIGURE_PNG_NOT_AVAILABLE: 70043, // PNG 不可用（failed / succeeded 但产物缺失，明确应用级「不可用」响应）
  // 2xxxx 容器（20041 锁 = name 全局唯一冲突；register/users 用户名冲突复用，契约 §2.2）
  CONTAINER_NOT_FOUND: 20040, // 容器不存在 / 越权（同码防探测，#312 锁）
  NAME_CONFLICT: 20041,
  QUOTA_EXCEEDED: 20042, // 配额超限（User.maxContainers，#312/#311 锁）
  CONTAINER_BUSY: 20043, // 目标在 provisioning（delete 改取消标志后仅作在飞冲突备用，#313）
  ORPHAN_DIR: 20044, // create 撞残留 orphan 目录（转译）
  CLEANUP_FAILED: 20045, // home 清理失败（delete 行标 REMOVING 可重试，转译）
  CONTAINER_NOT_RUNNING: 20046, // #13：容器非 running（creating/stopped/removing）——bootstrap-token 前置
  // 9xxxx 系统 / 校验
  OAUTH_NOT_CONFIGURED: 90001, // OAuth provider 未配置（原 501）
  VALIDATION_FAILED: 90002, // 参数校验失败（字段明细进 data）；Idempotency-Key 缺/超长特例 data=null（figures 前置中间件）
  LLM_NOT_CONFIGURED: 90003, // LLM key 未配置 / 写盘失败（create 前置，转译）
  PORT_POOL_EXHAUSTED: 90004, // 端口池耗尽 / 持续分配冲突（转译，复用系统域）
  ROUTE_NOT_FOUND: 90005, // 路由不存在（404 信封兜底）
  INTERNAL: 90000, // 未知错误兜底
} as const

export type EnvelopeCode = (typeof CODE)[keyof typeof CODE]

// 默认人类可读总述；抛 EnvelopeError 时可不传 message 走默认。
export const DEFAULT_MESSAGE: Record<number, string> = {
  [CODE.OK]: 'ok',
  [CODE.UNAUTHENTICATED]: '未登录或登录已过期',
  [CODE.LOGIN_FAILED]: '用户名或密码错误',
  [CODE.REFRESH_INVALID]: '刷新凭证无效',
  [CODE.FORBIDDEN]: '权限不足',
  [CODE.MUST_CHANGE_PASSWORD]: '需要先修改密码',
  [CODE.USER_NOT_FOUND]: '用户不存在',
  [CODE.USERNAME_INVALID]: '用户名不合法',
  [CODE.QUOTA_INVALID]: '配额不合法',
  [CODE.CANNOT_DISABLE_SELF]: '不能禁用自己的账号',
  [CODE.CONTAINER_NOT_FOUND]: '容器不存在',
  [CODE.NAME_CONFLICT]: '名称已被占用',
  [CODE.QUOTA_EXCEEDED]: '容器数量已达配额上限',
  [CODE.CONTAINER_BUSY]: '容器正在创建中，请稍候再删除',
  [CODE.ORPHAN_DIR]: '该名称存在残留数据目录，请删除同名实例或手动清理后重试',
  [CODE.CLEANUP_FAILED]: '容器已停删，但数据目录清理失败（权限/属主），请重试',
  [CODE.CONTAINER_NOT_RUNNING]: '容器未运行，请启动后再对话',
  [CODE.OAUTH_NOT_CONFIGURED]: 'OAuth provider 未配置',
  [CODE.WIKI_PAGE_NOT_FOUND]: '页面不存在',
  [CODE.WIKI_PAGE_EXISTS]: '页面已存在',
  [CODE.PROVIDER_NOT_FOUND]: 'model provider 不存在',
  [CODE.PROVIDER_ID_CONFLICT]: '该容器下 provider_id 已存在',
  [CODE.FILE_NOT_FOUND]: '文件不存在',
  [CODE.FILE_EXISTS]: '文件已存在',
  [CODE.FIGURE_NOT_FOUND]: 'Figure 不存在',
  [CODE.IDEMPOTENCY_CONFLICT]: '幂等键已用于不同输入，请勿复用同一 Idempotency-Key 提交不同创建载荷',
  [CODE.FIGURE_PNG_NOT_READY]: 'Figure 尚未生成完成，请稍后再试',
  [CODE.FIGURE_PNG_NOT_AVAILABLE]: 'Figure 无可用 PNG（生成失败或产物缺失）',
  [CODE.VALIDATION_FAILED]: '参数校验失败',
  [CODE.LLM_NOT_CONFIGURED]: 'LLM_API_KEY 未配置',
  [CODE.PORT_POOL_EXHAUSTED]: '端口池已耗尽，暂无法创建容器，请稍后重试或删除闲置容器',
  [CODE.ROUTE_NOT_FOUND]: '路由不存在',
  [CODE.INTERNAL]: '服务器内部错误',
}

export function defaultMessage(code: number): string {
  return DEFAULT_MESSAGE[code] ?? '错误'
}
