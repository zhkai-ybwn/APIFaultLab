import type { CatalogEntry, RequestCondition, Rule } from '../../lib/model'
import { endpointCovers, endpointKey, MAX_RULE_HITS } from '../../lib/rules'
import { validateScenarioResponse } from '../../lib/scenarios'
import { compileDraftHeaders, createDraft, draftRule, type RuleDraft } from './editor'

export interface BatchRow {
  entry: CatalogEntry
  original?: Rule
  draft: RuleDraft
}

export interface BatchWork {
  rows: BatchRow[]
  skipped: { entry: CatalogEntry; templates: string[] }[]
}

export function prepareBatch(entries: CatalogEntry[], currentRules: Rule[]): BatchWork {
  const rows: BatchRow[] = []
  const skipped: BatchWork['skipped'] = []
  for (const entry of entries) {
    const exact = currentRules.filter(rule => endpointKey(rule.endpoint) === entry.key)
    if (exact.length) {
      rows.push(...exact.map(original => ({ entry, original, draft: createDraft(entry, original) })))
      continue
    }

    // Selecting a concrete URL must never edit a rule that also applies to other URLs.
    const templates = entry.endpoint.template ? [] : currentRules
      .filter(rule => rule.endpoint.template && endpointCovers(rule.endpoint, entry.endpoint))
      .map(rule => rule.endpoint.path)
    if (templates.length) skipped.push({ entry, templates: [...new Set(templates)] })
    else rows.push({ entry, draft: createDraft(entry) })
  }
  return { rows, skipped }
}

export function compileBatchRow(row: BatchRow, current: Rule | undefined, routeKey: string): Rule {
  if (!row.original) return draftRule(row.draft, row.entry, routeKey)

  if (!current || current.routeKey !== routeKey || JSON.stringify(current) !== JSON.stringify(row.original)) {
    throw new Error(`${row.entry.endpoint.method} ${row.entry.endpoint.path} 的规则已变化，请返回勾选后重新设置`)
  }
  const headers = row.draft.response.kind === 'http' ? compileDraftHeaders(row.draft.headers) : undefined
  const maxHits = row.draft.maxHits
  if (maxHits !== undefined && (!Number.isSafeInteger(maxHits) || maxHits < 1 || maxHits > MAX_RULE_HITS)) {
    throw new Error(`最多生效次数应为 1 到 ${MAX_RULE_HITS} 的整数`)
  }
  const { maxHits: _prevMaxHits, ...base } = current
  return {
    ...base,
    ...(maxHits !== undefined ? { maxHits } : {}),
    response: validateScenarioResponse(
      { ...row.draft.response, ...(headers ? { headers } : { headers: undefined }) },
      row.draft.allowInvalidJson,
      current.endpoint.method,
    ),
  }
}

export function batchAddsBroadScope(row: BatchRow): boolean {
  return !row.original && (row.entry.endpoint.template === true ||
    (!row.draft.conditions.length && !['GET', 'HEAD', 'OPTIONS'].includes(row.entry.endpoint.method)))
}

function conditionSourceLabel(source: RequestCondition['source']): string {
  return source === 'query' ? '查询参数' : source === 'header' ? '请求头' : 'JSON'
}

export function describeCondition(condition: RequestCondition): string {
  return `${conditionSourceLabel(condition.source)} ${condition.path} = ${JSON.stringify(condition.value)}`
}

export function describeBatchScope(row: BatchRow): string[] {
  if (row.original) return row.original.conditions.map(describeCondition)
  return row.draft.conditions.map(condition => {
    const value = condition.valueKind === 'scalar' ? condition.value : JSON.stringify(condition.value)
    return `${conditionSourceLabel(condition.source)} ${condition.path.trim() || '（待填写字段）'} = ${value}`
  })
}
