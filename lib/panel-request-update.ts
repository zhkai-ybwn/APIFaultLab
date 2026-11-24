import type { CatalogEntry, EntryResponseSources, PanelRequestUpdate, PanelSnapshot, PanelTarget } from './model'

export function hasSamePanelTarget(left: PanelTarget | null | undefined, right: PanelTarget): boolean {
  return left?.tabId === right.tabId && left.documentId === right.documentId &&
    left.routeKey === right.routeKey && left.revision === right.revision
}

export function entryResponseSources(entries: CatalogEntry[]): Map<string, EntryResponseSources> {
  return new Map(entries.flatMap(({ key, example, sample }) =>
    example !== undefined || sample !== undefined ? [[key, { example, sample }]] : [],
  ))
}

/** Large response bodies are transferred only when new, changed, or explicitly removed. */
export function createRequestUpdate(snapshot: PanelSnapshot, target: PanelTarget,
  known: Map<string, EntryResponseSources>, next: Map<string, EntryResponseSources>): PanelRequestUpdate {
  const { ruleOutcomes, catalogAtCapacity, message, recoveryState, recoveryScope, responseSample } = snapshot
  return {
    target, ruleOutcomes, catalogAtCapacity, message, recoveryState, recoveryScope, responseSample,
    entries: snapshot.entries.map(({ example: _example, sample: _sample, ...entry }) => entry),
    responseSources: snapshot.entries.flatMap(({ key }) => {
      const previous = known.get(key)
      const current = next.get(key)
      return previous?.example === current?.example && previous?.sample === current?.sample ? [] : [[key, current ?? {}]]
    }),
  }
}

export function applyRequestUpdate(snapshot: PanelSnapshot, update: PanelRequestUpdate): PanelSnapshot {
  if (!hasSamePanelTarget(snapshot.target, update.target)) return snapshot
  const { target: _target, entries, responseSources, ruleOutcomes, catalogAtCapacity,
    message, recoveryState, recoveryScope, responseSample } = update
  const existing = entryResponseSources(snapshot.entries)
  const changed = new Map(responseSources)
  return {
    ...snapshot, ruleOutcomes, catalogAtCapacity, message, recoveryState, recoveryScope, responseSample,
    entries: entries.map(entry => {
      const sources = changed.get(entry.key) ?? existing.get(entry.key)
      return sources ? { ...entry, ...sources } : entry
    }),
  }
}
