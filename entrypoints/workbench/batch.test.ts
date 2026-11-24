import { describe, expect, it } from 'vitest'
import type { CatalogEntry, Endpoint, Rule } from '../../lib/model'
import { endpointKey, matchRequest, validateRuleSet } from '../../lib/rules'
import { batchAddsBroadScope, compileBatchRow, prepareBatch } from './batch'

const route = 'https://app.example.test/orders'
const endpoint: Endpoint = { method: 'POST', origin: 'https://api.example.test', path: '/query' }

function catalog(endpoint: Endpoint): CatalogEntry {
  return { key: endpointKey(endpoint), endpoint, imported: false, observed: true, realSeen: true, hitCount: 0 }
}

function operation(id: string, value: string, target = endpoint): Rule {
  return {
    id,
    routeKey: route,
    endpoint: target,
    conditions: [{ source: 'json', path: '/operationName', value }],
    response: { kind: 'http', status: 200, contentType: 'application/json', body: '{}', delayMs: 0 },
  }
}

function post(operationName: string): Request {
  return new Request(`${endpoint.origin}${endpoint.path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationName }),
  })
}

describe('batch editing request scope', () => {
  it('updates each existing POST rule separately and does not start matching other operations', async () => {
    const existing = [operation('list', 'ListOrders'), operation('export', 'ExportOrders')]
    const batch = prepareBatch([catalog(endpoint)], existing)
    expect(batch.rows).toHaveLength(2)
    for (const row of batch.rows) {
      row.draft.response.status = 429
      row.draft.conditions = []
    }
    const next = batch.rows.map((row, index) => compileBatchRow(row, existing[index], route))
    expect(() => validateRuleSet(next)).not.toThrow()
    expect(next.map(rule => rule.conditions)).toEqual(existing.map(rule => rule.conditions))
    expect(await matchRequest(next, post('ListOrders'), route)).toMatchObject({ kind: 'match', rule: { id: 'list', response: { status: 429 } } })
    expect(await matchRequest(next, post('ExportOrders'), route)).toMatchObject({ kind: 'match', rule: { id: 'export', response: { status: 429 } } })
    expect(await matchRequest(next, post('UpdateOrder'), route)).toEqual({ kind: 'none', candidate: true })
  })

  it('updates an explicitly selected template once without converting its concrete paths into edits', () => {
    const template = { ...endpoint, path: '/orders/{id}', template: true }
    const first = { ...endpoint, path: '/orders/1' }
    const second = { ...endpoint, path: '/orders/2' }
    const existing = operation('template', 'GetOrder', template)
    const exact = operation('exact', 'UpdateOrder', first)
    const batch = prepareBatch([catalog(first), catalog(second), catalog(template)], [existing, exact])

    expect(batch.rows.map(row => row.original?.id)).toEqual(['exact', 'template'])
    expect(batch.skipped.map(row => row.entry.endpoint.path)).toEqual(['/orders/2'])
    expect(compileBatchRow(batch.rows[0]!, exact, route).endpoint).toEqual(first)
    expect(compileBatchRow(batch.rows[1]!, existing, route).endpoint).toEqual(template)
    expect(prepareBatch([catalog(second)], [existing]).rows).toEqual([])
  })

  it('does not replace a rule that another editor changed after the batch was opened', () => {
    const existing = operation('list', 'ListOrders')
    const [row] = prepareBatch([catalog(endpoint)], [existing]).rows
    expect(() => compileBatchRow(row!, undefined, route)).toThrow('规则已变化')
    expect(() => compileBatchRow(row!, { ...existing, response: { ...existing.response, status: 503 } }, route)).toThrow('规则已变化')
  })

  it('identifies new templates and unconditional POST rules for the scope summary', () => {
    const lookup = catalog({ ...endpoint, method: 'GET' })
    const template = catalog({ ...endpoint, method: 'GET', path: '/orders/{id}', template: true })
    const batch = prepareBatch([lookup, catalog(endpoint), template], [])

    expect(batch.rows.map(batchAddsBroadScope)).toEqual([false, true, true])
    batch.rows[1]!.draft.conditions.push({ id: 'operation', source: 'json', path: '/operationName', value: 'ListOrders', valueKind: 'text' })
    expect(batchAddsBroadScope(batch.rows[1]!)).toBe(false)
  })
})
