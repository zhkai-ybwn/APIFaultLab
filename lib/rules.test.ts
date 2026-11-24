import { describe, expect, it } from 'vitest'
import type { Rule } from './model'
import { abortableDelay, buildResponse, endpointCovers, matchRequest, routeKey, validateRuleSet } from './rules'

const page = 'https://app.example.test/orders?tab=unpaid'
const target = 'https://api.example.test/query'

function rule(operation: string, id = operation): Rule {
  return {
    id,
    endpoint: { method: 'POST', origin: 'https://api.example.test', path: '/query' },
    routeKey: page,
    conditions: [{ source: 'json', path: '/operationName', value: operation }],
    response: { kind: 'http', status: 200, contentType: 'application/json', body: '{"data":[]}', delayMs: 0 },
  }
}

function post(body: string, url = target): Request {
  return new Request(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
}

describe('POST rule scope and body handling', () => {
  it('distinguishes operations on the same endpoint and preserves the request body for passthrough', async () => {
    const payload = '{"operationName":"ListOrders","page":2}'
    const request = post(payload)
    const list = rule('ListOrders')
    const choices = [list, rule('DeleteOrder')]
    validateRuleSet(choices)
    expect(await matchRequest(choices, request, page)).toMatchObject({ kind: 'match', rule: { id: 'ListOrders' } })
    expect(await request.text()).toBe(payload)
    expect(await matchRequest([list], post('{"operationName":"DeleteOrder"}'), page)).toEqual({ kind: 'none', candidate: true })
  })

  it('reports unreadable candidate bodies and skips body parsing outside the route or endpoint', async () => {
    expect(await matchRequest([rule('ListOrders')], post('{'), page)).toMatchObject({ kind: 'invalid' })
    expect(await matchRequest([rule('ListOrders')], post('{'), 'https://app.example.test/customers'))
      .toEqual({ kind: 'none', candidate: false })
    expect(await matchRequest([rule('ListOrders')], post('{', `${target}/other`), page))
      .toEqual({ kind: 'none', candidate: false })
  })

  it('uses exact page URLs and path templates confined to one segment', () => {
    expect(routeKey(page)).toBe(page)
    expect(routeKey('https://app.example.test/orders#/all')).not.toBe(routeKey('https://app.example.test/orders#/unpaid'))
    const endpoint = rule('ListOrders').endpoint
    const pattern = { ...endpoint, path: '/orders/{id}.json', template: true }
    expect(endpointCovers(pattern, { ...endpoint, path: '/orders/a.json' })).toBe(true)
    expect(endpointCovers(pattern, { ...endpoint, path: '/orders/a/b.json' })).toBe(false)
    expect(endpointCovers(pattern, { ...endpoint, path: '/orders/a.json', origin: 'https://other.example.test' })).toBe(false)
  })

  it('rejects overlapping rules before enabling a batch', () => {
    const general = { ...rule('ListOrders', 'general'), conditions: [] }
    expect(() => validateRuleSet([general, rule('ListOrders')])).toThrow('重叠')
    expect(() => validateRuleSet([rule('ListOrders', 'a'), rule('ListOrders', 'b')])).toThrow('重叠')
    expect(() => validateRuleSet([rule('ListOrders'), rule('DeleteOrder')])).not.toThrow()
  })
})

describe('local responses', () => {
  it('keeps HTTP 404 separate from network failure and returns no body for 204 or HEAD', async () => {
    const response = rule('ListOrders').response
    expect(buildResponse({ ...response, status: 404 }, 'POST').status).toBe(404)
    expect(buildResponse({ ...response, kind: 'network' }, 'POST').type).toBe('error')
    expect(await buildResponse({ ...response, status: 204 }, 'POST').text()).toBe('')
    expect(await buildResponse(response, 'HEAD').text()).toBe('')
  })

  it('carries Retry-After on an HTTP mock and rejects invalid seconds', () => {
    const response = { ...rule('ListOrders').response, status: 429 }
    expect(buildResponse({ ...response, retryAfterSeconds: 30 }, 'POST').headers.get('Retry-After')).toBe('30')
    expect(() => buildResponse({ ...response, retryAfterSeconds: -1 }, 'POST')).toThrow('非负整数秒')
  })

  it('rejects an already intercepted delay when cancelled', async () => {
    const controller = new AbortController()
    const delay = abortableDelay(10_000, controller.signal)
    controller.abort(new DOMException('已停止模拟', 'AbortError'))
    await expect(delay).rejects.toHaveProperty('name', 'AbortError')
  })
})
