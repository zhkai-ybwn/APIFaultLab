import { defineBackground } from 'wxt/utils/define-background'
import {
  PAGE_BOOT_MESSAGE,
  PAGE_CONTROL_KEY,
  PANEL_PORT,
  SAMPLE_WINDOW_MS,
  type CatalogEntry,
  type CustomScenario,
  type Endpoint,
  type EntryResponseSources,
  type IgnoreRule,
  type PageCommand,
  type PageControl,
  type PageStatus,
  type PanelCommand,
  type PanelMessage,
  type PanelRequest,
  type PanelSnapshot,
  type PanelStatus,
  type PanelTarget,
  type RequestEvent,
  type ResponseSampleState,
  type RouteGrouping,
  type Rule,
  type RuleOutcome,
  type SavedPlan,
  type WorkerReport,
} from '../lib/model'
import { exportBackup, exportRescueData, mergeBackup, readBackup, readLocalData, salvageLocalData, type LocalData } from '../lib/backup'
import { createSessionCache, type CachedTabState } from '../lib/background-runtime/session-cache'
import { changeImportedDirectory } from '../lib/catalog-storage'
import type { LocalDataCommand, LocalDataRequest, LocalDataResponse } from '../lib/local-data-client'
import { createRequestUpdate, entryResponseSources, hasSamePanelTarget } from '../lib/panel-request-update'
import { classifyEndpoint, ignoreKey, matchesIgnore, normalizeIgnoreRule } from '../lib/request-filters'
import { endpointCovers, endpointKey, isValidHttpMethod, routeKey, validateRuleSet } from '../lib/rules'
import { normalizeCustomScenario } from '../lib/scenarios'

const LOCAL_KEY = 'apiFaultLabLocal_v1'
const SESSION_CACHE_WARNING = '当前会话无法保存。后台重新启动时，运行规则可能需要手动启用。'
const SESSION_OBSERVE_WARNING = '采集设置暂未保存。后台重新启动时可能恢复默认采集状态。'
const SESSION_INVALIDATION_WARNING = '无法清除缓存的规则。请重试，或关闭此标签页结束会话。'
const MAX_ROUTES = 24
const MAX_ENTRIES = 120
const MAX_SAMPLE = 512 * 1024
const REQUEST_PUBLISH_MS = 60
const DOCUMENT_RETRY_DELAYS = [100, 250, 500]
const PHASES = new Set(['request', 'real', 'mock', 'bypassed', 'delay', 'error', 'cancelled'])

interface DocumentTarget {
  tabId: number
  documentId: string
  pageUrl: string
  routeKey: string
  siteOrigin: string
}

interface SampleAttempt {
  id: string
  routeKey: string
  endpoint: Endpoint
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
}

interface TabSession extends DocumentTarget {
  id: string
  revision: number
  rules: Rule[]
  catalog: Map<string, Map<string, CatalogEntry>>
  ruleOutcomes?: Map<string, RuleOutcome>
  status: PanelStatus
  message?: string
  sessionWarning?: string
  needsSiteAccess?: boolean
  earlyAccess?: boolean
  startupArmed?: boolean
  startupState?: PageStatus['startupState']
  observing: boolean
  activeCount: number
  sampling?: SampleAttempt
  responseSample?: ResponseSampleState
  recoveryFocus?: { routeKey: string; endpoint: Endpoint }[]
  recoveryState?: 'awaiting-real' | 'real-confirmed'
  recoveryScope?: 'route' | 'tab'
}

interface PanelView {
  port: chrome.runtime.Port
  tabId?: number
  target?: PanelTarget | null
  responseSources?: Map<string, EntryResponseSources>
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作未完成。'
}

function emptySnapshot(status: PanelStatus, message?: string, pageUrl = ''): PanelSnapshot {
  return {
    target: null,
    pageUrl,
    siteOrigin: '',
    status,
    message,
    entries: [],
    rules: [],
    activeCount: 0,
    configuredCount: 0,
    observing: false,
    plans: [],
    ignores: [],
    scenarios: [],
  }
}

function post(view: PanelView, message: PanelMessage): boolean {
  try {
    view.port.postMessage(message)
    return true
  } catch {
    // The panel can close while a request is being processed.
    return false
  }
}

async function getDocument(tabId: number, groupingFor: (origin: string) => RouteGrouping = () => 'exact'): Promise<DocumentTarget | null> {
  const [tab, frame] = await Promise.all([
    chrome.tabs.get(tabId),
    // webNavigation can report the inspected page before the extension has scripting access.
    chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
  ])
  if (tab.incognito) return null
  if (!frame?.documentId) throw new Error('主页面正在切换。')
  if (!/^https?:\/\//i.test(frame.url)) return null
  const siteOrigin = new URL(frame.url).origin
  const pageUrl = routeKey(frame.url)
  const currentRoute = routeKey(frame.url, groupingFor(siteOrigin))
  return {
    tabId,
    documentId: frame.documentId,
    pageUrl,
    routeKey: currentRoute,
    siteOrigin,
  }
}

async function runControl(
  target: DocumentTarget, command: PageCommand, expectedRoute?: string, routeGrouping: RouteGrouping = 'exact',
): Promise<PageStatus | null> {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    world: 'MAIN',
    injectImmediately: true,
    args: [PAGE_CONTROL_KEY, command, expectedRoute ?? null, routeGrouping === 'ignore-query'],
    func: (key: string, message: PageCommand, expectedUrl: string | null, ignoreQuery: boolean) => {
      const here = new URL(location.href)
      const hash = ignoreQuery && here.hash.includes('?') ? here.hash.slice(0, here.hash.indexOf('?')) : here.hash
      const current = ignoreQuery
        ? `${here.origin}${here.pathname}${hash === '#' ? '' : hash}`
        : `${here.origin}${here.pathname}${here.search}${here.hash}`
      if (expectedUrl !== null && current !== expectedUrl) return null
      const control = (window as unknown as Record<string, unknown>)[key]
      if (typeof control !== 'function') return null
      return (control as PageControl)(message)
    },
  })
  if (execution?.documentId !== target.documentId || execution.frameId !== 0) return null
  const status = execution.result as PageStatus | undefined
  if (!status || typeof status.intact !== 'boolean' || !Number.isInteger(status.revision) ||
      !Number.isInteger(status.activeCount) || status.activeCount < 0 ||
      (status.session !== null && typeof status.session !== 'string') || typeof status.observing !== 'boolean') {
    return null
  }
  return status
}

function requireAck(status: PageStatus | null, sessionId: string, revision: number, count: number): PageStatus {
  if (!status?.intact || status.session !== sessionId || status.revision !== revision || status.activeCount !== count) {
    throw new Error('页面没有确认本次操作。请确认当前页面状态后重试。')
  }
  return status
}

function eventFromPage(report: WorkerReport, session: TabSession): RequestEvent | null {
  const event = report.event
  const endpoint = event?.endpoint
  if (report.session !== session.id || !event || !endpoint || !PHASES.has(event.phase) ||
      typeof event.routeKey !== 'string' || event.routeKey.length > 4000 ||
      typeof event.requestId !== 'string' || event.requestId.length > 120 ||
      !Number.isSafeInteger(event.revision) || event.revision < 0 || event.revision > session.revision ||
      !Number.isFinite(event.time) || !isValidHttpMethod(endpoint.method) ||
      typeof endpoint.origin !== 'string' || endpoint.origin.length > 500 ||
      typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/') || endpoint.path.length > 2000 ||
      /[?#\\]/.test(endpoint.path)) {
    return null
  }
  try {
    const origin = new URL(endpoint.origin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== endpoint.origin ||
        new URL(event.routeKey).origin !== session.siteOrigin || routeKey(event.routeKey) !== event.routeKey) {
      return null
    }
  } catch {
    return null
  }

  return {
    requestId: event.requestId,
    routeKey: event.routeKey,
    endpoint: { method: endpoint.method, origin: endpoint.origin, path: endpoint.path },
    phase: event.phase,
    time: event.time,
    revision: event.revision,
    status: Number.isInteger(event.status) ? event.status : undefined,
    contentType: typeof event.contentType === 'string' ? event.contentType.slice(0, 128) : undefined,
    detail: typeof event.detail === 'string' ? event.detail.slice(0, 300) : undefined,
    ruleId: typeof event.ruleId === 'string' ? event.ruleId.slice(0, 120) : undefined,
    sample: typeof event.sample === 'string' && event.sample.length <= MAX_SAMPLE ? event.sample : undefined,
    sampleId: typeof event.sampleId === 'string' && event.sampleId.length <= 120 ? event.sampleId : undefined,
  }
}

function endpointDefault(endpoint: Endpoint): CatalogEntry {
  return { key: endpointKey(endpoint), endpoint, imported: false, observed: false, realSeen: false, hitCount: 0 }
}

function clearSample(session: TabSession, outcome?: ResponseSampleState) {
  if (session.sampling?.timer !== undefined) clearTimeout(session.sampling.timer)
  session.sampling = undefined
  session.responseSample = outcome
}

function tracksIgnoredEndpoint(session: TabSession, route: string, endpoint: Endpoint): boolean {
  const matches = (item: { routeKey: string; endpoint: Endpoint }) =>
    item.routeKey === route && endpointCovers(item.endpoint, endpoint)
  const sampling = session.sampling
  return session.rules.some(matches) || Boolean(session.recoveryFocus?.some(matches)) ||
    Boolean(sampling && sampling.expiresAt >= Date.now() && matches(sampling)) ||
    Boolean(session.responseSample?.state === 'captured' && session.routeKey === route &&
      endpointCovers(session.responseSample.endpoint, endpoint))
}

function recordRequest(session: TabSession, event: RequestEvent, ignores: IgnoreRule[]): boolean {
  const endpoint = event.endpoint
  const key = endpointKey(endpoint)
  const group = session.catalog.get(event.routeKey)
  const previous = group?.get(key)
  const stoppedInFlight = event.phase === 'cancelled' && event.revision === session.revision - 1 &&
    (session.status === 'observing' || session.status === 'active') && session.recoveryFocus?.some(rule =>
      rule.routeKey === event.routeKey && endpointCovers(rule.endpoint, endpoint)) && !previous?.last
  if (event.revision < session.revision && event.phase !== 'real' && !stoppedInFlight) return false
  if (!session.observing && !previous && !event.ruleId) return false

  if (!event.ruleId && ignores.some(rule => matchesIgnore(rule, endpoint)) &&
      !tracksIgnoredEndpoint(session, event.routeKey, endpoint)) return false

  const entry: CatalogEntry = previous ?? endpointDefault(endpoint)
  const nextGroup = group ?? new Map<string, CatalogEntry>()
  const { sample, sampleId, ...summary } = event
  const attempt = session.sampling
  if (sampleId !== undefined) {
    if (!attempt || sampleId !== attempt.id || event.phase !== 'real' || event.revision !== session.revision ||
        attempt.routeKey !== event.routeKey || attempt.expiresAt < Date.now() || !endpointCovers(attempt.endpoint, endpoint)) return false
    if (sample !== undefined) {
      const sampledKey = endpointKey(attempt.endpoint)
      const sampled = sampledKey === key ? entry : nextGroup.get(sampledKey) ?? endpointDefault(attempt.endpoint)
      sampled.sample = sample
      nextGroup.set(sampledKey, sampled)
      clearSample(session, { endpoint: attempt.endpoint, state: 'captured', message: '已采集真实响应。' })
    } else {
      clearSample(session, { endpoint: attempt.endpoint, state: 'failed', message: event.detail ?? '无法读取响应样本。' })
    }
  }
  entry.observed = true
  entry.realSeen ||= event.phase === 'real'
  entry.contentType = event.phase === 'real' || !entry.contentType ? event.contentType ?? entry.contentType : entry.contentType
  if (event.phase === 'mock' && event.revision === session.revision &&
      !(entry.last?.phase === 'mock' && entry.last.requestId === event.requestId)) {
    entry.hitCount += 1
  }
  if (sampleId === undefined && (event.revision === session.revision || stoppedInFlight)) entry.last = summary

  nextGroup.set(key, entry)
  while (nextGroup.size > MAX_ENTRIES) {
    const evictable = [...nextGroup].filter(([, item]) => !tracksIgnoredEndpoint(session, event.routeKey, item.endpoint))
    const victim = evictable.find(([, item]) => ignores.some(rule => matchesIgnore(rule, item.endpoint))) ??
      evictable.find(([, item]) => classifyEndpoint(item) !== 'api') ?? evictable[0]
    nextGroup.delete(victim?.[0] ?? nextGroup.keys().next().value!)
  }
  session.catalog.delete(event.routeKey)
  session.catalog.set(event.routeKey, nextGroup)
  if (session.catalog.size > MAX_ROUTES) session.catalog.delete(session.catalog.keys().next().value!)
  return true
}

function clearCurrentResults(session: TabSession): void {
  session.ruleOutcomes = undefined
  for (const group of session.catalog.values()) {
    for (const entry of group.values()) {
      entry.last = undefined
      entry.hitCount = 0
    }
  }
}

function canPersistRoute(key: string): boolean {
  const url = new URL(key)
  return !url.search && !url.hash.includes('?') && !url.hash.includes('=')
}

function canPersistEndpoint(endpoint: Endpoint): boolean {
  return !/\/(?:session[-_]?token|access[-_]?token|password|api[-_]?key)(?:\/|$)|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(endpoint.path)
}

function snapshotEntries(session: TabSession, data: LocalData): CatalogEntry[] {
  const observed = Array.from(session.catalog.get(session.routeKey)?.values() ?? [])
  const siteImports = data.imports.filter(item => item.siteOrigin === session.siteOrigin)
  const assigned = new Map(siteImports.filter(item => item.routeKey === session.routeKey)
    .map(item => [item.entry.key, item.entry]))
  const scoped = new Map(assigned)
  const documented = new Map(siteImports.map(item => [item.entry.key, item.entry]))
  const merged = observed.map(entry => {
    let source = assigned.get(entry.key) ?? documented.get(entry.key)
    if (!source) {
      const templates = Array.from(documented.values()).filter(item => item.endpoint.template && endpointCovers(item.endpoint, entry.endpoint))
      if (templates.length === 1) source = templates[0]
    }
    if (!source) return entry
    assigned.delete(entry.key)
    return {
      ...entry, imported: true, title: source.title, example: source.example,
      operations: scoped.get(source.key)?.operations, contentType: entry.contentType ?? source.contentType,
    }
  })
  const entries = [...merged, ...assigned.values()]
  const visibleKeys = new Set(entries.map(entry => entry.key))
  for (const rule of session.rules) {
    if (rule.routeKey !== session.routeKey) continue
    const key = endpointKey(rule.endpoint)
    if (visibleKeys.has(key)) continue
    entries.push(scoped.get(key) ?? endpointDefault(rule.endpoint))
    visibleKeys.add(key)
  }
  return entries
}

function recordRuleOutcome(session: TabSession, event: RequestEvent): void {
  const { ruleId, phase, requestId, status } = event
  if (!ruleId || event.revision !== session.revision ||
      (phase !== 'mock' && phase !== 'delay' && phase !== 'error' && phase !== 'cancelled') ||
      !session.rules.some(rule => rule.id === ruleId && rule.routeKey === event.routeKey)) return
  const outcomes = session.ruleOutcomes ??= new Map()
  const previous = outcomes.get(ruleId)
  const newHit = phase === 'mock' && (previous?.phase !== 'mock' || previous.requestId !== requestId)
  outcomes.set(ruleId, { ruleId, requestId, phase, status, hitCount: (previous?.hitCount ?? 0) + Number(newHit) })
}

function matchPattern(origin: string): string {
  const url = new URL(origin)
  return `${url.protocol}//${url.hostname}/*`
}

async function enableEarlyAccess(origin: string): Promise<void> {
  const pattern = matchPattern(origin)
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    throw new Error('请先授权当前测试站点，再启用首屏接入。')
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pattern))
  const id = `api-fault-lab-${Array.from(new Uint8Array(digest).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('')}`
  const bridgeId = `${id}-bridge`
  const ids = [id, bridgeId]
  const registered = new Set((await chrome.scripting.getRegisteredContentScripts({ ids })).map(script => script.id))
  const scripts: chrome.scripting.RegisteredContentScript[] = [
    { id, matches: [pattern], js: ['page-main.js'], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: false },
    { id: bridgeId, matches: [pattern], js: ['page-bridge.js'], world: 'ISOLATED', runAt: 'document_start', persistAcrossSessions: false },
  ]
  const missing = scripts.filter(script => !registered.has(script.id))
  if (!missing.length) return
  try {
    await chrome.scripting.registerContentScripts(missing)
  } catch (reason) {
    if ((await chrome.scripting.getRegisteredContentScripts({ ids })).length !== ids.length) throw reason
  }
}

export default defineBackground(() => {
  const sessions = new Map<number, TabSession>()
  const panels = new Map<chrome.runtime.Port, PanelView>()
  const tabQueues = new Map<number, Promise<unknown>>()
  const documentRetries = new Map<number, { attempt: number; timer?: ReturnType<typeof setTimeout> }>()
  const sessionCache = createSessionCache()
  let localData = readLocalData()
  let storageError: string | undefined
  let storageRescueAvailable = false
  let writingLocal: Promise<unknown> = Promise.resolve()
  let cacheTimer: ReturnType<typeof setTimeout> | undefined

  function queueLocal<T>(operation: () => Promise<T>): Promise<T> {
    const queued = writingLocal.catch(() => {}).then(operation)
    writingLocal = queued
    return queued
  }

  function loadLocal(): Promise<void> {
    return queueLocal(async () => {
      storageRescueAvailable = false
      try {
        const values = await chrome.storage.local.get(LOCAL_KEY)
        try {
          localData = readLocalData(values[LOCAL_KEY])
        } catch {
          storageError = '本地配置格式无法识别，已暂停写入以保留数据。'
          storageRescueAvailable = Object.hasOwn(values, LOCAL_KEY)
          return
        }
        storageError = undefined
      } catch {
        storageError = '本地数据读取失败，已暂停写入。请重试读取。'
      }
    })
  }

  const restored = Promise.all([
    loadLocal(),
    sessionCache.load().then(({ states, catalog, warnings }) => {
      for (const item of states.values()) {
        const groups = catalog.get(item.tabId) ?? []
        sessions.set(item.tabId, {
          ...item,
          sessionWarning: warnings.has(item.tabId) ? SESSION_CACHE_WARNING : undefined,
          catalog: new Map(groups.map(([key, entries]) => [key, new Map(entries.map(entry => [entry.key, entry]))])),
        })
      }
    }).catch(() => {}),
  ])

  function enqueue<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const last = tabQueues.get(tabId) ?? Promise.resolve()
    const queued = last.catch(() => {}).then(operation)
    tabQueues.set(tabId, queued)
    void queued.finally(() => {
      if (tabQueues.get(tabId) === queued) tabQueues.delete(tabId)
    }).catch(() => {})
    return queued
  }

  function routeGroupingFor(origin: string): RouteGrouping {
    return localData.routeGroupingBySite?.[origin] ?? 'exact'
  }

  async function cacheSession(session: TabSession) {
    const { tabId, documentId, pageUrl, routeKey: sessionRoute, siteOrigin, id, revision, rules, status, observing, activeCount, earlyAccess } = session
    const safeUrl = canPersistRoute(pageUrl) ? pageUrl : `${siteOrigin}/`
    const safeRoute = canPersistRoute(sessionRoute) ? sessionRoute : safeUrl
    const state: CachedTabState = { tabId, documentId, pageUrl: safeUrl, routeKey: safeRoute, siteOrigin, id, revision, rules, status, observing, activeCount, earlyAccess }
    try {
      await sessionCache.save(state)
      session.sessionWarning = undefined
    } catch {
      session.sessionWarning = session.rules.length ? SESSION_CACHE_WARNING : SESSION_OBSERVE_WARNING
    }
  }

  async function invalidateSession(session: TabSession) {
    try {
      await sessionCache.invalidate(session.tabId)
    } catch {
      session.sessionWarning = SESSION_INVALIDATION_WARNING
      throw new Error(SESSION_INVALIDATION_WARNING)
    }
  }

  function* catalogForStorage(): Generator<[number, Iterable<[string, Iterable<CatalogEntry>]>]> {
    for (const session of sessions.values()) {
      function* groups(): Generator<[string, Iterable<CatalogEntry>]> {
        for (const [key, entries] of Array.from(session.catalog.entries()).reverse()) {
          if (!canPersistRoute(key)) continue
          const safeEntries = function* () {
            for (const { sample: _sample, ...entry } of Array.from(entries.values()).reverse()) {
              if (canPersistEndpoint(entry.endpoint)) yield entry
            }
          }
          yield [key, safeEntries()]
        }
      }
      yield [session.tabId, groups()]
    }
  }

  function scheduleCache(): void {
    if (cacheTimer) return
    cacheTimer = setTimeout(() => {
      cacheTimer = undefined
      void sessionCache.saveCatalog(catalogForStorage)
    }, 200)
  }

  function requireLocalData(): LocalData {
    if (storageError) throw new Error(storageError)
    return localData
  }

  async function commitLocal(next: LocalData): Promise<void> {
    if (next !== localData) {
      try {
        await chrome.storage.local.set({ [LOCAL_KEY]: next })
      } catch (reason) {
        const quota = /quota/i.test(errorMessage(reason))
        throw new Error(quota ? 'Chrome 本地存储空间不足，已有数据已保留。' : '本地保存失败，已有数据已保留。请重试。')
      }
      localData = next
    }
  }

  function updateLocal(mutate: (previous: LocalData) => LocalData): Promise<void> {
    return queueLocal(async () => {
      await commitLocal(readLocalData(mutate(requireLocalData())))
    })
  }

  function publishSession(session: TabSession, requestOnly = false): void {
    const rules = session.rules.filter(rule => rule.routeKey === session.routeKey)
    const snapshot: PanelSnapshot = {
      target: { tabId: session.tabId, documentId: session.documentId, routeKey: session.routeKey, revision: session.revision },
      pageUrl: session.pageUrl,
      siteOrigin: session.siteOrigin,
      status: session.status,
      message: session.message,
      storageError,
      storageRescueAvailable,
      needsSiteAccess: session.needsSiteAccess,
      earlyAccess: session.earlyAccess,
      startupArmed: session.startupArmed,
      startupState: session.startupState,
      sessionWarning: session.sessionWarning,
      recoveryState: session.recoveryState,
      recoveryScope: session.recoveryScope,
      responseSample: session.responseSample,
      entries: snapshotEntries(session, localData),
      rules,
      ruleOutcomes: rules.flatMap(rule => {
        const outcome = session.ruleOutcomes?.get(rule.id)
        return outcome ? [outcome] : []
      }),
      catalogAtCapacity: (session.catalog.get(session.routeKey)?.size ?? 0) >= MAX_ENTRIES,
      activeCount: session.activeCount,
      configuredCount: session.rules.length,
      observing: session.observing,
      plans: localData.plans.filter(plan => plan.siteOrigin === session.siteOrigin),
      importedEntries: requestOnly ? undefined : localData.imports
        .filter(item => item.siteOrigin === session.siteOrigin && item.routeKey === session.routeKey)
        .map(({ entry }) => ({ ...entry, example: undefined })),
      ignores: localData.ignoresBySite[session.siteOrigin] ?? [],
      scenarios: localData.scenarios,
      routeGrouping: routeGroupingFor(session.siteOrigin),
    }
    const responseSources = entryResponseSources(snapshot.entries)
    for (const view of panels.values()) {
      if (view.tabId !== session.tabId) continue
      const target = snapshot.target!
      const sent = requestOnly && view.responseSources && hasSamePanelTarget(view.target, target)
        ? post(view, { type: 'request-update', update: createRequestUpdate(snapshot, target, view.responseSources, responseSources) })
        : post(view, { type: 'snapshot', snapshot })
      if (sent) {
        view.target = target
        view.responseSources = responseSources
      } else {
        view.target = null
        view.responseSources = undefined
      }
    }
  }

  const requestPublishTimers = new Map<number, ReturnType<typeof setTimeout>>()

  function scheduleRequestPublish(tabId: number): void {
    if (requestPublishTimers.has(tabId)) return
    requestPublishTimers.set(tabId, setTimeout(() => {
      requestPublishTimers.delete(tabId)
      const session = sessions.get(tabId)
      if (session && Array.from(panels.values()).some(view => view.tabId === tabId)) publishSession(session, true)
    }, REQUEST_PUBLISH_MS))
  }

  function publishOtherPreferenceViews(session: TabSession, siteOnly: boolean): void {
    const visibleTabs = new Set(Array.from(panels.values(), view => view.tabId))
    for (const tabId of visibleTabs) {
      if (tabId === undefined || tabId === session.tabId) continue
      const affected = sessions.get(tabId)
      if (affected && (!siteOnly || affected.siteOrigin === session.siteOrigin)) publishSession(affected)
    }
  }

  function publishLocalState(): void {
    const tabs = new Set(Array.from(panels.values(), view => view.tabId))
    for (const tabId of tabs) {
      if (tabId === undefined) continue
      const session = sessions.get(tabId)
      if (session) publishSession(session)
      else publishUnavailable(tabId)
    }
  }

  async function handleLocalData(command: LocalDataCommand): Promise<LocalDataResponse> {
    if (command?.type === 'retry-storage') {
      await loadLocal()
      publishLocalState()
      requireLocalData()
      return { ok: true, value: undefined }
    }
    return queueLocal(async () => {
      if (command?.type === 'export-rescue') {
        if (!storageRescueAvailable) throw new Error('当前没有可读取的异常配置，请先重试读取。')
        if (command.mode !== 'raw' && command.mode !== 'readable') throw new Error('备份方式无法识别。')
        const values = await chrome.storage.local.get(LOCAL_KEY)
        if (!Object.hasOwn(values, LOCAL_KEY)) throw new Error('找不到原始配置，请先重试读取。')
        const raw: unknown = values[LOCAL_KEY]
        if (command.mode === 'raw') {
          return { ok: true, value: { json: exportRescueData(raw), recovered: 0, skipped: 0 } }
        }
        const { data, recovered, skipped } = salvageLocalData(raw)
        if (!recovered) throw new Error('没有可恢复的条目。请保留原始 JSON 以便检查。')
        return { ok: true, value: { json: exportBackup(data), recovered, skipped } }
      }
      const current = requireLocalData()
      if (command?.type === 'export-backup') return { ok: true, value: { json: exportBackup(current) } }
      if (command?.type !== 'preview-backup' && command?.type !== 'restore-backup') {
        throw new Error('本地数据操作无法识别。')
      }
      const { data, preview } = await mergeBackup(current, readBackup(command.json))
      if (command.type === 'restore-backup') {
        if (preview.confirmation !== command.preview?.confirmation) throw new Error('本地数据已变化，请重新预览备份。')
        await commitLocal(data)
        publishLocalState()
      }
      return { ok: true, value: preview }
    })
  }

  function badge(session: TabSession): void {
    const badgeText = session.status === 'uncertain' ? '!' : session.activeCount ? String(session.activeCount) : ''
    void chrome.action.setBadgeText({ tabId: session.tabId, text: badgeText }).catch(() => {})
  }

  async function connectDocument(session: TabSession): Promise<void> {
    let current = await runControl(session, { type: 'status' })
    const target = { tabId: session.tabId, documentIds: [session.documentId] }
    if (!current?.intact) {
      await Promise.all([
        chrome.scripting.executeScript({ target, files: ['page-main.js'], world: 'MAIN', injectImmediately: true }),
        chrome.scripting.executeScript({ target, files: ['page-bridge.js'], world: 'ISOLATED', injectImmediately: true }),
      ])
      current = await runControl(session, { type: 'status' })
    } else {
      await chrome.scripting.executeScript({ target, files: ['page-bridge.js'], world: 'ISOLATED', injectImmediately: true })
    }

    if (current) {
      session.activeCount = current.activeCount
      session.startupState = current.startupState
    }
    if (!current?.intact) throw new Error('页面接入未就绪，请重新连接或刷新被测页面。')
    const grouping = routeGroupingFor(session.siteOrigin)
    if (!current.session || (current.session !== session.id && current.activeCount === 0)) {
      if (session.rules.length && session.status !== 'restoring') {
        session.status = 'restoring'
        session.message = '正在恢复本次会话的模拟规则。'
        publishSession(session)
      }
      current = requireAck(await runControl(session, {
        type: 'configure', session: session.id, siteOrigin: session.siteOrigin,
        revision: session.revision, observing: session.observing, rules: session.rules, routeGrouping: grouping,
      }), session.id, session.revision, session.rules.length)
    } else if (current.session === session.id && current.revision === session.revision && current.activeCount === session.rules.length) {
      if ((current.routeGrouping ?? 'exact') !== grouping) {
        const nextRevision = session.revision + 1
        current = requireAck(await runControl(session, {
          type: 'configure', session: session.id, siteOrigin: session.siteOrigin,
          revision: nextRevision, observing: session.observing, rules: session.rules, routeGrouping: grouping,
        }), session.id, nextRevision, session.rules.length)
        session.revision = nextRevision
      } else if (current.observing !== session.observing) {
        current = requireAck(await runControl(session, { type: 'observe', session: session.id, enabled: session.observing }),
          session.id, session.revision, session.rules.length)
      }
    } else {
      throw new Error('页面规则状态未确认。请先停止模拟，再重新启用。')
    }

    session.observing = current.observing
    session.activeCount = current.activeCount
    session.startupArmed = current.startupArmed
    session.startupState = current.startupState
    session.status = current.activeCount ? 'active' : 'observing'
    session.message = undefined
    session.needsSiteAccess = undefined
  }

  function showConnectionFailure(session: TabSession, reason: unknown): void {
    const message = errorMessage(reason)
    session.needsSiteAccess = /cannot access contents of (?:the page|url)|must request permission|missing host permission/i.test(message)
    session.status = session.activeCount ? 'uncertain' : 'unavailable'
    session.message = session.needsSiteAccess
      ? '需要授权当前站点才能接入页面。'
      : message
  }

  function publishUnavailable(tabId: number): void {
    for (const view of panels.values()) {
      if (view.tabId === tabId) {
        const snapshot = emptySnapshot('unavailable', '当前标签页不支持接入。请切到测试网页后重试。')
        post(view, { type: 'snapshot', snapshot: { ...snapshot, storageError, storageRescueAvailable } })
        view.target = null
        view.responseSources = undefined
      }
    }
  }

  function clearDocumentRetry(tabId: number): void {
    const retry = documentRetries.get(tabId)
    if (retry?.timer !== undefined) clearTimeout(retry.timer)
    documentRetries.delete(tabId)
  }

  function scheduleDocumentRetry(tabId: number, boot = false): boolean {
    const retry = documentRetries.get(tabId) ?? { attempt: 0 }
    if (retry.timer !== undefined) return true
    const delay = DOCUMENT_RETRY_DELAYS[retry.attempt]
    if (delay === undefined) return false
    retry.attempt += 1
    documentRetries.set(tabId, retry)
    retry.timer = setTimeout(() => {
      retry.timer = undefined
      void refreshTab(tabId, { force: true, boot }).catch(() => {})
    }, delay)
    return true
  }

  async function refreshTab(tabId: number, options: { force?: boolean; boot?: boolean; committed?: { url: string; documentId: string } } = {}): Promise<boolean | undefined> {
    await restored
    return enqueue(tabId, async () => {
      let session = sessions.get(tabId)
      const hasView = Array.from(panels.values()).some(view => view.tabId === tabId)
      if (!session && !hasView && !options.boot) {
        clearDocumentRetry(tabId)
        return
      }
      if (options.committed && session && new URL(options.committed.url).origin !== session.siteOrigin) {
        // Clear on the actual transition even if a second navigation is already in progress.
        sessions.delete(tabId)
        session = undefined
        void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
        await sessionCache.invalidate(tabId).catch(() => {})
      }
      // A frame lookup can briefly fail while Chrome is replacing the main document.
      // Leave the last usable snapshot in place until a later navigation event can refresh it.
      const target = await getDocument(tabId, routeGroupingFor).catch(() => undefined)
      if (target === undefined) {
        const retrying = scheduleDocumentRetry(tabId, options.boot)
        if (session) {
          if (!retrying) showConnectionFailure(session, new Error('Chrome 暂未提供页面状态，请重新连接。'))
          publishSession(session)
        } else if (!retrying && hasView) publishUnavailable(tabId)
        return
      }
      if (options.committed && target && options.committed.documentId !== target.documentId) {
        scheduleDocumentRetry(tabId, options.boot)
        return
      }
      clearDocumentRetry(tabId)
      if (!target) {
        publishUnavailable(tabId)
        return
      }
      if (session?.siteOrigin !== target.siteOrigin) {
        if (session) {
          sessions.delete(tabId)
          void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
          await sessionCache.invalidate(tabId).catch(() => {})
        }
        if (!hasView && !options.boot) {
          scheduleCache()
          return
        }
        session = {
          ...target, id: crypto.randomUUID(), revision: 0, rules: [], catalog: new Map(),
          status: 'loading', observing: true, activeCount: 0,
        }
        sessions.set(tabId, session)
      } else {
        if (session.documentId !== target.documentId) {
          session.revision += 1
          session.activeCount = 0
          session.status = session.rules.length ? 'restoring' : 'loading'
          session.startupState = undefined
          session.message = session.rules.length ? '正在恢复本次会话的模拟规则。' : undefined
          session.needsSiteAccess = undefined
          session.recoveryFocus = undefined
          session.recoveryState = undefined
          session.recoveryScope = undefined
          clearCurrentResults(session)
          clearSample(session)
        } else if (session.routeKey !== target.routeKey) {
          clearSample(session)
          session.recoveryFocus = undefined
          session.recoveryState = undefined
          session.recoveryScope = undefined
        }
        Object.assign(session, target)
      }

      publishSession(session)
      const needsConnection = options.force || !['active', 'observing'].includes(session.status)
      let confirmed = false
      if (needsConnection && (session.observing || session.rules.length || hasView)) {
        try {
          await connectDocument(session)
          confirmed = true
          await cacheSession(session)
        } catch (reason) {
          showConnectionFailure(session, reason)
        }
      }
      publishSession(session)
      badge(session)
      scheduleCache()
      return confirmed
    })
  }

  async function applyRules(session: TabSession, incoming: Rule[]): Promise<void> {
    if (!Array.isArray(incoming) || incoming.some(rule => rule?.routeKey !== session.routeKey)) {
      throw new Error('提交的规则和当前页面不一致。')
    }
    const rules = [...session.rules.filter(rule => rule.routeKey !== session.routeKey), ...incoming]
    validateRuleSet(rules)
    if (rules.length && !session.earlyAccess) {
      try {
        await enableEarlyAccess(session.siteOrigin)
        session.earlyAccess = true
      } catch { /* Temporary site access still allows simulation in this document. */ }
    }
    const revision = session.revision + 1
    await invalidateSession(session)
    session.status = 'applying'
    publishSession(session)
    try {
      const grouping = routeGroupingFor(session.siteOrigin)
      const status = requireAck(await runControl(session, {
        type: 'configure', session: session.id, siteOrigin: session.siteOrigin, revision, observing: session.observing, rules,
        overrideStartup: true, routeGrouping: grouping,
      }, session.routeKey, grouping), session.id, revision, rules.length)
      session.startupArmed = status.startupArmed
      session.startupState = status.startupState
    } catch (reason) {
      session.status = 'uncertain'
      session.message = errorMessage(reason)
      if (session.rules.length) session.sessionWarning = SESSION_CACHE_WARNING
      badge(session)
      throw reason
    }
    session.rules = rules
    session.revision = revision
    session.activeCount = rules.length
    session.recoveryFocus = undefined
    session.recoveryState = undefined
    session.recoveryScope = undefined
    session.status = rules.length ? 'active' : 'observing'
    session.message = undefined
    clearSample(session)
    clearCurrentResults(session)
    badge(session)
    await cacheSession(session)
  }

  async function stopRules(session: TabSession, replacedDocument = false): Promise<void> {
    const previouslyActive = session.rules.map(({ routeKey: ruleRoute, endpoint }) => ({ routeKey: ruleRoute, endpoint }))
    // A stop request cancels restoration even if the old document disappears before acknowledging.
    await invalidateSession(session)
    session.rules = []
    session.status = 'stopping'
    publishSession(session)
    try {
      const current = await runControl(session, { type: 'status' })
      if (!current && !replacedDocument) throw new Error('停止未确认。请重新连接页面后重试。')
      if (current?.session) {
        const revision = current.revision + 1
        const status = await runControl(session, {
          type: 'stop', session: current.session, revision,
        })
        if (!status || status.session !== current.session || status.revision !== revision || status.activeCount !== 0) {
          throw new Error('页面尚未确认停止。请重新连接页面后重试。')
        }
        session.id = current.session
        session.revision = status.revision
        session.observing = status.observing
        session.startupArmed = status.startupArmed
        session.startupState = status.startupState
      } else {
        session.revision += 1
      }
      session.status = replacedDocument ? 'loading' : current?.intact ? 'observing' : 'unavailable'
    } catch (reason) {
      session.status = 'uncertain'
      session.message = '停止未确认。请检查当前页面后重试。'
      badge(session)
      throw reason
    }
    session.activeCount = 0
    session.recoveryState = session.observing && session.status === 'observing' ? 'awaiting-real' : undefined
    session.recoveryScope = 'tab'
    session.message = session.status === 'unavailable'
      ? '模拟已停止，请重新连接页面。'
      : session.recoveryState ? undefined : '模拟已停止。'
    session.recoveryFocus = previouslyActive
    clearSample(session)
    clearCurrentResults(session)
    badge(session)
    await cacheSession(session)
  }

  async function stopRouteRules(session: TabSession): Promise<void> {
    const stoppedRules = session.rules.filter(rule => rule.routeKey === session.routeKey)
    if (!stoppedRules.length) return
    await applyRules(session, [])
    session.recoveryFocus = stoppedRules.map(({ routeKey, endpoint }) => ({ routeKey, endpoint }))
    session.recoveryState = session.observing ? 'awaiting-real' : undefined
    session.recoveryScope = 'route'
    if (!session.observing) session.message = '已停止本页规则。'
  }

  async function setObserving(session: TabSession, enabled: boolean): Promise<void> {
    await invalidateSession(session)
    try {
      const acknowledged = requireAck(await runControl(session, { type: 'observe', session: session.id, enabled }),
        session.id, session.revision, session.rules.length)
      if (acknowledged.observing !== enabled) throw new Error('页面尚未确认采集状态，请重试。')
    } catch (reason) {
      if (session.rules.length) session.sessionWarning = SESSION_CACHE_WARNING
      throw reason
    }
    session.observing = enabled
    if (!enabled) {
      clearSample(session)
      session.recoveryState = undefined
      session.recoveryFocus = undefined
      session.recoveryScope = undefined
    }
    session.message = enabled ? undefined : '已暂停采集，新请求不会加入列表。'
    await cacheSession(session)
  }

  async function startSample(session: TabSession, endpoint: Endpoint): Promise<void> {
    if (!session.observing) throw new Error('请先继续采集，再采集响应样本。')
    if (!['observing', 'active'].includes(session.status)) throw new Error('请确认页面连接后再采集响应样本。')
    const routeKey = session.routeKey
    if (session.rules.some(rule => rule.routeKey === routeKey && rule.conditions.length === 0 &&
      (endpointKey(rule.endpoint) === endpointKey(endpoint) || !endpoint.template && endpointCovers(rule.endpoint, endpoint)))) {
      throw new Error('该接口的所有操作均被模拟。请停用对应规则后再采集真实响应。')
    }
    const attempt: SampleAttempt = { id: crypto.randomUUID(), routeKey, endpoint, expiresAt: Date.now() + SAMPLE_WINDOW_MS }
    clearSample(session)
    try {
      const grouping = routeGroupingFor(session.siteOrigin)
      const status = requireAck(await runControl(session, {
        type: 'sample', session: session.id, id: attempt.id, endpoint, routeKey, expiresAt: attempt.expiresAt,
      }, routeKey, grouping), session.id, session.revision, session.activeCount)
      if (status.sampleId !== attempt.id) throw new Error('页面未确认采样，请检查页面连接后重试。')
    } catch (error) {
      clearSample(session, { endpoint, state: 'failed', message: errorMessage(error) })
      throw error
    }
    session.sampling = attempt
    session.responseSample = {
      endpoint, state: 'waiting',
      message: '请在 20 秒内触发一次真实请求。该操作已启用模拟时，请先停用对应规则。',
    }
    attempt.timer = setTimeout(() => {
      void enqueue(session.tabId, async () => {
        if (sessions.get(session.tabId) !== session || session.sampling?.id !== attempt.id) return
        clearSample(session, { endpoint, state: 'expired', message: '未在 20 秒内收到此接口的真实响应。请重新采集。' })
        publishSession(session, true)
      }).catch(() => {})
    }, Math.max(0, attempt.expiresAt - Date.now()))
  }

  async function updateImportedDirectory(session: TabSession, command: Extract<PanelCommand, { type: 'import' | 'delete-imports' }>): Promise<void> {
    await updateLocal(data => ({ ...data, imports: changeImportedDirectory(data.imports, session, command) }))
    publishOtherPreferenceViews(session, true)
  }

  async function savePlan(session: TabSession, plan: SavedPlan, expectedUpdatedAt?: number | null): Promise<void> {
    if (!plan.name.trim() || plan.siteOrigin !== session.siteOrigin || plan.routeKey !== session.routeKey ||
        plan.rules.some(rule => rule.routeKey !== session.routeKey)) {
      throw new Error('请输入名称，并确认方案属于当前页面。')
    }
    validateRuleSet(plan.rules)
    await updateLocal(data => {
      const existing = data.plans.find(item => item.id === plan.id)
      if (existing && (existing.siteOrigin !== session.siteOrigin || existing.routeKey !== session.routeKey)) {
        throw new Error('检测到另一个页面使用同一方案标识，请另存副本。')
      }
      if (expectedUpdatedAt !== undefined && (existing?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error('已保存的方案发生了变化。请另存副本，或放弃草稿后重新编辑。')
      }
      const updatedAt = Math.max(Date.now(), Math.min((existing?.updatedAt ?? 0) + 1, Number.MAX_SAFE_INTEGER))
      return {
        ...data,
        plans: [{ ...plan, name: plan.name.trim(), updatedAt }, ...data.plans.filter(item => item.id !== plan.id)],
      }
    })
    publishOtherPreferenceViews(session, true)
  }

  async function updateIgnores(session: TabSession, change: { rules: IgnoreRule[] } | { keys: string[] }): Promise<void> {
    const additions = new Map<string, IgnoreRule>()
    const removals = new Set<string>()
    if ('rules' in change) {
      if (!Array.isArray(change.rules)) throw new Error('忽略规则格式无效。')
      for (const rule of change.rules) {
        const normalized = normalizeIgnoreRule(rule)
        additions.set(ignoreKey(normalized), normalized)
      }
    } else {
      if (!Array.isArray(change.keys) || change.keys.some(key => typeof key !== 'string')) {
        throw new Error('需要选择要移除的忽略规则。')
      }
      for (const key of change.keys) removals.add(key)
    }
    await updateLocal(data => {
      const ignoresBySite = { ...data.ignoresBySite }
      const next = new Map((ignoresBySite[session.siteOrigin] ?? []).map(rule => [ignoreKey(rule), rule]))
      for (const key of removals) next.delete(key)
      for (const [key, rule] of additions) next.set(key, rule)
      if (next.size) ignoresBySite[session.siteOrigin] = [...next.values()]
      else delete ignoresBySite[session.siteOrigin]
      return { ...data, ignoresBySite }
    })
    publishOtherPreferenceViews(session, true)
  }

  async function saveScenario(session: TabSession, input: CustomScenario): Promise<void> {
    const scenario = normalizeCustomScenario(input)
    await updateLocal(data => {
      const exists = data.scenarios.some(item => item.id === scenario.id)
      const scenarios = exists ? data.scenarios.map(item => item.id === scenario.id ? scenario : item) : [...data.scenarios, scenario]
      return { ...data, scenarios }
    })
    publishOtherPreferenceViews(session, false)
  }

  async function deleteScenario(session: TabSession, id: string): Promise<void> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('需要选择要删除的场景。')
    await updateLocal(data => ({ ...data, scenarios: data.scenarios.filter(scenario => scenario.id !== id) }))
    publishOtherPreferenceViews(session, false)
  }

  async function setRouteGrouping(session: TabSession, mode: RouteGrouping): Promise<void> {
    if (mode !== 'exact' && mode !== 'ignore-query') throw new Error('页面归组方式无效。')
    await updateLocal(data => {
      const next = { ...data.routeGroupingBySite }
      if (mode === 'ignore-query') next[session.siteOrigin] = mode
      else delete next[session.siteOrigin]
      const { routeGroupingBySite: _prev, ...rest } = data
      return Object.keys(next).length ? { ...rest, routeGroupingBySite: next } : rest
    })
    const previousRoute = session.routeKey
    const nextRoute = routeKey(session.pageUrl, mode)
    if (nextRoute !== previousRoute) {
      const existing = session.catalog.get(previousRoute)
      if (existing?.size) {
        const targetGroup = session.catalog.get(nextRoute) ?? new Map<string, CatalogEntry>()
        for (const [key, entry] of existing) {
          if (!targetGroup.has(key) && targetGroup.size < MAX_ENTRIES) targetGroup.set(key, { ...entry })
        }
        session.catalog.delete(nextRoute)
        session.catalog.set(nextRoute, targetGroup)
      }
      session.routeKey = nextRoute
      clearSample(session)
      session.recoveryFocus = undefined
      session.recoveryState = undefined
      session.recoveryScope = undefined
    }
    if (['observing', 'active'].includes(session.status)) {
      const revision = session.revision + 1
      await invalidateSession(session)
      try {
        const status = requireAck(await runControl(session, {
          type: 'configure', session: session.id, siteOrigin: session.siteOrigin, revision,
          observing: session.observing, rules: session.rules, routeGrouping: mode,
        }), session.id, revision, session.rules.length)
        session.revision = revision
        session.startupArmed = status.startupArmed
        session.startupState = status.startupState
      } catch (reason) {
        session.status = 'uncertain'
        session.message = errorMessage(reason)
        if (session.rules.length) session.sessionWarning = SESSION_CACHE_WARNING
        badge(session)
        throw reason
      }
      await cacheSession(session)
    }
    scheduleCache()
    for (const [otherTabId, other] of sessions) {
      if (otherTabId !== session.tabId && other.siteOrigin === session.siteOrigin) {
        void refreshTab(otherTabId, { force: true }).catch(() => {})
      }
    }
  }

  async function handle(view: PanelView, command: PanelCommand): Promise<void> {
    if (command.type === 'bind') {
      if (view.tabId !== undefined || !Number.isSafeInteger(command.tabId) || command.tabId < 0) {
        throw new Error('标签页连接不正确。')
      }
      view.tabId = command.tabId
      await refreshTab(command.tabId, { force: true })
      return
    }
    if (view.tabId !== command.target.tabId) throw new Error('当前标签页已变化。')
    if (command.type === 'reconnect') {
      clearDocumentRetry(command.target.tabId)
      const confirmed = await refreshTab(command.target.tabId, { force: true })
      const checked = sessions.get(command.target.tabId)
      if (!confirmed) {
        const detail = checked && ['unavailable', 'uncertain'].includes(checked.status) ? checked.message : undefined
        throw new Error(detail ?? '页面连接未确认，请等网页加载完成后重试。')
      }
      return
    }
    await restored
    await enqueue(command.target.tabId, async () => {
      const current = await getDocument(command.target.tabId, routeGroupingFor).catch(() => null)
      const session = sessions.get(command.target.tabId)
      const target: PanelTarget = command.target
      const tabWide = command.type === 'stop' && current && session?.siteOrigin === current.siteOrigin &&
        new URL(target.routeKey).origin === current.siteOrigin
      if (!session || !current || (!tabWide && (current.documentId !== target.documentId ||
          current.routeKey !== target.routeKey || session.documentId !== target.documentId || session.revision !== target.revision))) {
        void refreshTab(command.target.tabId).catch(() => {})
        throw new Error('页面或规则已变化，请根据面板最新内容重试。')
      }
      const replacedDocument = session.documentId !== current.documentId
      Object.assign(session, current)
      try {
        switch (command.type) {
          case 'apply':
            if (!['observing', 'active'].includes(session.status)) throw new Error('页面未接入或规则状态未确认。')
            await applyRules(session, command.rules)
            break
          case 'stop':
            await stopRules(session, replacedDocument)
            if (replacedDocument) void refreshTab(session.tabId).catch(() => {})
            break
          case 'stop-route':
            if (!['observing', 'active'].includes(session.status)) throw new Error('页面未接入或规则状态未确认。')
            await stopRouteRules(session)
            break
          case 'set-observing':
            await setObserving(session, command.enabled)
            break
          case 'set-route-grouping':
            await setRouteGrouping(session, command.mode)
            break
          case 'sample':
            await startSample(session, command.endpoint)
            break
          case 'import':
          case 'delete-imports':
            await updateImportedDirectory(session, command)
            break
          case 'save-plan':
            await savePlan(session, command.plan, command.expectedUpdatedAt)
            break
          case 'delete-plan':
            await updateLocal(data => ({ ...data, plans: data.plans.filter(plan =>
              plan.siteOrigin !== session.siteOrigin || plan.id !== command.planId) }))
            publishOtherPreferenceViews(session, true)
            break
          case 'add-ignores':
          case 'remove-ignores':
            await updateIgnores(session, command)
            break
          case 'save-scenario':
            await saveScenario(session, command.scenario)
            break
          case 'delete-scenario':
            await deleteScenario(session, command.id)
            break
          case 'refresh':
            await chrome.tabs.reload(session.tabId)
            break
          case 'early-access':
            await enableEarlyAccess(session.siteOrigin)
            session.earlyAccess = true
            await cacheSession(session)
            session.message = '已为本站准备首屏接入。'
            break
        }
      } finally {
        publishSession(session)
      }
    })
  }

  const extensionViews = new Set(['popup.html', 'workbench.html'].map(path => chrome.runtime.getURL(path)))
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PANEL_PORT || port.sender?.id !== chrome.runtime.id || !extensionViews.has(port.sender.url ?? '')) return
    const view: PanelView = { port }
    panels.set(port, view)
    port.onDisconnect.addListener(() => panels.delete(port))
    port.onMessage.addListener((request: PanelRequest) => {
      if (!request || typeof request.id !== 'string' || typeof request.command?.type !== 'string') return
      void handle(view, request.command).then(
        () => post(view, { type: 'result', id: request.id, ok: true }),
        reason => post(view, { type: 'result', id: request.id, ok: false, error: errorMessage(reason) }),
      )
    })
  })

  chrome.runtime.onMessage.addListener((report: WorkerReport | LocalDataRequest | { type: typeof PAGE_BOOT_MESSAGE }, sender, sendResponse) => {
    if (report?.type === PAGE_BOOT_MESSAGE) {
      if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId !== 0 || !sender.documentId ||
          !sender.url || !/^https?:/.test(sender.url)) return
      void refreshTab(sender.tab.id, { force: true, boot: true, committed: { documentId: sender.documentId, url: sender.url } }).catch(() => {})
      return
    }
    if (report?.type === 'local-data') {
      if (sender.id !== chrome.runtime.id || !extensionViews.has(sender.url ?? '')) return
      void handleLocalData(report.command).then(sendResponse, reason => sendResponse({ ok: false, error: errorMessage(reason) }))
      return true
    }
    const tabId = sender.tab?.id
    if (report?.type !== 'page-report' || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
        tabId === undefined || !sender.documentId) return
    void restored.then(() => enqueue(tabId, async () => {
      const session = sessions.get(tabId)
      if (!session || session.documentId !== sender.documentId) return
      const event = eventFromPage(report, session)
      if (event && recordRequest(session, event, localData.ignoresBySite[session.siteOrigin] ?? [])) {
        recordRuleOutcome(session, event)
        if (event.phase === 'real' && event.revision === session.revision) {
          const focus = session.recoveryFocus
          if (session.recoveryState === 'awaiting-real' && (!focus?.length || focus.some(rule =>
            rule.routeKey === event.routeKey && endpointCovers(rule.endpoint, event.endpoint)))) {
            session.recoveryState = 'real-confirmed'
            session.recoveryFocus = undefined
          }
        }
        scheduleRequestPublish(tabId)
        scheduleCache()
      }
    })).catch(() => {})
  })

  chrome.webNavigation.onCommitted.addListener(({ frameId, tabId, documentId, url }) => {
    if (frameId !== 0) return
    clearDocumentRetry(tabId)
    void refreshTab(tabId, { force: true, committed: { url, documentId } }).catch(() => {})
  })

  function refreshForHistory(details: { frameId: number; tabId: number }): void {
    if (details.frameId !== 0) return
    void refreshTab(details.tabId).catch(() => {})
  }
  chrome.webNavigation.onHistoryStateUpdated.addListener(refreshForHistory)
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(refreshForHistory)

  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.status === 'complete') void refreshTab(tabId, { force: true }).catch(() => {})
  })
  chrome.tabs.onRemoved.addListener(tabId => {
    clearDocumentRetry(tabId)
    const requestTimer = requestPublishTimers.get(tabId)
    if (requestTimer !== undefined) clearTimeout(requestTimer)
    requestPublishTimers.delete(tabId)
    void restored.then(() => enqueue(tabId, async () => {
      sessions.delete(tabId)
      await sessionCache.invalidate(tabId).catch(() => {})
      scheduleCache()
    })).catch(() => {})
  })
})
