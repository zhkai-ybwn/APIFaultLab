import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../entrypoints/background'
import { SAMPLE_WINDOW_MS, type PanelSnapshot } from '../model'
import { exportBackup, readLocalData } from '../backup'
import type { LocalDataCommand, LocalDataRequest, LocalDataResponse } from '../local-data-client'
import { PANEL_PORT, type CatalogEntry, type CustomScenario, type Endpoint, type PageCommand, type PageStatus, type PanelCommand, type PanelMessage, type PanelRequest, type RequestPhase, type Rule, type SavedPlan, type WorkerReport } from '../model'
import { ignoreKey } from '../request-filters'
import { applyRequestUpdate } from '../panel-request-update'
import { endpointKey } from '../rules'

function signal<Args extends unknown[]>() {
  const listeners: ((...args: Args) => void)[] = []
  return {
    addListener(listener: (...args: Args) => void) { listeners.push(listener) },
    emit(...args: Args) { for (const listener of listeners) listener(...args) },
  }
}

interface TestPage {
  url: string
  documentId: string
  installed: boolean
  status: PageStatus
  rules: Rule[]
  beforeConfigure?: Promise<void>
  failStop?: boolean
  repairsOnInjection?: boolean
  frameLookup?: 'pending' | 'error'
}

const appUrl = 'http://localhost:5173/orders'
const rule: Rule = {
  id: 'orders', routeKey: appUrl,
  endpoint: { method: 'POST', origin: 'http://localhost:5173', path: '/api/orders' },
  conditions: [], response: { kind: 'http', status: 200, body: '[]', contentType: 'application/json', delayMs: 0 },
}

function newPage(documentId: string, url = appUrl): TestPage {
  return {
    url, documentId, installed: false, rules: [],
    status: { session: null, revision: 0, observing: false, activeCount: 0, intact: true },
  }
}

function createRuntime(localSeed: Record<string, unknown> = {}, failFirstLocalRead = false, sessionSeed: Record<string, unknown> = {}) {
  const pages = new Map([[1, newPage('first')], [2, newPage('another-tab')]])
  const runtimeId = 'test-extension'
  const getURL = (path: string) => `chrome-extension://${runtimeId}/${path}`
  const onCommitted = signal<[{ tabId: number; frameId: number; documentId: string; url: string }]>()
  const onUpdated = signal<[number, { status: 'complete' }]>()
  const onPageReport = signal<[
    WorkerReport | LocalDataRequest,
    { id: string; frameId?: number; documentId?: string; tab?: { id: number }; url?: string },
    ((response: LocalDataResponse) => void)?,
  ]>()
  const onConnect = signal<[unknown]>()
  const configureAttempts: { tabId: number; documentId: string; rules: Rule[] }[] = []
  const storage = (seed: Record<string, unknown> = {}) => {
    const values = structuredClone(seed)
    return {
      get: async (key: string | null) => key === null ? structuredClone(values) : ({ [key]: structuredClone(values[key]) }),
      set: async (items: Record<string, unknown>) => Object.assign(values, structuredClone(items)),
      remove: async (key: string) => { delete values[key] },
    }
  }
  const localStorage = storage(localSeed)
  const sessionStorage = storage(sessionSeed)
  if (failFirstLocalRead) vi.spyOn(localStorage, 'get').mockRejectedValueOnce(new Error('storage unavailable'))

  vi.stubGlobal('chrome', {
    storage: { local: localStorage, session: sessionStorage },
    tabs: {
      get: async (tabId: number) => pages.has(tabId) ? { id: tabId, incognito: false } : Promise.reject(new Error('closed')),
      onUpdated, onRemoved: signal(),
    },
    webNavigation: {
      getFrame: async ({ tabId }: { tabId: number }) => {
        const page = pages.get(tabId)
        if (page?.frameLookup === 'error') throw new Error('frame changing')
        if (page?.frameLookup === 'pending') return null
        return page
      },
      onCommitted, onHistoryStateUpdated: signal(), onReferenceFragmentUpdated: signal(),
    },
    runtime: { id: runtimeId, getURL, onConnect, onMessage: onPageReport },
    action: { setBadgeText: async () => {} },
    scripting: {
      async executeScript(options: { target: { tabId: number; documentIds: [string] }; files?: string[]; args?: [string, PageCommand] }) {
        const { tabId, documentIds } = options.target
        const page = pages.get(tabId)
        if (!page || page.documentId !== documentIds[0]) throw new Error('stale document')
        if (options.files?.includes('page-main.js')) {
          page.installed = true
          if (page.repairsOnInjection) page.status.intact = true
        }
        const command = options.args?.[1]
        if (page.installed && command?.type === 'configure') {
          configureAttempts.push({ tabId, documentId: page.documentId, rules: command.rules })
          await page.beforeConfigure
          page.rules = command.rules
          page.status = { ...page.status, session: command.session, revision: command.revision,
            observing: command.observing, activeCount: command.rules.length }
        }
        if (page.installed && command?.type === 'stop') {
          if (page.failStop) throw new Error('page went away')
          page.rules = []
          page.status = { ...page.status, revision: command.revision, activeCount: 0 }
        }
        if (page.installed && command?.type === 'observe') page.status.observing = command.enabled
        if (page.installed && command?.type === 'sample' && page.status.observing && command.routeKey === page.url) {
          page.status.sampleId = command.id
        }
        return [{ documentId: page.documentId, frameId: 0, result: page.installed ? structuredClone(page.status) : null }]
      },
    },
  })
  worker.main()

  function view(path: 'popup.html' | 'workbench.html') {
    const messages: PanelMessage[] = []
    const onMessage = signal<[PanelRequest]>()
    const onDisconnect = signal<[]>()
    onConnect.emit({
      name: PANEL_PORT, sender: { id: runtimeId, url: getURL(path) }, onMessage, onDisconnect,
      postMessage: (message: PanelMessage) => { messages.push(structuredClone(message)) },
    })
    return {
      close: () => onDisconnect.emit(),
      messages: () => messages.slice(),
      snapshots: () => messages.reduce<PanelSnapshot[]>((snapshots, message) => {
        if (message.type === 'snapshot') snapshots.push(message.snapshot)
        if (message.type === 'request-update') {
          const previous = snapshots.at(-1)
          if (previous) snapshots.push(applyRequestUpdate(previous, message.update))
        }
        return snapshots
      }, []),
      async call(command: PanelCommand) {
        const id = crypto.randomUUID()
        onMessage.emit({ id, command })
        return vi.waitFor(() => {
          const found = messages.find(msg => msg.type === 'result' && msg.id === id)
          if (!found) throw new Error(`Waiting for ${command.type}`)
          return found
        }, { interval: 5 })
      },
    }
  }

  function navigate(tabId: number, next: TestPage) {
    pages.set(tabId, next)
    onCommitted.emit({ tabId, frameId: 0, url: next.url, documentId: next.documentId })
  }

  function reportReal(tabId: number, endpoint = rule.endpoint, phase: RequestPhase = 'real',
    details: { ruleId?: string; requestId?: string; status?: number; sample?: string; sampleId?: string; detail?: string } = {}) {
    const page = pages.get(tabId)
    if (!page || !page.status.session) throw new Error('No live page session')
    onPageReport.emit({ type: 'page-report', session: page.status.session, event: {
      routeKey: page.url, endpoint, phase, time: Date.now(), revision: page.status.revision,
      ...details, requestId: details.requestId ?? 'one-request', status: details.status ?? 200,
    } }, { id: runtimeId, tab: { id: tabId }, frameId: 0, documentId: page.documentId })
  }

  function localCommand(command: LocalDataCommand) {
    return new Promise<LocalDataResponse>(resolve => {
      onPageReport.emit({ type: 'local-data', command }, { id: runtimeId, url: getURL('workbench.html') }, resolve)
    })
  }

  return { view, pages, navigate, reportReal, configureAttempts, localStorage, sessionStorage, localCommand, complete: (tabId: number) => onUpdated.emit(tabId, { status: 'complete' }) }
}

afterEach(async () => {
  // Catalog persistence debounces captured entries for 200 ms.
  await new Promise(resolve => setTimeout(resolve, 220))
  vi.unstubAllGlobals()
})

describe('toolbar and DevTools tab sessions', () => {
  it('does not confirm a manual adapter check from a cached active snapshot', async () => {
    const runtime = createRuntime()
    const panel = runtime.view('workbench.html')
    await panel.call({ type: 'bind', tabId: 1 })
    await panel.call({ type: 'apply', target: panel.snapshots().at(-1)!.target!, rules: [rule] })
    expect(panel.snapshots().at(-1)?.status).toBe('active')
    const command = { type: 'reconnect' as const, target: panel.snapshots().at(-1)!.target! }
    runtime.pages.get(1)!.frameLookup = 'pending'
    await expect(panel.call(command)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('未确认') })

    runtime.pages.get(1)!.frameLookup = undefined
    await expect(panel.call(command)).resolves.toMatchObject({ ok: true })
  })

  it('stops only the current page and verifies the next real response without removing rules from another page', async () => {
    const runtime = createRuntime()
    const panel = runtime.view('workbench.html')
    await panel.call({ type: 'bind', tabId: 1 })
    await expect(panel.call({ type: 'apply', target: panel.snapshots().at(-1)!.target!, rules: [rule] }))
      .resolves.toMatchObject({ ok: true })

    const otherUrl = 'http://localhost:5173/customers'
    runtime.navigate(1, { ...runtime.pages.get(1)!, url: otherUrl })
    await vi.waitFor(() => expect(panel.snapshots().at(-1)?.target?.routeKey).toBe(otherUrl))
    const otherRule = { ...rule, id: 'customers', routeKey: otherUrl }
    await expect(panel.call({ type: 'apply', target: panel.snapshots().at(-1)!.target!, rules: [otherRule] }))
      .resolves.toMatchObject({ ok: true })
    await expect(panel.call({ type: 'stop-route', target: panel.snapshots().at(-1)!.target! }))
      .resolves.toMatchObject({ ok: true })

    expect(runtime.pages.get(1)?.rules).toEqual([rule])
    expect(panel.snapshots().at(-1)).toMatchObject({ rules: [], activeCount: 1, recoveryScope: 'route', recoveryState: 'awaiting-real' })
    runtime.reportReal(1)
    await vi.waitFor(() => expect(panel.snapshots().at(-1)).toMatchObject({ recoveryScope: 'route', recoveryState: 'real-confirmed' }))
  })

  it('sends a response sample only when it changes and excludes saved configuration from request updates', async () => {
    const runtime = createRuntime()
    const panel = runtime.view('workbench.html')
    await panel.call({ type: 'bind', tabId: 1 })
    await expect(panel.call({ type: 'sample', target: panel.snapshots().at(-1)!.target!, endpoint: rule.endpoint }))
      .resolves.toMatchObject({ ok: true })
    const id = runtime.pages.get(1)!.status.sampleId!
    const sample = '{"token":"sample body"}'
    runtime.reportReal(1, rule.endpoint, 'real', { sample, sampleId: `${id}-obsolete` })
    runtime.reportReal(1, rule.endpoint, 'real', { requestId: 'normal-report' })
    await vi.waitFor(() => expect(panel.messages().at(-1)).toMatchObject({ type: 'request-update', update: { responseSources: [] } }))
    expect(panel.snapshots().at(-1)).toMatchObject({ responseSample: { state: 'waiting' } })
    runtime.reportReal(1, rule.endpoint, 'real', { sample, sampleId: id })
    await vi.waitFor(() => expect(panel.messages().at(-1)).toMatchObject({
      type: 'request-update', update: { responseSources: [[endpointKey(rule.endpoint), { sample }]] },
    }))
    expect(panel.snapshots().at(-1)).toMatchObject({ responseSample: { state: 'captured' } })

    const previous = panel.messages().length
    runtime.reportReal(1, rule.endpoint, 'real', { requestId: 'next-real-request' })
    await vi.waitFor(() => expect(panel.messages().length).toBeGreaterThan(previous))
    const update = panel.messages().at(-1)
    expect(update).toMatchObject({ type: 'request-update', update: { responseSources: [] } })
    expect(update).not.toHaveProperty('update.plans')
    expect(update).not.toHaveProperty('update.rules')
    expect(update).not.toHaveProperty('update.scenarios')
    expect(JSON.stringify(update)).not.toContain('sample body')
    expect(panel.snapshots().at(-1)?.entries[0]?.sample).toBe(sample)
  })

  it('attaches the captured response to the selected template and keeps newer request telemetry', async () => {
    const runtime = createRuntime()
    const panel = runtime.view('workbench.html')
    await panel.call({ type: 'bind', tabId: 1 })
    const template = { ...rule.endpoint, path: '/api/orders/{id}', template: true }
    const concrete = { ...rule.endpoint, path: '/api/orders/123' }
    await expect(panel.call({ type: 'sample', target: panel.snapshots().at(-1)!.target!, endpoint: template }))
      .resolves.toMatchObject({ ok: true })
    const id = runtime.pages.get(1)!.status.sampleId!
    runtime.reportReal(1, concrete, 'real', { requestId: 'newer' })
    runtime.reportReal(1, concrete, 'real', { requestId: 'older', sampleId: id, sample: 'real response' })

    await vi.waitFor(() => expect(panel.snapshots().at(-1)?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: endpointKey(template), sample: 'real response' }),
      expect.objectContaining({ key: endpointKey(concrete), last: expect.objectContaining({ requestId: 'newer' }) }),
    ])))
  })

  it('reports a sample read failure and expires an unanswered attempt', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      const panel = runtime.view('workbench.html')
      await panel.call({ type: 'bind', tabId: 1 })
      const sampleCommand = { type: 'sample' as const, target: panel.snapshots().at(-1)!.target!, endpoint: rule.endpoint }
      await expect(panel.call(sampleCommand)).resolves.toMatchObject({ ok: true })
      runtime.reportReal(1, rule.endpoint, 'real', { sampleId: runtime.pages.get(1)!.status.sampleId!, detail: '响应正文超过采样上限。' })
      await vi.waitFor(() => expect(panel.snapshots().at(-1)).toMatchObject({ responseSample: { state: 'failed', message: '响应正文超过采样上限。' } }))

      await expect(panel.call(sampleCommand)).resolves.toMatchObject({ ok: true })
      await vi.advanceTimersByTimeAsync(SAMPLE_WINDOW_MS + 1)
      expect(panel.snapshots().at(-1)).toMatchObject({ responseSample: { state: 'expired' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports unreadable storage and salvageable records without changing the original', async () => {
    const siteOrigin = new URL(appUrl).origin
    const plan: SavedPlan = {
      id: 'salvageable', name: '可读取方案', siteOrigin, routeKey: appUrl,
      setup: '', trigger: '', expectation: '', updatedAt: 1, rules: [rule],
    }
    const corrupt = { plans: [plan, { ...plan, id: 'damaged', routeKey: 'file:///broken' }], future: true }
    const key = 'apiFaultLabLocal_v1'
    const runtime = createRuntime({ [key]: corrupt })
    const panel = runtime.view('workbench.html')
    await expect(panel.call({ type: 'bind', tabId: 1 })).resolves.toMatchObject({ ok: true })
    const snapshot = panel.snapshots().at(-1)!
    expect(snapshot).toMatchObject({ storageRescueAvailable: true, storageError: expect.stringContaining('无法识别') })

    const raw = await runtime.localCommand({ type: 'export-rescue', mode: 'raw' })
    if (!raw.ok || !raw.value || !('json' in raw.value)) throw new Error('No original data file')
    expect(JSON.parse(raw.value.json).data).toEqual(corrupt)
    const rescued = await runtime.localCommand({ type: 'export-rescue', mode: 'readable' })
    if (!rescued.ok || !rescued.value || !('skipped' in rescued.value)) throw new Error('No recovered data file')
    expect(rescued.value).toMatchObject({ recovered: 1, skipped: 2 })
    expect(JSON.parse(rescued.value.json).data.plans).toEqual([plan])
    expect(await runtime.localCommand({ type: 'preview-backup', json: rescued.value.json })).toMatchObject({ ok: false })
    expect(await runtime.localStorage.get(key)).toEqual({ [key]: corrupt })
    expect(runtime.pages.get(1)?.rules).toEqual([])
  })

  it('propagates saved plans across tabs while preventing stale edits from overwriting them', async () => {
    const siteOrigin = new URL(appUrl).origin
    const plan: SavedPlan = {
      id: 'shared-draft', name: '原方案', siteOrigin, routeKey: appUrl,
      setup: '', trigger: '', expectation: '', updatedAt: 0, rules: [rule],
    }
    const runtime = createRuntime()
    const first = runtime.view('workbench.html')
    const second = runtime.view('workbench.html')
    await first.call({ type: 'bind', tabId: 1 })
    await second.call({ type: 'bind', tabId: 2 })
    const target = () => first.snapshots().at(-1)!.target!
    const otherTarget = () => second.snapshots().at(-1)!.target!
    await expect(first.call({ type: 'save-plan', target: target(), plan, expectedUpdatedAt: null }))
      .resolves.toMatchObject({ ok: true })
    const saved = second.snapshots().at(-1)?.plans[0]
    expect(saved?.name).toBe('原方案')
    await expect(first.call({ type: 'save-plan', target: target(), plan: { ...plan, name: '较新的改动' }, expectedUpdatedAt: saved!.updatedAt }))
      .resolves.toMatchObject({ ok: true })
    await expect(second.call({ type: 'save-plan', target: otherTarget(), plan: { ...plan, name: '过期草稿' }, expectedUpdatedAt: saved!.updatedAt }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('另存副本') })
    expect(second.snapshots().at(-1)?.plans[0]?.name).toBe('较新的改动')
    expect(runtime.pages.get(1)?.rules).toEqual([])
    expect(runtime.pages.get(2)?.rules).toEqual([])
  })

  it('keeps per-rule mock results after a different operation on the same POST passes through', async () => {
    const runtime = createRuntime()
    const panel = runtime.view('workbench.html')
    await panel.call({ type: 'bind', tabId: 1 })
    const orderRule: Rule = {
      ...rule,
      conditions: [{ source: 'json', path: '/operationName', value: 'ListOrders' }],
    }
    await expect(panel.call({ type: 'apply', target: panel.snapshots().at(-1)!.target!, rules: [orderRule] }))
      .resolves.toMatchObject({ ok: true })

    runtime.reportReal(1, rule.endpoint, 'mock', { ruleId: orderRule.id, requestId: 'orders', status: 429 })
    runtime.reportReal(1, rule.endpoint, 'real', { requestId: 'customers' })
    await vi.waitFor(() => expect(panel.snapshots().at(-1)).toMatchObject({
      entries: [{ key: endpointKey(rule.endpoint), last: { phase: 'real', requestId: 'customers' } }],
      ruleOutcomes: [{ ruleId: orderRule.id, phase: 'mock', status: 429, hitCount: 1 }],
    }))

    await expect(panel.call({ type: 'stop', target: panel.snapshots().at(-1)!.target! })).resolves.toMatchObject({ ok: true })
    expect(panel.snapshots().at(-1)).toMatchObject({ recoveryState: 'awaiting-real', ruleOutcomes: [] })
    runtime.reportReal(1)
    await vi.waitFor(() => expect(panel.snapshots().at(-1)).toMatchObject({ recoveryState: 'real-confirmed' }))
  })

  it('keeps configured rules and business requests visible through a large burst of tiles', async () => {
    const runtime = createRuntime()
    const panel = runtime.view('workbench.html')
    await panel.call({ type: 'bind', tabId: 1 })
    await expect(panel.call({ type: 'apply', target: panel.snapshots().at(-1)!.target!, rules: [rule] }))
      .resolves.toMatchObject({ ok: true })
    expect(panel.snapshots().at(-1)?.entries).toEqual([
      expect.objectContaining({ key: endpointKey(rule.endpoint), observed: false }),
    ])

    const business = { ...rule.endpoint, path: '/api/unconfigured' }
    runtime.reportReal(1, business)
    for (let index = 0; index < 125; index += 1) {
      runtime.reportReal(1, { ...rule.endpoint, method: 'GET', path: `/tiles/5/0/${index}.png` })
    }
    await vi.waitFor(() => expect(panel.snapshots().at(-1)).toMatchObject({
      catalogAtCapacity: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ key: endpointKey(rule.endpoint) }),
        expect.objectContaining({ key: endpointKey(business) }),
      ]),
    }))
  })

  it('takes over an already installed adapter left idle by a previous extension session', async () => {
    const runtime = createRuntime()
    const page = runtime.pages.get(1)!
    page.installed = true
    page.status.session = 'old-extension-session'
    page.status.revision = 10
    const view = runtime.view('workbench.html')
    expect(await view.call({ type: 'bind', tabId: 1 })).toMatchObject({ ok: true })
    expect(view.snapshots().at(-1)).toMatchObject({ status: 'observing', activeCount: 0 })
    expect(page.status.session).not.toBe('old-extension-session')
  })

  it('requires an explicit stop for unknown active rules and can stop if only the control remains reachable', async () => {
    const runtime = createRuntime()
    const page = runtime.pages.get(1)!
    page.installed = true
    page.rules = [rule]
    page.status = { session: 'old-session', revision: 5, observing: true, activeCount: 1, intact: false }
    const view = runtime.view('workbench.html')

    await view.call({ type: 'bind', tabId: 1 })
    expect(view.snapshots().at(-1)).toMatchObject({ status: 'uncertain', activeCount: 1 })
    expect(page.rules).toEqual([rule])
    const target = view.snapshots().at(-1)?.target
    if (!target) throw new Error('No live page target')
    expect(await view.call({ type: 'stop', target })).toMatchObject({ ok: true })
    expect(view.snapshots().at(-1)).toMatchObject({ status: 'unavailable', activeCount: 0 })
    expect(page.rules).toEqual([])
  })

  it('reconfirms rules when the same document is activated again with its configuration reset', async () => {
    const runtime = createRuntime()
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    const target = view.snapshots().at(-1)?.target
    if (!target) throw new Error('No live page target')
    await view.call({ type: 'apply', target, rules: [rule] })
    const page = runtime.pages.get(1)!
    // pagehide discarded the installed configuration while Chrome reused the document.
    page.status = { session: null, revision: 0, observing: false, activeCount: 0, intact: true }
    page.rules = []
    runtime.navigate(1, page)
    await vi.waitFor(() => {
      expect(page.rules).toEqual([rule])
      expect(view.snapshots().at(-1)).toMatchObject({ status: 'active', activeCount: 1 })
    })
  })

  it('keeps the interface list during a transient frame lookup and checks the adapter when the load completes', async () => {
    const runtime = createRuntime()
    const page = runtime.pages.get(1)!
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    runtime.reportReal(1)
    await vi.waitFor(() => expect(view.snapshots().at(-1)?.entries).toHaveLength(1))

    page.frameLookup = 'pending'
    page.status.intact = false
    page.repairsOnInjection = true
    const messageCount = view.snapshots().length
    runtime.complete(1)
    await vi.waitFor(() => expect(view.snapshots().length).toBeGreaterThan(messageCount))
    expect(view.snapshots().at(-1)).toMatchObject({
      target: { documentId: page.documentId }, status: 'observing', entries: [{ endpoint: rule.endpoint }],
    })

    page.frameLookup = undefined
    await vi.waitFor(() => expect(page.status.intact).toBe(true))
    expect(view.snapshots().at(-1)?.entries).toHaveLength(1)
  })

  it('reconnects using the newest document even if the action was sent from a snapshot just before refresh', async () => {
    const runtime = createRuntime()
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    const before = view.snapshots().at(-1)?.target
    if (!before) throw new Error('No original document')
    const page = newPage('after-refresh')
    runtime.pages.set(1, page)
    expect(await view.call({ type: 'reconnect', target: before })).toMatchObject({ ok: true })
    expect(view.snapshots().at(-1)).toMatchObject({ target: { documentId: page.documentId }, status: 'observing' })
  })

  it('restores rules and catalog on same-origin reload after both views close, without affecting another tab', async () => {
    const runtime = createRuntime()
    const popup = runtime.view('popup.html')
    const workbench = runtime.view('workbench.html')
    expect(await popup.call({ type: 'bind', tabId: 1 })).toMatchObject({ ok: true })
    expect(await workbench.call({ type: 'bind', tabId: 1 })).toMatchObject({ ok: true })
    runtime.reportReal(1)
    await vi.waitFor(() => expect(workbench.snapshots().at(-1)?.entries).toHaveLength(1))
    const target = workbench.snapshots().at(-1)?.target
    if (!target) throw new Error('No workbench target')
    expect(await workbench.call({ type: 'apply', target, rules: [rule] })).toMatchObject({ ok: true })
    expect(popup.snapshots().at(-1)).toMatchObject({ activeCount: 1, status: 'active' })
    popup.close()
    workbench.close()

    const reloaded = newPage('reloaded')
    runtime.navigate(1, reloaded)
    await vi.waitFor(() => expect(reloaded.rules).toEqual([rule]))

    const reopened = runtime.view('workbench.html')
    expect(await reopened.call({ type: 'bind', tabId: 1 })).toMatchObject({ ok: true })
    const latest = reopened.snapshots().at(-1)
    expect(latest).toMatchObject({ target: { documentId: 'reloaded' }, status: 'active', activeCount: 1, observing: true })
    expect(latest?.entries).toHaveLength(1)
    const other = runtime.view('popup.html')
    await other.call({ type: 'bind', tabId: 2 })
    expect(other.snapshots().at(-1)).toMatchObject({ rules: [], activeCount: 0 })
  })

  it('shows restoring until the new document acknowledges the rules and clears them on cross-origin navigation', async () => {
    const runtime = createRuntime()
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    const target = view.snapshots().at(-1)?.target
    if (!target) throw new Error('No workbench target')
    await view.call({ type: 'apply', target, rules: [rule] })

    const gate = Promise.withResolvers<void>()
    const reloaded = newPage('reloaded')
    reloaded.beforeConfigure = gate.promise
    runtime.navigate(1, reloaded)
    try {
      await vi.waitFor(() => expect(runtime.configureAttempts.at(-1)?.documentId).toBe('reloaded'))
      expect(view.snapshots().at(-1)).toMatchObject({ status: 'restoring', activeCount: 0, configuredCount: 1 })
    } finally {
      gate.resolve()
    }
    await vi.waitFor(() => expect(view.snapshots().at(-1)).toMatchObject({ status: 'active', activeCount: 1 }))
    runtime.navigate(1, newPage('other-site', 'http://localhost:4173/orders'))
    await vi.waitFor(() => expect(view.snapshots().at(-1)).toMatchObject({
      target: { documentId: 'other-site' }, rules: [], activeCount: 0,
    }))
    runtime.navigate(1, newPage('back-to-app'))
    await vi.waitFor(() => expect(view.snapshots().at(-1)).toMatchObject({
      target: { documentId: 'back-to-app' }, status: 'observing', rules: [], activeCount: 0,
    }))
  })

  it('cancels restoration even when a requested stop cannot be confirmed by the old document', async () => {
    const runtime = createRuntime()
    const view = runtime.view('popup.html')
    await view.call({ type: 'bind', tabId: 1 })
    const initial = view.snapshots().at(-1)?.target
    if (!initial) throw new Error('No popup target')
    await view.call({ type: 'apply', target: initial, rules: [rule] })
    const activeTarget = view.snapshots().at(-1)?.target
    const active = runtime.pages.get(1)
    if (!activeTarget || !active) throw new Error('No active document')
    active.failStop = true
    expect(await view.call({ type: 'stop', target: activeTarget })).toMatchObject({ ok: false })
    expect(view.snapshots().at(-1)).toMatchObject({ status: 'uncertain', activeCount: 1, configuredCount: 0 })

    const reloaded = newPage('after-stop')
    runtime.navigate(1, reloaded)
    await vi.waitFor(() => expect(view.snapshots().at(-1)).toMatchObject({
      target: { documentId: 'after-stop' }, status: 'observing', activeCount: 0, rules: [],
    }))
    expect(reloaded.rules).toEqual([])
  })

  it('cannot restore stopped rules after a session quota error and a worker restart', async () => {
    const runtime = createRuntime()
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    const ready = view.snapshots().at(-1)!.target!
    expect(await view.call({ type: 'apply', target: ready, rules: [rule] })).toMatchObject({ ok: true })
    const key = 'apiFaultLabSession_v2:1'
    expect((await runtime.sessionStorage.get(key))[key]).toMatchObject({ rules: [rule] })
    vi.spyOn(runtime.sessionStorage, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'))

    const active = view.snapshots().at(-1)!.target!
    expect(await view.call({ type: 'stop', target: active })).toMatchObject({ ok: true })
    expect(runtime.pages.get(1)?.rules).toEqual([])
    const persisted = await runtime.sessionStorage.get(null)
    expect(persisted).not.toHaveProperty(key)

    const restarted = createRuntime({}, false, persisted)
    restarted.pages.set(1, newPage('after-worker-restart'))
    const rebuilt = restarted.view('workbench.html')
    await rebuilt.call({ type: 'bind', tabId: 1 })
    expect(rebuilt.snapshots().at(-1)).toMatchObject({ activeCount: 0, rules: [], status: 'observing' })
    expect(restarted.configureAttempts).not.toContainEqual(expect.objectContaining({ rules: [rule] }))
  })

  it('does not confirm a stop when neither cache deletion nor a replacement marker is available', async () => {
    const runtime = createRuntime()
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    const ready = view.snapshots().at(-1)!.target!
    expect(await view.call({ type: 'apply', target: ready, rules: [rule] })).toMatchObject({ ok: true })
    vi.spyOn(runtime.sessionStorage, 'remove').mockRejectedValueOnce(new Error('storage temporarily unavailable'))
    vi.spyOn(runtime.sessionStorage, 'set').mockRejectedValueOnce(new Error('storage temporarily unavailable'))

    const active = view.snapshots().at(-1)!.target!
    expect(await view.call({ type: 'stop', target: active })).toMatchObject({ ok: false, error: expect.stringContaining('无法清除缓存的规则') })
    expect(runtime.pages.get(1)?.rules).toEqual([rule])
    expect(view.snapshots().at(-1)).toMatchObject({ sessionWarning: expect.stringContaining('无法清除缓存的规则') })
  })

  it('migrates a legacy session and clears the older cache before it can be restored again', async () => {
    const legacyKey = 'apiFaultLabSessions_v1'
    const runtime = createRuntime({}, false, { [legacyKey]: [{
      tabId: 1, documentId: 'before-migration', pageUrl: appUrl, routeKey: appUrl, siteOrigin: new URL(appUrl).origin,
      id: 'legacy-session', revision: 4, rules: [rule], status: 'active', observing: true, activeCount: 1, catalog: [],
    }] })
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    expect(view.snapshots().at(-1)).toMatchObject({ activeCount: 1, rules: [rule], status: 'active' })
    const stored = await runtime.sessionStorage.get(null)
    expect(stored).not.toHaveProperty(legacyKey)
    expect(stored['apiFaultLabSession_v2:1']).toMatchObject({ rules: [rule], revision: 5 })
  })

  it('restores confirmed rules independently of an unreadable request catalog', async () => {
    const runtime = createRuntime({}, false, {
      'apiFaultLabSession_v2:1': {
        tabId: 1, documentId: 'before-reload', pageUrl: appUrl, routeKey: appUrl, siteOrigin: new URL(appUrl).origin,
        id: 'cached-session', revision: 4, rules: [rule], status: 'active', observing: true, activeCount: 1,
      },
      apiFaultLabCatalog_v2: [null, [1, [null, [appUrl, [null, 'invalid']]]]],
    })
    const view = runtime.view('workbench.html')
    await view.call({ type: 'bind', tabId: 1 })
    expect(view.snapshots().at(-1)).toMatchObject({ activeCount: 1, rules: [rule], status: 'active' })
  })

  it('keeps saved data intact when the initial local read fails and unblocks saving after retry', async () => {
    const key = 'apiFaultLabLocal_v1'
    const plan: SavedPlan = {
      id: 'keep', name: '保留方案', siteOrigin: new URL(appUrl).origin, routeKey: appUrl,
      rules: [rule], setup: '', trigger: '', expectation: '', updatedAt: 1,
    }
    const original = { plans: [plan], imports: [] }
    const runtime = createRuntime({ [key]: original }, true)
    const workbench = runtime.view('workbench.html')
    const set = vi.spyOn(runtime.localStorage, 'set')
    await workbench.call({ type: 'bind', tabId: 1 })
    const target = workbench.snapshots().at(-1)?.target
    if (!target) throw new Error('No workbench target')

    expect(workbench.snapshots().at(-1)?.storageError).toContain('读取失败')
    expect(await workbench.call({ type: 'save-plan', target, plan: { ...plan, id: 'new' } })).toMatchObject({ ok: false })
    expect(await runtime.localCommand({ type: 'export-backup' })).toMatchObject({ ok: false })
    expect(set).not.toHaveBeenCalled()
    expect((await runtime.localStorage.get(key))[key]).toEqual(original)

    expect(await runtime.localCommand({ type: 'retry-storage' })).toMatchObject({ ok: true })
    expect(workbench.snapshots().at(-1)).toMatchObject({ plans: [plan], storageError: undefined })
    expect(await workbench.call({ type: 'save-plan', target, plan: { ...plan, id: 'new' } })).toMatchObject({ ok: true })
    expect(workbench.snapshots().at(-1)?.plans.map(item => item.id)).toEqual(['new', 'keep'])
  })

  it('requires a matching backup preview and restores durable settings without activating rules', async () => {
    const key = 'apiFaultLabLocal_v1'
    const siteOrigin = new URL(appUrl).origin
    const plan: SavedPlan = {
      id: 'backup', name: '备份方案', siteOrigin, routeKey: appUrl,
      rules: [rule], setup: '', trigger: '', expectation: '', updatedAt: 1,
    }
    const json = exportBackup(readLocalData({ plans: [plan], ignoresBySite: { [siteOrigin]: [{ kind: 'prefix', path: '/assets' }] } }))
    const runtime = createRuntime()
    const first = await runtime.localCommand({ type: 'preview-backup', json })
    if (!first.ok || !first.value || !('confirmation' in first.value)) throw new Error('No backup preview')
    expect(first.value.plans).toMatchObject({ added: 1, conflicts: 0 })
    const workbench = runtime.view('workbench.html')
    await workbench.call({ type: 'bind', tabId: 1 })
    const target = workbench.snapshots().at(-1)?.target
    if (!target) throw new Error('No workbench target')
    const existing = { ...plan, name: '本地方案' }
    await workbench.call({ type: 'save-plan', target, plan: existing })
    expect(await runtime.localCommand({ type: 'restore-backup', json, preview: first.value })).toMatchObject({ ok: false, error: expect.stringContaining('重新预览') })

    const second = await runtime.localCommand({ type: 'preview-backup', json })
    if (!second.ok || !second.value || !('confirmation' in second.value)) throw new Error('No backup preview')
    expect(second.value.plans).toMatchObject({ added: 0, conflicts: 1 })
    expect(second.value.ignores).toMatchObject({ added: 1, conflicts: 0 })
    const set = vi.spyOn(runtime.localStorage, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'))
    expect(await runtime.localCommand({ type: 'restore-backup', json, preview: second.value })).toMatchObject({ ok: false, error: expect.stringContaining('空间不足') })
    expect((await runtime.localStorage.get(key))[key]).toMatchObject({ ignoresBySite: {} })

    expect(await runtime.localCommand({ type: 'restore-backup', json, preview: second.value })).toMatchObject({ ok: true })
    expect(workbench.snapshots().at(-1)).toMatchObject({ plans: [{ name: '本地方案' }], ignores: [{ kind: 'prefix', path: '/assets' }], activeCount: 0, rules: [] })
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('merges, replaces and deletes the current imported directory without touching running rules', async () => {
    const runtime = createRuntime()
    const source = runtime.view('workbench.html')
    const peer = runtime.view('workbench.html')
    await source.call({ type: 'bind', tabId: 1 })
    await peer.call({ type: 'bind', tabId: 2 })
    const target = () => source.snapshots().at(-1)!.target!
    const entry = (id: string): CatalogEntry => ({
      key: endpointKey(rule.endpoint), endpoint: rule.endpoint, title: '共用端点',
      imported: true, observed: false, realSeen: false, hitCount: 0,
      operations: [{ id, title: id, source: 'documented', conditions: [{ source: 'json', path: '/operationName', value: id }] }],
    })

    await expect(source.call({ type: 'import', target: target(), entries: [entry('list-orders')] })).resolves.toMatchObject({ ok: true })
    await expect(source.call({ type: 'import', target: target(), entries: [entry('list-customers')] })).resolves.toMatchObject({ ok: true })
    expect(source.snapshots().at(-1)?.importedEntries?.[0]?.operations?.map(item => item.id)).toEqual(['list-orders', 'list-customers'])
    expect(peer.snapshots().at(-1)?.importedEntries?.[0]?.operations).toHaveLength(2)

    await expect(source.call({ type: 'apply', target: target(), rules: [rule] })).resolves.toMatchObject({ ok: true })
    await expect(source.call({ type: 'import', target: target(), entries: [entry('list-orders')], mode: 'replace', expectedKeys: [] }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('已变化') })
    await expect(source.call({ type: 'import', target: target(), entries: [entry('list-orders')], mode: 'replace', expectedKeys: [endpointKey(rule.endpoint)] }))
      .resolves.toMatchObject({ ok: true })
    expect(source.snapshots().at(-1)?.importedEntries?.[0]?.operations?.map(item => item.id)).toEqual(['list-orders'])
    await expect(source.call({ type: 'delete-imports', target: target(), keys: [endpointKey(rule.endpoint)] })).resolves.toMatchObject({ ok: true })
    expect(source.snapshots().at(-1)).toMatchObject({ importedEntries: [], rules: [expect.objectContaining({ id: rule.id })], activeCount: 1 })
    expect(peer.snapshots().at(-1)?.importedEntries).toEqual([])
  })

  it('persists site-specific ignores and reusable scenarios without losing legacy plans or imports', async () => {
    const localKey = 'apiFaultLabLocal_v1'
    const siteOrigin = new URL(appUrl).origin
    const legacyPlan: SavedPlan = {
      id: 'legacy-plan', name: '旧方案', siteOrigin, routeKey: appUrl,
      rules: [rule], setup: '', trigger: '', expectation: '', updatedAt: 1,
    }
    const importedEndpoint: Endpoint = { ...rule.endpoint, path: '/api/imported' }
    const legacyEntry: CatalogEntry = { key: endpointKey(importedEndpoint), endpoint: importedEndpoint, imported: true, observed: false, realSeen: false, hitCount: 0 }
    const imports = [{ siteOrigin, routeKey: appUrl, entry: legacyEntry }]
    const runtime = createRuntime({ [localKey]: { plans: [legacyPlan], imports } })
    runtime.pages.set(3, newPage('other-site', 'http://localhost:4173/orders'))
    const source = runtime.view('workbench.html')
    const peer = runtime.view('workbench.html')
    const otherSite = runtime.view('workbench.html')
    await source.call({ type: 'bind', tabId: 1 })
    await peer.call({ type: 'bind', tabId: 2 })
    await otherSite.call({ type: 'bind', tabId: 3 })
    expect(source.snapshots().at(-1)).toMatchObject({ plans: [legacyPlan], entries: [legacyEntry], scenarios: [], ignores: [] })
    const target = source.snapshots().at(-1)?.target
    if (!target) throw new Error('No workbench target')

    runtime.reportReal(1)
    await vi.waitFor(() => expect(source.snapshots().at(-1)?.entries).toHaveLength(2))
    const prefix = { kind: 'prefix', path: '/assets' } as const
    const exact = { kind: 'endpoint', endpoint: rule.endpoint } as const
    expect(await source.call({ type: 'add-ignores', target, rules: [{ ...prefix, path: '/assets/' }, exact] })).toMatchObject({ ok: true })
    expect(peer.snapshots().at(-1)?.ignores).toEqual([prefix, exact])
    expect(otherSite.snapshots().at(-1)?.ignores).toEqual([])
    const archived = source.snapshots().at(-1)?.entries.find(entry => entry.key === endpointKey(rule.endpoint))?.last
    expect(archived?.phase).toBe('real')
    runtime.reportReal(1, rule.endpoint, 'request')

    const tile = { method: 'GET', origin: 'https://maps.test', path: '/assets/15/13/12.png' }
    const nearby = { ...tile, path: '/assets-v2/config.json' }
    runtime.reportReal(1, tile)
    runtime.reportReal(1, nearby)
    runtime.reportReal(3, tile)
    await vi.waitFor(() => {
      expect(source.snapshots().at(-1)?.entries.map(entry => entry.endpoint)).toEqual([rule.endpoint, nearby, importedEndpoint])
      expect(source.snapshots().at(-1)?.entries.find(entry => entry.key === endpointKey(rule.endpoint))?.last).toEqual(archived)
      expect(otherSite.snapshots().at(-1)?.entries.map(entry => entry.endpoint)).toEqual([tile])
    })

    const tileRule = { ...rule, id: 'map-test', endpoint: tile }
    expect(await source.call({ type: 'apply', target, rules: [tileRule] })).toMatchObject({ ok: true })
    runtime.reportReal(1, tile, 'request')
    await vi.waitFor(() => expect(source.snapshots().at(-1)?.entries.map(entry => entry.endpoint)).toContainEqual(tile))
    const freshTarget = source.snapshots().at(-1)?.target
    if (!freshTarget) throw new Error('No active workbench target')

    const scenario: CustomScenario = { id: 'rate-limit', name: '限流响应', response: { ...rule.response, status: 429, retryAfterSeconds: 30 } }
    expect(await source.call({ type: 'save-scenario', target: freshTarget, scenario })).toMatchObject({ ok: true })
    expect(otherSite.snapshots().at(-1)?.scenarios).toMatchObject([scenario])
    expect((await runtime.localStorage.get(localKey))[localKey]).toMatchObject({
      plans: [legacyPlan], imports, ignoresBySite: { [siteOrigin]: [prefix, exact] }, scenarios: [scenario],
    })

    expect(await source.call({ type: 'remove-ignores', target: freshTarget, keys: [ignoreKey(prefix), ignoreKey(exact)] })).toMatchObject({ ok: true })
    expect(await source.call({ type: 'delete-scenario', target: freshTarget, id: scenario.id })).toMatchObject({ ok: true })
    expect(peer.snapshots().at(-1)).toMatchObject({ ignores: [], scenarios: [] })
    expect((await runtime.localStorage.get(localKey))[localKey]).toMatchObject({ plans: [legacyPlan], imports, ignoresBySite: {}, scenarios: [] })
  })
})
