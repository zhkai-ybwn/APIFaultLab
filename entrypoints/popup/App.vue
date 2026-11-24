<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PanelCommand } from '../../lib/model'
import { usePanelConnection } from '../../lib/use-panel-connection'

const { snapshot, connected, connectionError, send, retry } = usePanelConnection(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) throw new Error('找不到当前标签页。请回到测试页面后重试。')
  return tab.id
})

const action = ref<'capture' | 'stop' | 'reconnect' | null>(null)
const commandError = ref('')
const target = computed(() => snapshot.value?.target)
const status = computed(() => snapshot.value?.status ?? 'loading')
const observing = computed(() => snapshot.value?.observing ?? false)
const activeCount = computed(() => snapshot.value?.activeCount ?? 0)
const configuredCount = computed(() => snapshot.value?.configuredCount ?? 0)

const site = computed(() => {
  const url = snapshot.value?.siteOrigin || snapshot.value?.pageUrl
  if (!url) return '当前标签页'
  try {
    return new URL(url).host || '当前标签页'
  } catch {
    return '当前标签页'
  }
})

const displayStatus = computed(() => {
  if (!connected.value) return snapshot.value || connectionError.value ? '正在重新连接' : '正在连接'
  switch (status.value) {
    case 'active': return '模拟中'
    case 'observing': return observing.value ? '采集中' : '采集已暂停'
    case 'restoring': return '等待确认规则'
    case 'applying': return '正在启用规则'
    case 'stopping': return '正在停止'
    case 'uncertain': return '状态待确认'
    case 'unavailable': return '尚未接入'
    default: return '正在接入页面'
  }
})

const ruleSummary = computed(() => {
  if (status.value === 'restoring') return `${configuredCount.value} 条等待恢复`
  if (status.value === 'uncertain') return '待确认'
  if (!connected.value) return '等待读取'
  if (status.value === 'unavailable' && configuredCount.value) return `${configuredCount.value} 条已保留`
  if (snapshot.value?.recoveryState === 'awaiting-real') {
    return snapshot.value.recoveryScope === 'route' ? '本页已停止，等待真实请求' : '已停止，等待页面请求'
  }
  if (snapshot.value?.recoveryState === 'real-confirmed') return '已收到真实响应'
  return `${activeCount.value} 条生效`
})

const showStop = computed(() => activeCount.value > 0 || configuredCount.value > 0 || status.value === 'uncertain' || snapshot.value?.startupState === 'blocked')
const captureEnabled = computed(() => connected.value && Boolean(target.value) && !action.value &&
  (status.value === 'active' || status.value === 'observing'))

const feedback = computed(() => commandError.value || connectionError.value ||
  (snapshot.value?.startupState === 'blocked' ? '首屏请求已阻止。停止标签页规则后可以重试。' : '') ||
  (status.value === 'restoring' ? '正在核对当前页面的规则。' : '') ||
  (['unavailable', 'uncertain'].includes(status.value) ? snapshot.value?.message ?? '' : ''))
const feedbackError = computed(() => Boolean(commandError.value || connectionError.value))

async function run(command: PanelCommand, name: NonNullable<typeof action.value>) {
  if (action.value) return
  commandError.value = ''
  action.value = name
  try {
    await send(command)
  } catch (error) {
    commandError.value = error instanceof Error ? error.message : '操作未完成，请重试。'
  } finally {
    action.value = null
  }
}

function toggleCapture() {
  if (target.value && captureEnabled.value) {
    void run({ type: 'set-observing', target: target.value, enabled: !observing.value }, 'capture')
  }
}

function stop() {
  if (target.value) void run({ type: 'stop', target: target.value }, 'stop')
}

function reconnect() {
  commandError.value = ''
  if (connected.value && target.value) void run({ type: 'reconnect', target: target.value }, 'reconnect')
  else retry()
}
</script>

<template>
  <main class="popup" aria-labelledby="popup-title">
    <header class="popup-heading">
      <span class="product-mark" aria-hidden="true"><i></i></span>
      <div class="popup-identity">
        <h1 id="popup-title">APIFaultLab</h1>
        <p class="site" :title="site">{{ site }}</p>
      </div>
      <p class="connection" :data-status="status" role="status">{{ displayStatus }}</p>
    </header>

    <section class="settings" aria-label="当前标签页">
      <div class="setting capture-setting">
        <div class="setting-copy">
          <p class="setting-name" id="capture-label">请求采集</p>
          <p class="setting-description" id="capture-description">
            {{ action === 'capture' ? '正在更新采集状态' : '记录当前标签页的接口调用' }}
          </p>
        </div>
        <button class="capture-switch" type="button" role="switch" :aria-checked="observing"
          aria-labelledby="capture-label" aria-describedby="capture-description"
          :disabled="!captureEnabled" @click="toggleCapture">
          <span class="switch-track" aria-hidden="true"><span></span></span>
        </button>
      </div>

      <div class="setting simulation-setting">
        <div class="setting-copy">
          <p class="setting-name">模拟规则</p>
          <p class="setting-description rule-summary">{{ ruleSummary }}</p>
        </div>
        <button v-if="showStop" class="quiet-action stop-action" type="button"
          :disabled="!connected || !target || Boolean(action) || status === 'stopping'" @click="stop">
          {{ action === 'stop' || status === 'stopping' ? '正在停止' : '停止标签页规则' }}
        </button>
      </div>
    </section>

    <div v-if="feedback" class="feedback" :class="{ 'feedback-error': feedbackError }">
      <p :role="feedbackError ? 'alert' : 'status'">{{ feedback }}</p>
      <button v-if="connectionError || (target && (status === 'unavailable' || status === 'uncertain'))" class="quiet-action retry-action"
        type="button" :disabled="Boolean(action)" @click="reconnect">重试连接</button>
    </div>
    <div v-if="snapshot?.sessionWarning && snapshot.sessionWarning !== feedback" class="feedback feedback-warning">
      <p role="status">{{ snapshot.sessionWarning }}</p>
    </div>

    <footer class="devtools-hint">
      <div>
        <p class="setting-name">开发者工具</p>
        <p class="setting-description">打开后选择 <strong>APIFaultLab</strong> 标签页</p>
      </div>
      <kbd>F12</kbd>
    </footer>
  </main>
</template>

<style>
body {
  width: 352px;
  margin: 0;
  font: .8125rem/1.4 var(--font-ui);
  color: var(--text);
  background: var(--surface);
}

*, *::before, *::after { box-sizing: border-box; }
:where(.popup p, .popup h1) { margin: 0; }
.popup { font-optical-sizing: auto; }

.popup-heading {
  display: grid;
  grid-template-columns: 33px minmax(0, 1fr) max-content;
  align-items: center;
  gap: 11px;
  min-height: 75px;
  padding: 16px 19px;
  background: var(--surface);
}

.product-mark {
  display: grid;
  position: relative;
  place-items: center;
  width: 33px;
  height: 33px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--accent);
  background: var(--surface-recessed);
}

.product-mark::before, .product-mark::after {
  position: absolute;
  width: 6px;
  height: 11px;
  border: 1.4px solid currentColor;
  content: '';
}

.product-mark::before {
  inset-inline-start: 7px;
  border-inline-end: 0;
  border-radius: 2px 0 0 2px;
}

.product-mark::after {
  inset-inline-end: 7px;
  border-inline-start: 0;
  border-radius: 0 2px 2px 0;
}

.product-mark i {
  width: 1.5px;
  height: 13px;
  border-radius: 1px;
  background: currentColor;
  transform: rotate(22deg);
}

.popup-identity { min-width: 0; }
.popup h1 { font-size: 19px; font-weight: 690; line-height: 1.16; letter-spacing: -.035em; }
.site {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.42;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.connection {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 10.5px;
  font-weight: 580;
  line-height: 1.45;
}

.connection::before {
  width: 5px;
  height: 5px;
  flex: 0 0 5px;
  border-radius: 50%;
  background: currentColor;
  content: '';
}

.connection[data-status='active'] { color: var(--accent); }
.connection[data-status='restoring'], .connection[data-status='uncertain'] { color: var(--warning); }

.settings {
  padding: 0 19px;
  border-block: 1px solid var(--line);
  background: var(--surface-raised);
}

.setting, .devtools-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.setting { min-height: 63px; padding: 10px 0; }
.setting + .setting { border-top: 1px solid var(--line); }
.setting-copy { min-width: 0; }
.setting-name { font-size: 13px; font-weight: 635; line-height: 1.35; }
.setting-description {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}
.rule-summary { font-variant-numeric: tabular-nums; }

.capture-switch, .quiet-action {
  flex-shrink: 0;
  border: 0;
  font: inherit;
  cursor: pointer;
}

.capture-switch {
  display: grid;
  place-items: center;
  min-width: 44px;
  min-height: 38px;
  padding: 0;
  border-radius: 10px;
  background: transparent;
}

.switch-track {
  display: flex;
  align-items: center;
  width: 36px;
  height: 21px;
  padding-inline: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 74%, var(--surface-recessed));
  transition: background-color var(--motion-fast) ease-out;
}

.switch-track > span {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 22%);
  transition: transform var(--motion-ui) var(--motion-ease);
}

.capture-switch[aria-checked='true'] .switch-track { background: var(--accent-fill); }
.capture-switch[aria-checked='true'] .switch-track > span { background: var(--on-accent); transform: translateX(15px); }
.capture-switch:active:not(:disabled) .switch-track { transform: scale(.94); }
.capture-switch:hover:not(:disabled) .switch-track { filter: brightness(.97); }

.quiet-action {
  min-height: 32px;
  padding: 5px 8px;
  border-radius: 6px;
  background: transparent;
  font-size: 11px;
  font-weight: 620;
}

.stop-action { margin-inline-end: -4px; color: var(--danger); }
.stop-action:hover:not(:disabled) { background: var(--danger-soft); }
.retry-action { color: var(--accent); }
.retry-action:hover:not(:disabled) { background: var(--accent-soft); }
.quiet-action:active:not(:disabled) { transform: scale(.97); }
.popup button:disabled { opacity: .55; cursor: default; }
.popup button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 10px 19px;
  border-bottom: 1px solid var(--line);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.feedback-error { color: var(--danger); }
.feedback-warning { color: var(--warning); }
.devtools-hint { min-height: 64px; padding: 11px 19px 13px; }
.devtools-hint strong { color: var(--text); font-weight: 590; }
.devtools-hint kbd {
  min-width: 32px;
  padding: 3px 5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text-secondary);
  background: var(--surface-recessed);
  font: 10px/1.3 var(--font-mono);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .popup *, .popup *::before, .popup *::after { transition: none !important; }
  .capture-switch:active:not(:disabled) .switch-track, .quiet-action:active:not(:disabled) { transform: none; }
}
</style>
