import { describe, expect, it } from 'vitest'
import type { CatalogEntry, SavedPlan } from '../../lib/model'
import { endpointKey } from '../../lib/rules'
import { createDraft } from './editor'
import { compilePlanDraft, hasBroadPlanRule, preparePlanDraft } from './plan-draft'

const siteOrigin = 'https://example.test'
const routeKey = siteOrigin + '/orders?tab=active'
const endpoint = { method: 'POST', origin: siteOrigin, path: '/api/query' }
const entry: CatalogEntry = {
  endpoint, key: endpointKey(endpoint), observed: true, imported: false, realSeen: true, hitCount: 0,
}
const source: SavedPlan = {
  id: 'plan', name: '初始方案', siteOrigin, routeKey, rules: [], setup: '', trigger: '', expectation: '', updatedAt: 1,
}

describe('standalone plan drafts', () => {
  it('creates a plan with two POST operations before starting any mock rules', () => {
    const draft = preparePlanDraft(source, [entry], null)
    draft.name = ' 分别模拟订单和客户 '
    for (const operation of ['ListOrders', 'ListCustomers']) {
      const row = createDraft(entry)
      row.conditions.push({ id: operation, path: '/operationName', source: 'json', value: operation, valueKind: 'text' })
      draft.rules.push({ entry, draft: row })
    }
    const plan = compilePlanDraft(draft)
    expect(plan.name).toBe('分别模拟订单和客户')
    expect(plan.rules.map(rule => [rule.routeKey, rule.conditions[0]?.value])).toEqual([
      [routeKey, 'ListOrders'], [routeKey, 'ListCustomers'],
    ])
    expect(hasBroadPlanRule(plan.rules)).toBe(false)
    expect(source.rules).toHaveLength(0)
  })

  it('retains edit details independently of discovery and marks broad plan rules', () => {
    const draft = preparePlanDraft(source, [], null)
    draft.rules.push({ entry, draft: createDraft(entry) })
    const plan = compilePlanDraft(draft)
    expect(hasBroadPlanRule(plan.rules)).toBe(true)
    const reopened = preparePlanDraft(plan, [], 12)
    reopened.rules[0]!.draft.response.status = 429
    expect(compilePlanDraft(reopened).rules[0]?.response.status).toBe(429)
    expect(plan.rules[0]?.response.status).toBe(404)
    expect(reopened.expectedUpdatedAt).toBe(12)
  })

  it('rejects a blank plan or duplicate overlapping conditions', () => {
    const draft = preparePlanDraft(source, [], null)
    expect(() => compilePlanDraft(draft)).toThrow('至少一条规则')
    draft.rules.push({ entry, draft: createDraft(entry) }, { entry, draft: createDraft(entry) })
    expect(() => compilePlanDraft(draft)).toThrow('重叠')
  })
})
