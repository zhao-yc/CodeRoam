<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import Icon from './Icon.vue'
import brandLogo from '../electron/tray.png'
import type { ConfigSnapshot, ConfigValues, LogEntry, ManagerContext, RuntimeStatus } from './types'

type Page = 'overview' | 'config' | 'logs' | 'about'
type ServiceSetting = 'backgroundSyncEnabled' | 'startupEnabled'
const api = window.desktopManager
const page = ref<Page>('overview')
const context = ref<ManagerContext | null>(null)
const status = ref<RuntimeStatus | null>(null)
const config = ref<ConfigSnapshot | null>(null)
const logs = ref<LogEntry[]>([])
const loading = ref(true), refreshing = ref(false), choosing = ref(false), saving = ref(false), restarting = ref(false), reloadingConfig = ref(false), configLoading = ref(false), logsLoading = ref(false)
const changingSetting = ref<ServiceSetting | null>(null), restartPreviousPid = ref<number | null>(null)
const changingService = ref<'start' | 'stop' | null>(null)
const error = ref(''), statusError = ref(''), configError = ref(''), feedback = ref(''), logError = ref(''), confirmRestart = ref(false), lastUpdated = ref<Date | null>(null)
const form = reactive({ label: '', relayUrl: '', multiInstance: true, cacheHours: 2, maxEntries: 64 })
let timer: ReturnType<typeof setInterval> | undefined
let alive = true, statusRequest = 0, generation = 0, initialForm = ''

const pages: { id: Page; title: string; icon: string; subtitle: string }[] = [
  { id: 'overview', title: '运行概览', icon: 'grid', subtitle: '查看电脑连接与后台运行状态' },
  { id: 'config', title: '配置管理', icon: 'sliders', subtitle: '调整连接方式与新聊天缓存策略' },
  { id: 'logs', title: '运行日志', icon: 'logs', subtitle: '查看服务的启动、退出和恢复记录' },
  { id: 'about', title: '关于与帮助', icon: 'info', subtitle: '了解管理客户端与后台服务的关系' },
]
const currentPage = computed(() => pages.find(item => item.id === page.value)!)
const ready = computed(() => Boolean(api && context.value?.configured))
const dirty = computed(() => config.value !== null && JSON.stringify(form) !== initialForm)
const availableInstances = computed(() => status.value?.instances.filter(item => item.ready).length ?? 0)
const serviceState = computed(() => status.value?.serviceState)
const statusLabel = computed(() => {
  if (!ready.value) return '尚未连接服务'
  if (changingService.value === 'start' || serviceState.value === 'starting') return '正在启动'
  if (changingService.value === 'stop' || serviceState.value === 'stopping') return '正在停止'
  if (serviceState.value === 'stopped') return '服务已停止'
  if (refreshing.value && !status.value) return '正在读取状态'
  if (!status.value?.running) return '服务未就绪'
  return status.value.connected ? '已连接中转' : '等待中转连接'
})
const statusTone = computed(() => status.value?.running && status.value.connected ? 'online' : 'waiting')
const latestLogs = computed(() => logs.value.slice(-5).reverse())
const logRows = computed(() => logs.value.slice().reverse())
const version = computed(() => context.value?.version || '—')
const operationBusy = computed(() => choosing.value || saving.value || restarting.value || reloadingConfig.value || configLoading.value || changingSetting.value !== null || changingService.value !== null)
const serviceControlBusy = computed(() => changingService.value !== null || serviceState.value === 'starting' || serviceState.value === 'stopping')
const serviceControlDisabled = computed(() => operationBusy.value || refreshing.value || confirmRestart.value || restartPreviousPid.value !== null || serviceControlBusy.value || !serviceState.value)
const serviceControlLabel = computed(() => {
  if (serviceControlBusy.value) return statusLabel.value
  if (!serviceState.value) return status.value ? '暂不支持启停' : '等待后台就绪'
  return serviceState.value === 'running' ? '停止服务' : '启动服务'
})
const serviceSettings: { key: ServiceSetting; descriptionId: string; title: string; description: string; offLabel: string }[] = [
  { key: 'backgroundSyncEnabled', descriptionId: 'background-sync-description', title: '后台数据同步', description: '暂停后仍可手动打开聊天、发送消息和处理审批。', offLabel: '已暂停' },
  { key: 'startupEnabled', descriptionId: 'startup-description', title: '开机启动', description: '', offLabel: '已关闭' },
]
const startupDescription = computed(() => {
  if (context.value?.platform === 'win32') return '开启后，守护随 Windows 启动，登录后启动桥接。关闭后改为手动启动，当前服务继续运行。切换时需确认 Windows 管理员授权。'
  return '开启后，守护在登录 macOS 时自动启动。关闭后，下次登录需手动启动，当前服务继续运行。'
})
const serviceSettingsLocked = computed(() => operationBusy.value || confirmRestart.value || restartPreviousPid.value !== null || serviceControlBusy.value)

function serviceSettingDisabled(key: ServiceSetting): boolean {
  return serviceSettingsLocked.value || typeof status.value?.[key] !== 'boolean'
}

function serviceSettingLabel(key: ServiceSetting, offLabel: string): string {
  if (changingSetting.value === key) return key === 'startupEnabled' && context.value?.platform === 'win32' ? '等待 Windows 确认…' : '正在应用…'
  if (restarting.value || restartPreviousPid.value !== null) return '等待后台重启'
  if (!status.value || key === 'backgroundSyncEnabled' && !status.value.running) return '等待后台就绪'
  const enabled = status.value[key]
  if (typeof enabled !== 'boolean') return key === 'startupEnabled' ? '当前服务暂不支持' : '当前服务版本暂不支持'
  return enabled ? '已开启' : offLabel
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : '操作未完成，请重试' }
function current(requestGeneration: number): boolean { return alive && requestGeneration === generation }
function shortRevision(value: string | undefined): string { return value ? value.slice(0, 12) : '—' }
function time(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}
function clock(value: Date | null): string { return value?.toLocaleTimeString('zh-CN', { hour12: false }) ?? '尚未更新' }

// 本机写操作使已经发出的状态读取失效，避免旧回执覆盖确认结果。
function invalidateStatus() {
  statusRequest++
  refreshing.value = false
}

// 只有显式载入或保存成功才回填表单，定时状态刷新始终保留尚未保存的输入。
function applyConfig(value: ConfigSnapshot) {
  config.value = value
  configError.value = ''
  Object.assign(form, { label: value.values.label, relayUrl: value.values.relayUrl, multiInstance: value.values.multiInstance, cacheHours: value.values.newConversationSettingsCache.ttlMs / 3_600_000, maxEntries: value.values.newConversationSettingsCache.maxEntries })
  initialForm = JSON.stringify(form)
}

// 首次读取失败后可在连接恢复时补齐；已有表单永远不被自动恢复读取覆盖。
async function loadMissingConfig(requestGeneration = generation) {
  if (!api || !current(requestGeneration) || config.value !== null || configLoading.value) return
  configLoading.value = true
  try {
    const value = await api.readConfig()
    if (current(requestGeneration) && config.value === null) applyConfig(value)
  } catch (reason) { if (current(requestGeneration)) configError.value = message(reason) }
  finally { if (current(requestGeneration)) configLoading.value = false }
}

// 每次选择服务都会推进代次，旧服务的异步回执不会污染新界面。
async function refreshStatus(showFeedback = false) {
  if (!api || !ready.value || refreshing.value || changingSetting.value !== null || changingService.value !== null || restarting.value) return
  refreshing.value = true
  const requestGeneration = generation
  const request = ++statusRequest
  try {
    const value = await api.status()
    if (!current(requestGeneration) || request !== statusRequest) return
    if (restartPreviousPid.value !== null && value.running && value.pid !== null && value.pid !== restartPreviousPid.value) restartPreviousPid.value = null
    status.value = value; lastUpdated.value = new Date(); statusError.value = ''
    if (showFeedback) feedback.value = '运行状态已更新'
    if (config.value === null && !operationBusy.value) await loadMissingConfig(requestGeneration)
  } catch (reason) {
    if (current(requestGeneration) && request === statusRequest) { statusError.value = message(reason); status.value = null }
  } finally { if (current(requestGeneration) && request === statusRequest) refreshing.value = false }
}

async function loadLogs() {
  if (!api || !ready.value || logsLoading.value) return
  logsLoading.value = true; logError.value = ''
  const requestGeneration = generation
  try {
    const result = await api.readLogs({ limit: 100 })
    if (current(requestGeneration)) logs.value = result.entries
  } catch (reason) { if (current(requestGeneration)) logError.value = message(reason) }
  finally { if (current(requestGeneration)) logsLoading.value = false }
}

async function loadService() {
  if (!api || !context.value?.configured) return
  const requestGeneration = generation
  await Promise.all([
    refreshStatus(),
    loadMissingConfig(requestGeneration),
    loadLogs(),
  ])
}

async function chooseWorker() {
  if (!api || loading.value || operationBusy.value) return
  let requestGeneration = generation
  choosing.value = true; error.value = ''; statusError.value = ''; configError.value = ''; feedback.value = ''
  try {
    const result = await api.chooseWorker()
    if (!current(requestGeneration)) return
    if (result.workerConfigPath === context.value?.workerConfigPath) return
    requestGeneration = ++generation
    invalidateStatus()
    context.value = result; status.value = null; restartPreviousPid.value = null; config.value = null; logs.value = []; initialForm = ''; configLoading.value = false; logsLoading.value = false; logError.value = ''
    await loadService()
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally { if (current(requestGeneration)) choosing.value = false }
}

// 开关保持守护上次确认的值，写入失败时由新的状态读取核对实际结果。
async function toggleServiceSetting(key: ServiceSetting) {
  const enabled = status.value?.[key]
  if (!api || serviceSettingDisabled(key) || typeof enabled !== 'boolean') return
  const requestGeneration = generation
  changingSetting.value = key
  error.value = ''
  invalidateStatus()
  let confirmed = false
  try {
    const input = { enabled: !enabled }
    const actual = key === 'startupEnabled'
      ? (await api.setStartup(input))?.startupEnabled
      : (await api.setBackgroundSync(input))?.backgroundSyncEnabled
    if (!current(requestGeneration)) return
    if (typeof actual !== 'boolean' || status.value === null) throw new Error('守护进程未确认开关状态')
    status.value = { ...status.value, [key]: actual }
    confirmed = true
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally {
    if (current(requestGeneration)) {
      changingSetting.value = null
      if (!confirmed) void refreshStatus()
    }
  }
}

// 界面仅提交允许调整的字段；令牌始终留在本机后台，不进入表单。
function values(): ConfigValues {
  const relayUrl = form.relayUrl.trim(), label = form.label.trim()
  if (!label) throw new Error('请填写电脑名称')
  if (label.length > 80) throw new Error('电脑名称最多 80 个字符')
  let url: URL
  try { url = new URL(relayUrl) } catch { throw new Error('请填写有效的中转地址') }
  if (url.username || url.password || url.search || url.hash) throw new Error('中转地址不能包含凭据、查询参数或片段')
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('跨网络中转地址需要使用 wss://')
  const ttlMs = Math.round(Number(form.cacheHours) * 3_600_000), maxEntries = Number(form.maxEntries)
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('请填写大于 0 的缓存时长')
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('缓存条目上限需要为正整数')
  return { label, relayUrl, multiInstance: form.multiInstance, newConversationSettingsCache: { ttlMs, maxEntries } }
}

async function save() {
  if (!api || !config.value || operationBusy.value || !dirty.value) return
  const requestGeneration = generation
  error.value = ''; feedback.value = ''; saving.value = true
  try {
    const result = await api.saveConfig({ expectedRevision: config.value.revision, values: values() })
    if (!current(requestGeneration)) return
    applyConfig(result)
    await refreshStatus()
    if (!current(requestGeneration)) return
    feedback.value = '配置已保存，重启后台服务后生效'
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally { if (current(requestGeneration)) saving.value = false }
}

async function reloadConfig() {
  if (!api || operationBusy.value) return
  const requestGeneration = generation
  reloadingConfig.value = true; error.value = ''
  try {
    const result = await api.readConfig()
    if (!current(requestGeneration)) return
    applyConfig(result); feedback.value = '已重新载入保存的配置'
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally { if (current(requestGeneration)) reloadingConfig.value = false }
}

// 主按钮等待守护回执，再重新读取真实进程状态。
async function toggleService() {
  if (!api || serviceControlDisabled.value) return
  const requestGeneration = generation
  const action = serviceState.value === 'running' ? 'stop' : 'start'
  changingService.value = action
  error.value = ''; feedback.value = ''
  invalidateStatus()
  try {
    if (action === 'stop') await api.stop()
    else await api.start()
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally {
    if (current(requestGeneration)) {
      changingService.value = null
      await refreshStatus()
    }
  }
}

// 重启由后台核验在途任务后执行；前端不停止进程，也不创建另一份桥接。
async function restart() {
  if (!api || operationBusy.value || restartPreviousPid.value !== null || !status.value?.running) return
  const requestGeneration = generation
  const previousPid = status.value.pid
  confirmRestart.value = false; restarting.value = true; error.value = ''; feedback.value = ''
  invalidateStatus()
  try {
    await api.restart()
    if (!current(requestGeneration)) return
    restartPreviousPid.value = previousPid
    status.value = null
    feedback.value = '后台已接受重启，请等待连接恢复'
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally {
    if (current(requestGeneration)) {
      restarting.value = false
      await refreshStatus()
      if (current(requestGeneration)) await loadLogs()
    }
  }
}

function selectPage(value: Page) { page.value = value; feedback.value = ''; if (value === 'logs') void loadLogs() }

onMounted(async () => {
  if (!api) { loading.value = false; return }
  const requestGeneration = generation
  try {
    const result = await api.getContext()
    if (!current(requestGeneration)) return
    context.value = result; await loadService()
  } catch (reason) { if (current(requestGeneration)) error.value = message(reason) }
  finally { if (current(requestGeneration)) loading.value = false }
  if (current(requestGeneration)) timer = setInterval(() => { void refreshStatus() }, 5000)
})
onUnmounted(() => { alive = false; generation++; if (timer) clearInterval(timer) })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><img class="brand-mark" :src="brandLogo" alt="" /><div><strong>CodeRoam</strong><span>电脑连接管理</span></div></div>
      <div class="sidebar-label">工作空间</div>
      <nav aria-label="管理导航"><button v-for="item in pages" :key="item.id" :class="['nav-item', { active: page === item.id }]" :aria-current="page === item.id ? 'page' : undefined" @click="selectPage(item.id)"><Icon :name="item.icon" :size="19" /><span>{{ item.title }}</span><span v-if="item.id === 'config' && status?.restartRequired" class="nav-dot"></span></button></nav>
      <div class="sidebar-bottom"><div class="service-indicator"><span :class="['status-dot', statusTone]"></span><div><strong>{{ statusLabel }}</strong><span>关闭窗口后驻留托盘</span></div></div><button class="switch-service" :disabled="!api || loading || operationBusy" @click="chooseWorker"><Icon name="folder" :size="16" /><span>{{ choosing ? '正在选择…' : '选择服务配置' }}</span><Icon name="chevron" :size="14" /></button><span class="sidebar-version">管理客户端 {{ version }}</span></div>
    </aside>

    <main class="main-pane">
      <header class="page-header"><div><div class="page-eyebrow">电脑连接管理</div><h1>{{ currentPage.title }}</h1><p>{{ currentPage.subtitle }}</p></div><div v-if="ready" class="header-actions"><button class="button secondary icon-button" :disabled="refreshing || restarting || changingSetting !== null" aria-label="刷新运行状态" title="刷新运行状态" @click="refreshStatus(true)"><Icon name="refresh" :class="{ spinning: refreshing }" :size="18" /></button><button class="button secondary" :disabled="!status?.running || operationBusy || restartPreviousPid !== null" @click="confirmRestart = true"><Icon name="power" :size="17" />{{ restarting || restartPreviousPid !== null ? '正在重启…' : '重启服务' }}</button></div></header>

      <div v-if="error" class="notice error" role="alert"><Icon name="alert" :size="18" /><span>{{ error }}</span><button class="notice-close" aria-label="关闭错误提示" @click="error = ''"><Icon name="close" :size="16" /></button></div>
      <div v-if="statusError" class="notice error" role="alert"><Icon name="signal" :size="18" /><span>运行状态：{{ statusError }}</span><button class="notice-close" aria-label="关闭状态提示" @click="statusError = ''"><Icon name="close" :size="16" /></button></div>
      <div v-if="configError" class="notice error" role="alert"><Icon name="sliders" :size="18" /><span>配置读取：{{ configError }}</span><button class="notice-close" aria-label="关闭配置提示" @click="configError = ''"><Icon name="close" :size="16" /></button></div>
      <div v-if="feedback" class="notice success" role="status"><Icon name="check" :size="18" /><span>{{ feedback }}</span><button class="notice-close" aria-label="关闭提示" @click="feedback = ''"><Icon name="close" :size="16" /></button></div>

      <section v-if="loading" class="empty-state panel"><div class="loading-ring"></div><h2>正在读取本机服务</h2><p>确认运行状态与当前配置…</p></section>
      <section v-else-if="!api" class="empty-state panel"><div class="empty-icon"><Icon name="monitor" :size="32" /></div><h2>请从桌面客户端打开</h2><p>当前页面没有连接 Electron 的本机管理接口。<br />请运行电脑连接管理客户端，再查看和编辑后台配置。</p><div class="muted-note">浏览器预览不会显示模拟状态，也不能修改本机服务。</div></section>
      <section v-else-if="!ready" class="empty-state panel"><div class="empty-icon"><Icon name="folder" :size="32" /></div><h2>连接现有的后台服务</h2><p>选择守护服务使用的 <code>worker.json</code>，<br />即可查看运行状态、调整配置和读取日志。</p><button class="button primary" :disabled="loading || operationBusy" @click="chooseWorker"><Icon name="folder" :size="18" />{{ choosing ? '正在选择…' : '选择服务配置' }}<Icon name="arrow" :size="16" /></button><div class="muted-note">管理客户端连接已有守护，不会重复启动桥接进程。</div></section>

      <template v-else-if="page === 'overview'">
        <section class="stat-grid overview-stats" aria-label="运行摘要">
          <article class="stat-card connection-card">
            <div class="connection-summary">
              <div class="stat-caption"><span>中转连接</span><Icon name="signal" :size="18" /></div>
              <strong class="stat-value compact" :class="{ 'text-online': status?.connected && !serviceControlBusy }" role="status">{{ statusLabel }}</strong>
              <span class="stat-note"><span :class="['status-dot', statusTone]"></span>{{ serviceState === 'stopped' ? '可随时重新启动' : status?.running ? '后台服务正在运行' : '等待后台服务就绪' }}</span>
            </div>
            <div class="connection-control">
              <button class="service-power" :disabled="serviceControlDisabled" :aria-label="serviceControlLabel" :title="serviceControlLabel" @click="toggleService">
                <span v-if="serviceControlBusy" class="button-spinner"></span>
                <Icon v-else :name="serviceState === 'running' ? 'pause' : 'play'" :size="30" />
              </button>
              <span>{{ serviceControlLabel }}</span>
            </div>
          </article>
          <article class="stat-card"><div class="stat-caption"><span>可用桌面实例</span><Icon name="monitor" :size="19" /></div><strong class="stat-value">{{ status ? availableInstances : '—' }}<small v-if="status">个</small></strong><span class="stat-note">已检测 {{ status?.instances.length ?? 0 }} 个实例</span></article>
          <article class="stat-card"><div class="stat-caption"><span>配置状态</span><Icon name="sliders" :size="18" /></div><strong class="stat-value compact" :class="{ 'text-waiting': status?.restartRequired }">{{ !status ? '待核验' : status.restartRequired ? '等待应用' : '已同步' }}</strong><span class="stat-note">{{ status?.restartRequired ? '保存的更改需要重启服务' : '按当前生效配置运行' }}</span></article>
        </section>
        <section class="panel">
          <div class="panel-heading">
            <div><h2>后台服务</h2><p>关闭窗口后连接继续，退出托盘时停止服务。</p></div>
            <span :class="['status-pill', statusTone]"><span :class="['status-dot', statusTone]"></span>{{ statusLabel }}</span>
          </div>
          <dl class="detail-list">
            <div><dt>电脑名称</dt><dd>{{ config?.values.label || '—' }}</dd></div>
            <div><dt>运行进程</dt><dd>{{ status?.pid ? 'PID ' + status.pid : '—' }}<span v-if="status?.supervisorPid" class="sub-value">守护 PID {{ status.supervisorPid }}</span></dd></div>
            <div><dt>配置文件</dt><dd class="path-value" :title="status?.configPath">{{ status?.configPath || '—' }}</dd></div>
            <div><dt>生效版本</dt><dd class="mono">{{ shortRevision(status?.activeRevision) }}<span v-if="status?.restartRequired" class="sub-value">已保存 {{ shortRevision(status.savedRevision) }}</span></dd></div>
          </dl>
          <div v-for="setting in serviceSettings" :key="setting.key" class="setting-row service-setting">
            <div>
              <strong>{{ setting.title }}</strong>
              <p :id="setting.descriptionId">{{ setting.key === 'startupEnabled' ? startupDescription : setting.description }}</p>
            </div>
            <div class="service-setting-control">
              <span role="status">{{ serviceSettingLabel(setting.key, setting.offLabel) }}</span>
              <label class="toggle">
                <input type="checkbox" role="switch" :aria-label="setting.title" :aria-describedby="setting.descriptionId"
                  :checked="status?.[setting.key] === true" :disabled="serviceSettingDisabled(setting.key)" @click.prevent="toggleServiceSetting(setting.key)" />
                <span></span>
              </label>
            </div>
          </div>
          <div v-if="status?.restartRequired" class="panel-callout">
            <Icon name="clock" :size="18" />
            <span>新配置已保存，后台仍使用上一版配置。</span>
            <button class="text-button" :disabled="!status?.running || operationBusy || restartPreviousPid !== null" @click="confirmRestart = true">重启并应用<Icon name="arrow" :size="15" /></button>
          </div>
        </section>
        <section class="panel"><div class="panel-heading"><div><h2>桌面实例</h2><p>服务会自动发现并连接本机的 Codex 桌面。</p></div><span class="count-label">{{ status?.instances.length ?? 0 }} 个实例</span></div><div v-if="!status?.instances.length" class="inline-empty"><Icon name="monitor" :size="25" /><span>{{ status?.running ? '尚未检测到桌面实例，请确认 Codex 已打开。' : '服务恢复后将显示检测到的桌面实例。' }}</span></div><div v-for="(instance, index) in status?.instances ?? []" :key="index" class="instance-row"><div class="instance-icon"><Icon name="monitor" :size="21" /></div><div class="instance-copy"><strong>{{ instance.label || 'Codex 桌面实例' }}</strong><span>{{ instance.ready ? '已核验，可接受手机操作' : '正在等待实例就绪' }}</span></div><span :class="['status-pill', instance.ready ? 'online' : 'waiting']">{{ instance.ready ? '就绪' : '等待连接' }}</span></div></section>
        <section class="panel"><div class="panel-heading"><div><h2>最近运行记录</h2><p>只显示后台生命周期记录。</p></div><button class="text-button" @click="selectPage('logs')">全部日志<Icon name="arrow" :size="15" /></button></div><div v-if="!latestLogs.length" class="inline-empty">{{ logsLoading ? '正在读取记录…' : logError || '暂无运行记录' }}</div><div v-for="(entry, index) in latestLogs" :key="index" class="recent-log"><span class="timeline-dot"></span><span>{{ entry.message }}</span><time>{{ time(entry.time) }}</time></div></section>
      </template>

      <template v-else-if="page === 'config'">
        <div v-if="!config" class="panel empty-state compact-empty"><h2>暂时无法读取配置</h2><p>请确认所选守护版本支持本机管理接口。</p><button class="button secondary" :disabled="operationBusy" @click="reloadConfig">{{ reloadingConfig ? '正在读取…' : '重新读取' }}</button></div>
        <form v-else @submit.prevent="save">
          <section class="panel"><div class="panel-heading"><div><h2>连接设置</h2><p>修改后保存，再重启后台以应用配置。</p></div><span class="section-icon"><Icon name="signal" :size="19" /></span></div><div class="form-body"><label class="field"><span>电脑名称</span><input v-model="form.label" :disabled="operationBusy" maxlength="80" autocomplete="off" placeholder="输入便于识别的电脑名称" /><small>显示在手机的电脑列表中。</small></label><label class="field"><span>中转地址</span><input v-model="form.relayUrl" :disabled="operationBusy" class="mono" autocomplete="off" spellcheck="false" placeholder="wss://relay.example.com" /><small>使用 WSS 地址连接中转，地址中不包含令牌。</small></label><div class="setting-row"><div><strong>自动发现多个桌面实例</strong><p>为本机打开的不同 Codex 实例分别建立连接。</p></div><label class="toggle"><input v-model="form.multiInstance" type="checkbox" :disabled="operationBusy" aria-label="自动发现多个桌面实例" /><span></span></label></div><div class="credential-note"><Icon name="shield" :size="18" /><div><strong>{{ config.tokenConfigured ? '连接令牌已配置' : '连接令牌尚未配置' }}</strong><span>令牌由后台保管，此页面不读取或展示令牌内容。</span></div></div></div></section>
          <section class="panel"><div class="panel-heading"><div><h2>新聊天设置缓存</h2><p>复用电脑默认设置，减少重复启动配置读取进程。</p></div><span class="section-icon"><Icon name="clock" :size="19" /></span></div><div class="form-body"><div class="field-grid"><label class="field"><span>缓存有效期</span><div class="input-unit"><input v-model.number="form.cacheHours" type="number" :disabled="operationBusy" min="0.001" step="0.25" required /><span>小时</span></div><small>默认 2 小时，配置文件变化时提前失效。</small></label><label class="field"><span>最多缓存项目数</span><div class="input-unit"><input v-model.number="form.maxEntries" type="number" :disabled="operationBusy" min="1" step="1" required /><span>个</span></div><small>达到上限后，优先移除近期未使用的条目。</small></label></div><div class="muted-note subtle">缓存保存在实例内存中，服务重启后重新读取。权限与发送前核对仍按实时流程执行。</div></div></section>
          <div class="save-bar"><span :class="{ 'text-primary': dirty }"><span v-if="dirty" class="edit-dot"></span>{{ dirty ? '有尚未保存的更改' : status?.restartRequired ? '配置已保存，等待重启生效' : '所有更改已保存' }}</span><div><button class="button secondary" type="button" :disabled="!dirty || operationBusy" @click="reloadConfig">还原更改</button><button class="button primary" type="submit" :disabled="!dirty || operationBusy"><Icon v-if="!saving" name="check" :size="17" /><span v-else class="button-spinner"></span>{{ saving ? '正在保存…' : '保存配置' }}</button></div></div>
        </form>
      </template>

      <template v-else-if="page === 'logs'">
        <section class="panel logs-panel"><div class="panel-heading"><div><h2>服务生命周期</h2><p>最近 100 条记录，时间使用本机时区。</p></div><button class="button secondary small" :disabled="logsLoading" @click="loadLogs"><Icon name="refresh" :size="16" :class="{ spinning: logsLoading }" />{{ logsLoading ? '正在读取…' : '刷新日志' }}</button></div><div v-if="logError" class="log-error" role="alert">{{ logError }}</div><div v-if="!logs.length" class="inline-empty log-empty"><Icon name="logs" :size="29" /><span>{{ logsLoading ? '正在读取运行记录…' : '暂无可展示的运行记录' }}</span></div><div v-else class="log-table"><div class="log-table-heading"><span>时间</span><span>级别</span><span>运行事件</span></div><div v-for="(entry, index) in logRows" :key="index" class="log-table-row"><time>{{ time(entry.time) }}</time><span :class="['log-level', entry.level === 'error' ? 'error-level' : entry.level === 'warn' ? 'warn-level' : 'info-level']">{{ entry.level === 'error' ? '错误' : entry.level === 'warn' ? '警告' : '信息' }}</span><span>{{ entry.message }}</span></div></div><div class="logs-footnote"><Icon name="shield" :size="15" />仅展示经过筛选的服务事件，不包含配对令牌或聊天正文。</div></section>
      </template>

      <template v-else>
        <section class="panel about-card"><img class="brand-mark large" :src="brandLogo" alt="" /><h2>CodeRoam · 电脑连接管理</h2><p>让本机后台的状态与配置清晰可见。</p><span class="version-tag">管理客户端 {{ version }}</span></section>
        <section class="panel"><div class="panel-heading"><div><h2>托盘驻留，按需管理</h2><p>管理客户端与后台守护各自负责不同的工作。</p></div></div><div class="help-list"><article><div class="help-icon"><Icon name="monitor" :size="21" /></div><div><h3>窗口关闭，连接继续</h3><p>关闭窗口后可从托盘重新打开。退出托盘时，守护和桥接会一起停止。</p></div></article><article><div class="help-icon"><Icon name="sliders" :size="21" /></div><div><h3>保存配置，明确生效</h3><p>保存前检查配置格式与版本。修改后可在概览查看是否需要重启服务。</p></div></article><article><div class="help-icon"><Icon name="shield" :size="21" /></div><div><h3>有在途操作时保留现场</h3><p>重启前由后台检查手机操作。仍有任务处理时会拒绝重启，请等待结束后重试。</p></div></article></div></section>
        <section class="panel"><div class="panel-heading"><div><h2>当前管理目标</h2><p>管理客户端通过本机通道连接已有服务。</p></div><button class="text-button" :disabled="loading || operationBusy" @click="chooseWorker">更换配置<Icon name="arrow" :size="15" /></button></div><dl class="detail-list"><div><dt>托管配置</dt><dd class="path-value" :title="context?.workerConfigPath">{{ context?.workerConfigPath || '尚未选择' }}</dd></div><div><dt>后台版本</dt><dd>{{ status?.version || '暂不可获取' }}</dd></div><div><dt>运行平台</dt><dd>{{ context?.platform === 'win32' ? 'Windows' : context?.platform === 'darwin' ? 'macOS' : context?.platform || '—' }}</dd></div></dl></section>
      </template>

      <footer v-if="ready && !loading" class="page-footer"><span><span :class="['status-dot', statusTone]"></span>本机管理通道</span><span>上次同步 {{ clock(lastUpdated) }}</span></footer>
    </main>

    <div v-if="confirmRestart" class="modal-backdrop" @click.self="confirmRestart = false"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="restart-title" @keydown.esc="confirmRestart = false"><div class="modal-icon"><Icon name="power" :size="25" /></div><h2 id="restart-title">重启后台服务？</h2><p>手机连接会短暂中断，随后由守护自动恢复。后台会先核对在途操作，确认可以安全重启后才执行。</p><div v-if="dirty" class="modal-note">配置页仍有未保存的更改，本次重启只应用已保存的配置。</div><div class="modal-actions"><button class="button secondary" autofocus @click="confirmRestart = false">取消</button><button class="button primary" @click="restart">重启服务</button></div></section></div>
  </div>
</template>

<style scoped>
.overview-stats {
  grid-template-columns: minmax(0, 1.7fr) repeat(2, minmax(0, 1fr));
}

.connection-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  overflow: hidden;
}

.connection-summary .stat-caption {
  justify-content: flex-start;
  gap: 7px;
}

.connection-control {
  min-width: 86px;
  display: grid;
  justify-items: center;
  gap: 8px;
  color: var(--primary);
  font-size: 11px;
  white-space: nowrap;
}

.service-power {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 25px;
  background: var(--primary);
  color: white;
  box-shadow: 0 0 0 7px #ececfa, 0 6px 14px #4546bd35;
  transition: transform .15s, box-shadow .15s;
}

.service-power:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 0 0 7px #e7e7fc, 0 8px 16px #4546bd45;
}

.service-power:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 9px;
}

.service-power .button-spinner {
  width: 23px;
  height: 23px;
}

.service-setting {
  margin: 0 23px 19px;
  padding-top: 15px;
}

.service-setting-control {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
</style>
