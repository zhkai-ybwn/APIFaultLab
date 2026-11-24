import type { ImportedEntry } from './backup'
import { MAX_IMPORT_OPERATIONS, normalizeCatalogOperations } from './catalog'
import type { CatalogEntry } from './model'
import { endpointKey } from './rules'

interface Scope { siteOrigin: string; routeKey: string }

type DirectoryChange =
  | { entries: CatalogEntry[]; mode?: 'replace'; expectedKeys?: string[] }
  | { keys: string[] }

export function changeImportedDirectory(current: ImportedEntry[], scope: Scope, change: DirectoryChange): ImportedEntry[] {
  const inScope = (item: ImportedEntry) => item.siteOrigin === scope.siteOrigin && item.routeKey === scope.routeKey
  if ('keys' in change) {
    if (!Array.isArray(change.keys) || change.keys.some(key => typeof key !== 'string')) throw new Error('接口目录选择无效')
    const keys = new Set(change.keys)
    return current.filter(item => !inScope(item) || !keys.has(item.entry.key))
  }

  if (!Array.isArray(change.entries) || !change.entries.length || change.entries.length > MAX_IMPORT_OPERATIONS) {
    throw new Error('一次最多加入 ' + MAX_IMPORT_OPERATIONS + ' 个操作')
  }
  const previous = new Map(current.filter(inScope).map(({ entry }) => [entry.key, entry]))
  const next = change.mode === 'replace' ? new Map<string, CatalogEntry>() : new Map(previous)
  if (change.mode === 'replace' && (!Array.isArray(change.expectedKeys) ||
      change.expectedKeys.length !== previous.size || new Set(change.expectedKeys).size !== previous.size ||
      change.expectedKeys.some(key => !previous.has(key)))) {
    throw new Error('当前页面的导入目录已变化，请重新确认替换范围')
  }

  let operationCount = 0
  const seen = new Set<string>()
  for (const item of change.entries) {
    const key = endpointKey(item.endpoint)
    if (seen.has(key)) throw new Error('导入目录中有重复接口')
    seen.add(key)
    const incoming = item.operations === undefined ? undefined : normalizeCatalogOperations(item.operations)
    operationCount += incoming?.length || 1
    if (operationCount > MAX_IMPORT_OPERATIONS) throw new Error('一次最多加入 ' + MAX_IMPORT_OPERATIONS + ' 个操作')
    const retained = next.get(key)
    const merged = new Map(retained?.operations?.map(operation => [operation.id, operation]))
    for (const operation of incoming ?? []) merged.set(operation.id, operation)
    if (merged.size > MAX_IMPORT_OPERATIONS) throw new Error('同一接口的操作数量超过目录上限')
    next.set(key, {
      key, endpoint: item.endpoint, title: item.title, contentType: item.contentType ?? retained?.contentType,
      example: item.example ?? retained?.example, operations: merged.size ? [...merged.values()] : undefined,
      imported: true, observed: false, realSeen: false, hitCount: 0,
    })
  }
  return [...current.filter(item => !inScope(item)), ...[...next.values()].map(entry => ({
    siteOrigin: scope.siteOrigin, routeKey: scope.routeKey, entry,
  }))]
}
