import type { CatalogEntry, PanelStatus, Rule } from '../model'

const LEGACY_KEY = 'apiFaultLabSessions_v1'
const STATE_PREFIX = 'apiFaultLabSession_v2:'
const CATALOG_KEY = 'apiFaultLabCatalog_v2'
const MAX_CATALOG_BYTES = 512 * 1024
const encoder = new TextEncoder()

export interface CachedTabState {
  tabId: number
  documentId: string
  pageUrl: string
  routeKey: string
  siteOrigin: string
  id: string
  revision: number
  rules: Rule[]
  status: PanelStatus
  observing: boolean
  activeCount: number
  earlyAccess?: boolean
}

type CachedGroups = [string, CatalogEntry[]][]
export type CachedCatalog = [number, CachedGroups][]

function readGroups(value: unknown): CachedGroups {
  if (!Array.isArray(value)) return []
  const result: CachedGroups = []
  for (const group of value) {
    if (!Array.isArray(group) || typeof group[0] !== 'string' || !Array.isArray(group[1])) continue
    const entries = group[1].filter((entry): entry is CatalogEntry =>
      entry && typeof entry.key === 'string' && entry.endpoint && typeof entry.endpoint.path === 'string',
    )
    if (entries.length) result.push([group[0], entries])
  }
  return result
}

function readTabState(input: unknown): CachedTabState | undefined {
  const state = input as Partial<CachedTabState> | null
  if (!state || typeof state.tabId !== 'number' || !Number.isSafeInteger(state.tabId) || state.tabId < 0 ||
      typeof state.documentId !== 'string' || typeof state.pageUrl !== 'string' || typeof state.routeKey !== 'string' ||
      typeof state.siteOrigin !== 'string' || typeof state.id !== 'string' || typeof state.status !== 'string' ||
      typeof state.revision !== 'number' || !Number.isSafeInteger(state.revision) ||
      typeof state.activeCount !== 'number' || typeof state.observing !== 'boolean' || !Array.isArray(state.rules)) return
  return {
    tabId: state.tabId, documentId: state.documentId, pageUrl: state.pageUrl, routeKey: state.routeKey,
    siteOrigin: state.siteOrigin, id: state.id, revision: state.revision, rules: state.rules, status: state.status,
    activeCount: state.activeCount, observing: state.observing, earlyAccess: state.earlyAccess === true,
  }
}

function trimCatalog(catalog: Iterable<[number, Iterable<[string, Iterable<CatalogEntry>]>]>): CachedCatalog {
  const saved: CachedCatalog = []
  let remaining = MAX_CATALOG_BYTES
  for (const [tabId, groups] of catalog) {
    const tabGroups: CachedGroups = []
    remaining -= 24
    for (const [route, entries] of groups) {
      const routeLength = encoder.encode(JSON.stringify(route)).byteLength + 8
      if (remaining <= routeLength) return saved
      remaining -= routeLength
      const group: CatalogEntry[] = []
      for (const entry of entries) {
        const cost = encoder.encode(JSON.stringify(entry)).byteLength + 1
        if (remaining < cost) continue
        remaining -= cost
        if (!group.length) {
          if (!tabGroups.length) saved.push([tabId, tabGroups])
          tabGroups.push([route, group])
        }
        group.push(entry)
      }
    }
  }
  return saved
}

export function createSessionCache() {
  let queue: Promise<unknown> = Promise.resolve()
  let legacyMayExist = true

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = queue.catch(() => {}).then(work)
    queue = pending
    return pending
  }

  async function clear(key: string) {
    try {
      await chrome.storage.session.remove(key)
    } catch {
      // Replacing a record with a marker also invalidates it if deletion fails.
      await chrome.storage.session.set({ [key]: null })
    }
  }

  async function discardLegacy() {
    if (!legacyMayExist) return
    await clear(LEGACY_KEY)
    legacyMayExist = false
  }

  async function writeState(state: CachedTabState) {
    const item = { [`${STATE_PREFIX}${state.tabId}`]: state }
    try {
      await chrome.storage.session.set(item)
    } catch (cause) {
      if (!(cause instanceof Error) || !/quota/i.test(cause.message)) throw cause
      await clear(CATALOG_KEY)
      await chrome.storage.session.set(item)
    }
  }

  function load() {
    return enqueue(async () => {
      const values = await chrome.storage.session.get(null)
      const states = new Map<number, CachedTabState>()
      const warnings = new Set<number>()
      const catalog = new Map<number, CachedGroups>()
      const storedCatalog = values[CATALOG_KEY]
      if (Array.isArray(storedCatalog)) {
        for (const tab of storedCatalog) {
          if (Array.isArray(tab) && Number.isSafeInteger(tab[0])) catalog.set(tab[0], readGroups(tab[1]))
        }
      }
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith(STATE_PREFIX)) continue
        const state = readTabState(value)
        if (state && key === `${STATE_PREFIX}${state.tabId}`) states.set(state.tabId, state)
      }
      const legacy = values[LEGACY_KEY]
      legacyMayExist = legacy !== undefined && legacy !== null
      // Clear the old source before using it. If the worker exits during migration,
      // only the records that were already written are eligible for restoration.
      if (legacyMayExist) {
        try { await discardLegacy() } catch { return { states, catalog, warnings } }
      }
      if (Array.isArray(legacy)) {
        for (const item of legacy) {
          const state = readTabState(item)
          if (!state || Object.hasOwn(values, `${STATE_PREFIX}${state.tabId}`)) continue
          states.set(state.tabId, state)
          if (!catalog.has(state.tabId)) catalog.set(state.tabId, readGroups(item.catalog))
          try { await writeState(state) } catch { warnings.add(state.tabId) }
        }
      }
      return { states, catalog, warnings }
    })
  }

  function invalidate(tabId: number) {
    return enqueue(async () => {
      await discardLegacy()
      await clear(`${STATE_PREFIX}${tabId}`)
    })
  }

  function save(state: CachedTabState) {
    return enqueue(() => writeState(state))
  }

  function saveCatalog(read: () => Parameters<typeof trimCatalog>[0]) {
    return enqueue(() => chrome.storage.session.set({ [CATALOG_KEY]: trimCatalog(read()) })).catch(() => {})
  }

  return { load, invalidate, save, saveCatalog }
}
