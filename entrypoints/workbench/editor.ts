import type { CatalogEntry, JsonScalar, MockResponse, RequestCondition, Rule } from '../../lib/model'
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

export interface RuleDraft {
  id: string
  response: MockResponse
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

export function createDraft(entry: CatalogEntry, rule?: Rule, conditions = rule?.conditions ?? []): RuleDraft {
  return {
    id: rule?.id ?? crypto.randomUUID(),
    response: { ...(rule?.response ?? presetResponse('404', entry)) },
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
  const response = validateScenarioResponse(draft.response, draft.allowInvalidJson, entry.endpoint.method)
  return { id: draft.id, routeKey, endpoint: { ...entry.endpoint }, conditions, response }
}
