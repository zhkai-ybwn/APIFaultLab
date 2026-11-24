import type { CatalogEntry, Rule, SavedPlan } from '../../lib/model'
import { endpointKey, validateRuleSet } from '../../lib/rules'
import { createDraft, draftRule, type RuleDraft } from './editor'

export interface PlanRuleDraft {
  entry: CatalogEntry
  draft: RuleDraft
}

export interface PlanDraft extends Omit<SavedPlan, 'rules' | 'updatedAt'> {
  expectedUpdatedAt: number | null
  rules: PlanRuleDraft[]
}

export function preparePlanDraft(source: SavedPlan, entries: CatalogEntry[], expectedUpdatedAt: number | null): PlanDraft {
  const { updatedAt: _updatedAt, rules, ...metadata } = source
  const available = new Map(entries.map(entry => [entry.key, entry]))
  return {
    ...metadata,
    expectedUpdatedAt,
    rules: rules.map(rule => {
      const key = endpointKey(rule.endpoint)
      const entry: CatalogEntry = available.get(key) ?? {
        key, endpoint: { ...rule.endpoint }, imported: false, observed: false, realSeen: false, hitCount: 0,
      }
      return { entry, draft: createDraft(entry, rule) }
    }),
  }
}

export function compilePlanDraft(draft: PlanDraft): SavedPlan {
  const { expectedUpdatedAt: _expectedUpdatedAt, rules, ...metadata } = draft
  const name = metadata.name.trim()
  if (!name) throw new Error('请输入方案名称。')
  if (!rules.length) throw new Error('请为方案添加至少一条规则。')
  const compiled = rules.map(item => draftRule(item.draft, item.entry, metadata.routeKey))
  validateRuleSet(compiled)
  return { ...metadata, name, rules: compiled, updatedAt: 0 }
}

export function hasBroadPlanRule(rules: Rule[]): boolean {
  return rules.some(rule => rule.endpoint.template === true ||
    (!rule.conditions.length && !['GET', 'HEAD', 'OPTIONS'].includes(rule.endpoint.method)))
}
