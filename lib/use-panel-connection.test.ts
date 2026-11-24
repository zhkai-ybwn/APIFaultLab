import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelMessage, PanelRequest, PanelSnapshot } from './model'
import { usePanelConnection } from './use-panel-connection'

const hooks = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }))
vi.mock('vue', async importOriginal => ({
  ...await importOriginal<typeof import('vue')>(),
  onMounted: hooks.mount,
  onUnmounted: hooks.unmount,
}))

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>()
  return {
    addListener(listener: (...args: Args) => void) { listeners.add(listener) },
    emit(...args: Args) { for (const listener of listeners) listener(...args) },
  }
}

const snapshot: PanelSnapshot = {
  target: { tabId: 12, documentId: 'test-document', routeKey: 'http://localhost/orders', revision: 1 },
  pageUrl: 'http://localhost/orders', siteOrigin: 'http://localhost', status: 'observing', observing: true,
  entries: [], rules: [], activeCount: 0, configuredCount: 0, plans: [], ignores: [], scenarios: [],
}

function testPort() {
  const onMessage = event<[PanelMessage]>()
  const onDisconnect = event<[]>()
  return {
    onMessage,
    onDisconnect,
    disconnect: vi.fn(() => onDisconnect.emit()),
    postMessage: vi.fn((request: PanelRequest) => {
      if (request.command.type === 'bind') {
        onMessage.emit({ type: 'snapshot', snapshot })
        onMessage.emit({ type: 'result', id: request.id, ok: true })
      }
    }),
  }
}

async function setup(connect: () => ReturnType<typeof testPort>) {
  const document = Object.assign(new EventTarget(), { hidden: false })
  vi.useFakeTimers()
  vi.stubGlobal('chrome', { runtime: { connect } })
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const panel = usePanelConnection(() => 12)
  hooks.mount.mock.lastCall?.[0]()
  await vi.advanceTimersByTimeAsync(0)
  return { panel, document }
}

afterEach(() => {
  hooks.unmount.mock.lastCall?.[0]()
  hooks.mount.mockClear()
  hooks.unmount.mockClear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DevTools panel connection', () => {
  it('recovers after more than three attempts and keeps the latest snapshot while reconnecting', async () => {
    const initial = testPort()
    const recovered = testPort()
    const connect = vi.fn(() => recovered)
      .mockReturnValueOnce(initial)
      .mockImplementationOnce(() => { throw new Error('worker unavailable') })
      .mockImplementationOnce(() => { throw new Error('worker unavailable') })
      .mockImplementationOnce(() => { throw new Error('worker unavailable') })
    const { panel } = await setup(connect)
    expect(panel.connected.value).toBe(true)

    initial.onDisconnect.emit()
    expect(panel.connected.value).toBe(false)
    expect(panel.snapshot.value).toEqual(snapshot)
    await vi.advanceTimersByTimeAsync(6000)

    expect(connect).toHaveBeenCalledTimes(5)
    expect(panel.connected.value).toBe(true)
    expect(panel.connectionError.value).toBe('')
    initial.onMessage.emit({ type: 'snapshot', snapshot: { ...snapshot, entries: [], pageUrl: 'stale' } })
    expect(panel.snapshot.value?.pageUrl).toBe(snapshot.pageUrl)
  })

  it('rebinds after a failed send and leaves the original command for the user to retry', async () => {
    const initial = testPort()
    const recovered = testPort()
    const { panel } = await setup(vi.fn(() => recovered).mockReturnValueOnce(initial))
    initial.postMessage.mockImplementationOnce(() => { throw new Error('port closed') })

    await expect(panel.send({ type: 'stop', target: snapshot.target! })).rejects.toThrow('连接已断开')
    expect(panel.connected.value).toBe(false)
    expect(initial.disconnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)

    expect(panel.connected.value).toBe(true)
    expect(recovered.postMessage.mock.calls.map(([request]) => request.command.type)).toEqual(['bind'])
  })

  it('rebinds when a request never receives an acknowledgement', async () => {
    const initial = testPort()
    const recovered = testPort()
    const { panel } = await setup(vi.fn(() => recovered).mockReturnValueOnce(initial))
    const answer = expect(panel.send({ type: 'stop', target: snapshot.target! })).rejects.toThrow('操作确认超时')

    await vi.advanceTimersByTimeAsync(15400)
    await answer
    expect(initial.disconnect).toHaveBeenCalledTimes(1)
    expect(panel.connected.value).toBe(true)
    expect(recovered.postMessage.mock.calls.map(([request]) => request.command.type)).toEqual(['bind'])
  })

  it('rebinds when the panel becomes visible again', async () => {
    const initial = testPort()
    const recovered = testPort()
    const connect = vi.fn(() => recovered).mockReturnValueOnce(initial)
    const { panel, document } = await setup(connect)
    document.hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    initial.onDisconnect.emit()
    await vi.advanceTimersByTimeAsync(10000)
    expect(connect).toHaveBeenCalledTimes(1)

    document.hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(panel.connected.value).toBe(true)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
