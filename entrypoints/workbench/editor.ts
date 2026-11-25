import type { CatalogEntry, JsonScalar, MockResponse, RequestCondition, Rule } from '../../lib/model'
import { MAX_RULE_HITS, normalizeResponseHeaders } from '../../lib/rules'
import { hasInvalidJson, presetResponse, validateScenarioResponse } from '../../lib/scenarios'

export { applyScenario, presetResponse, presets } from '../../lib/scenarios'
export type { Preset, ScenarioChoice, ScenarioSeed } from '../../lib/scenarios'

interface DraftCondition {
  id: string
  source: RequestCondition['source']
  path: string
  value: string
  valueKind: 'text' | 'scalar'
}

export interface DraftHeader {
  id: string
  name: string
  value: string
}

export interface RuleDraft {
  id: string
  response: MockResponse
  headers: DraftHeader[]
  maxHits?: number
  conditions: DraftCondition[]
  allowInvalidJson: boolean
}

const json = 'application/json'

function http(status: number, body: string): MockResponse {
  return { kind: 'http', status, body, contentType: json, delayMs: 0 }
}

export function newCondition(source: RequestCondition['source']): DraftCondition {
  return { id: crypto.randomUUID(), source, path: '', value: '', valueKind: 'text' }
}

export function newResponseHeader(name = '', value = ''): DraftHeader {
  return { id: crypto.randomUUID(), name, value }
}

export function draftHeaders(headers?: Record<string, string>): DraftHeader[] {
  return Object.entries(headers ?? {}).map(([name, value]) => newResponseHeader(name, value))
}

export function compileDraftHeaders(rows: DraftHeader[]): Record<string, string> | undefined {
  const nonEmpty = rows.filter(row => row.name.trim() || row.value)
  if (!nonEmpty.length) return undefined
  const record: Record<string, string> = {}
  const seen = new Set<string>()
  for (const row of nonEmpty) {
    const name = row.name.trim()
    if (!name) throw new Error('请填写自定义响应头名称')
    const lower = name.toLowerCase()
    if (seen.has(lower)) throw new Error(`响应头 ${name} 重复，请合并为一项`)
    seen.add(lower)
    record[name] = row.value
  }
  return normalizeResponseHeaders(record)
}

export function createDraft(entry: CatalogEntry, rule?: Rule, conditions = rule?.conditions ?? []): RuleDraft {
  const baseResponse = rule?.response ?? presetResponse('404', entry)
  return {
    id: rule?.id ?? crypto.randomUUID(),
    response: { ...baseResponse, ...(baseResponse.headers ? { headers: { ...baseResponse.headers } } : {}) },
    headers: draftHeaders(baseResponse.headers),
    maxHits: rule?.maxHits,
    allowInvalidJson: Boolean(rule && hasInvalidJson(rule.response)),
    conditions: conditions.map(condition => ({
      id: crypto.randomUUID(), source: condition.source, path: condition.path,
      value: typeof condition.value === 'string' ? condition.value : JSON.stringify(condition.value),
      valueKind: typeof condition.value === 'string' ? 'text' : 'scalar',
    })),
  }
}

function decodePointer(path: string): string[] {
  if (!path.startsWith('/')) throw new Error('请输入以 / 开头的 JSON 路径')
  return path.slice(1).split('/').map(part => {
    if (/~(?:[^01]|$)/.test(part)) throw new Error('JSON 路径转义有误')
    return part.replaceAll('~1', '/').replaceAll('~0', '~')
  })
}

function setExistingField(root: unknown, path: string, emptyList: boolean) {
  const tokens = decodePointer(path)
  const field = tokens.pop()!
  let parent = root
  const owns = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key)
  for (const token of tokens) {
    if (!parent || typeof parent !== 'object' || !owns(parent, token)) throw new Error(`响应中找不到 ${path}`)
    parent = (parent as Record<string, unknown>)[token]
  }
  if (!parent || typeof parent !== 'object' || !owns(parent, field)) throw new Error(`响应中找不到 ${path}`)
  const record = parent as Record<string, unknown>
  if (emptyList && !Array.isArray(record[field])) throw new Error(`${path} 应当是数组`)
  if (!emptyList && typeof record[field] !== 'number') throw new Error(`${path} 应当是数字`)
  record[field] = emptyList ? [] : 0
}

export function emptyWithStructure(source: string, listPath: string, totalPath: string): MockResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('需要一份可解析的 JSON 响应才能保留结构')
  }
  setExistingField(parsed, listPath.trim(), true)
  if (totalPath.trim()) setExistingField(parsed, totalPath.trim(), false)
  return http(200, JSON.stringify(parsed, null, 2))
}

export function draftRule(draft: RuleDraft, entry: CatalogEntry, routeKey: string): Rule {
  const conditions = draft.conditions.map((condition): RequestCondition => {
    const trimmed = condition.path.trim()
    if (!trimmed) throw new Error('请填写每条请求条件的字段')
    const path = condition.source === 'json' && !trimmed.startsWith('/') ? `/${trimmed}` : trimmed
    let value: JsonScalar = condition.value
    if (condition.source === 'json') {
      decodePointer(path)
      if (condition.valueKind === 'scalar') {
        let parsed: unknown
        try {
          parsed = JSON.parse(condition.value)
        } catch {
          throw new Error(`${path} 的值应为数字、布尔值或 null`)
        }
        if (parsed !== null && typeof parsed !== 'number' && typeof parsed !== 'boolean') {
          throw new Error(`${path} 的值应为数字、布尔值或 null`)
        }
        value = parsed
      }
    }
    return { source: condition.source, path, value }
  })
  const headers = draft.response.kind === 'http' ? compileDraftHeaders(draft.headers) : undefined
  const response = validateScenarioResponse(
    { ...draft.response, ...(headers ? { headers } : { headers: undefined }) },
    draft.allowInvalidJson,
    entry.endpoint.method,
  )
  const maxHits = draft.maxHits
  if (maxHits !== undefined && (!Number.isSafeInteger(maxHits) || maxHits < 1 || maxHits > MAX_RULE_HITS)) {
    throw new Error(`最多生效次数应为 1 到 ${MAX_RULE_HITS} 的整数`)
  }
  return {
    id: draft.id, routeKey, endpoint: { ...entry.endpoint }, conditions, response,
    ...(maxHits !== undefined ? { maxHits } : {}),
  }
}
