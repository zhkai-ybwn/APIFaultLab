import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { PANEL_PORT, type PanelCommand, type PanelMessage, type PanelRequest, type PanelSnapshot } from './model'
import { applyRequestUpdate } from './panel-request-update'

interface PendingRequest {
  resolve: () => void
  reject: (error: Error) => void
  timer: number
}

const FIRST_RETRY_MS = 400
const MAX_RETRY_MS = 5000
const REQUEST_TIMEOUT_MS = 15000

export function usePanelConnection(resolveTabId: () => number | undefined | Promise<number | undefined>) {
  const snapshot = shallowRef<PanelSnapshot | null>(null)
  const connected = ref(false)
  const connectionError = ref('')
  const pending = new Map<string, PendingRequest>()
  let port: chrome.runtime.Port | undefined
  let reconnectTimer: number | undefined
  let disposed = false
  let connecting = false
  let retryDelay = FIRST_RETRY_MS

  function finish(id: string, error?: Error) {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    window.clearTimeout(request.timer)
    if (error) request.reject(error)
    else request.resolve()
  }

  function send(command: PanelCommand): Promise<void> {
    const activePort = port
    if (!activePort) return Promise.reject(new Error('扩展连接已断开，请重新连接'))
    if (command.type !== 'bind' && !connected.value) return Promise.reject(new Error('扩展正在重新连接，请稍后重试'))
    const request: PanelRequest = { id: crypto.randomUUID(), command }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const message = command.type === 'bind' ? '连接扩展超时，正在重试。' : '操作确认超时。请在重新连接后核对操作结果。'
        recover(activePort, message)
      }, REQUEST_TIMEOUT_MS)
      pending.set(request.id, { resolve, reject, timer })
      try {
        activePort.postMessage(request)
      } catch {
        recover(activePort, '扩展连接已断开，正在重试。')
      }
    })
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  function scheduleReconnect() {
    if (disposed || document.hidden || reconnectTimer !== undefined) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      if (!document.hidden) void connect()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS)
  }

  function releasePort(activePort: chrome.runtime.Port, message: string, alreadyClosed = false) {
    port = undefined
    connected.value = false
    if (!alreadyClosed) {
      try { activePort.disconnect() } catch { /* Chrome may have invalidated the extension context. */ }
    }
    for (const id of pending.keys()) finish(id, new Error(message))
  }

  function recover(activePort: chrome.runtime.Port, message: string, alreadyClosed = false) {
    if (port !== activePort) return
    releasePort(activePort, message, alreadyClosed)
    if (disposed) return
    connectionError.value = message
    scheduleReconnect()
  }

  async function connect() {
    if (disposed || connecting || port) return
    connecting = true
    try {
      const tabId = await resolveTabId()
      if (disposed) return
      if (tabId === undefined) throw new Error('无法识别要测试的标签页')
      const nextPort = chrome.runtime.connect({ name: PANEL_PORT })
      port = nextPort
      nextPort.onMessage.addListener((message: PanelMessage) => {
        if (port !== nextPort) return
        if (message.type === 'snapshot') snapshot.value = message.snapshot
        if (message.type === 'request-update' && snapshot.value) snapshot.value = applyRequestUpdate(snapshot.value, message.update)
        if (message.type === 'result') {
          finish(message.id, message.ok ? undefined : new Error(message.error || '操作未完成'))
        }
      })
      nextPort.onDisconnect.addListener(() => {
        // Reading lastError here prevents Chrome from reporting an unchecked disconnect.
        const reason = chrome.runtime.lastError?.message
        recover(nextPort, reason ? '连接中断，正在重试。如果刚更新扩展，请重新打开开发者工具。' : '连接中断，正在重新连接。', true)
      })
      await send({ type: 'bind', tabId })
      if (port !== nextPort || disposed) return
      clearReconnectTimer()
      retryDelay = FIRST_RETRY_MS
      connectionError.value = ''
      connected.value = true
    } catch (error) {
      if (disposed) return
      const message = error instanceof Error ? error.message : '无法连接当前页面'
      if (port) recover(port, message)
      else {
        connectionError.value = message
        scheduleReconnect()
      }
    } finally {
      connecting = false
    }
  }

  function retry() {
    clearReconnectTimer()
    retryDelay = FIRST_RETRY_MS
    void connect()
  }

  function onVisibilityChange() {
    if (document.hidden) clearReconnectTimer()
    else if (!connected.value) retry()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    void connect()
  })
  onUnmounted(() => {
    disposed = true
    document.removeEventListener('visibilitychange', onVisibilityChange)
    clearReconnectTimer()
    if (port) releasePort(port, '界面已关闭')
  })

  return { snapshot, connected, connectionError, send, retry }
}
