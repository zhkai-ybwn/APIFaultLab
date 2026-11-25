import { describe, expect, it } from 'vitest'
import type { Rule } from './model'
import { abortableDelay, buildResponse, endpointCovers, isValidHttpMethod, matchRequest, routeKey, validateRuleSet } from './rules'

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
    expect(routeKey(page, 'ignore-query')).toBe('https://app.example.test/orders')
    expect(routeKey('https://app.example.test/#/orders?page=2&tab=all', 'ignore-query')).toBe('https://app.example.test/#/orders')
    expect(routeKey('https://app.example.test/orders#/all', 'ignore-query')).not.toBe(routeKey('https://app.example.test/orders#/unpaid', 'ignore-query'))
    expect(routeKey('https://app.example.test/orders#?page=1', 'ignore-query')).toBe('https://app.example.test/orders')
    const endpoint = rule('ListOrders').endpoint
    const pattern = { ...endpoint, path: '/orders/{id}.json', template: true }
    expect(endpointCovers(pattern, { ...endpoint, path: '/orders/a.json' })).toBe(true)
    expect(endpointCovers(pattern, { ...endpoint, path: '/orders/a/b.json' })).toBe(false)
    expect(endpointCovers(pattern, { ...endpoint, path: '/orders/a.json', origin: 'https://other.example.test' })).toBe(false)
  })

  it('validates HTTP token methods consistently and distinguishes disjoint partial-segment templates', () => {
    expect(isValidHttpMethod('GET')).toBe(true)
    expect(isValidHttpMethod('M-SEARCH')).toBe(true)
    expect(isValidHttpMethod('')).toBe(false)
    expect(isValidHttpMethod('get')).toBe(false)
    expect(isValidHttpMethod('A'.repeat(33))).toBe(false)

    const base = rule('ListOrders')
    const imgRule = { ...base, id: 'img', conditions: [], endpoint: { ...base.endpoint, path: '/files/img-{id}', template: true } }
    const docRule = { ...base, id: 'doc', conditions: [], endpoint: { ...base.endpoint, path: '/files/doc-{id}', template: true } }
    const pngRule = { ...base, id: 'png', conditions: [], endpoint: { ...base.endpoint, path: '/files/{id}.png', template: true } }
    const jpgRule = { ...base, id: 'jpg', conditions: [], endpoint: { ...base.endpoint, path: '/files/{id}.jpg', template: true } }
    const broadImg = { ...base, id: 'broad', conditions: [], endpoint: { ...base.endpoint, path: '/files/img-{type}-{id}', template: true } }
    expect(() => validateRuleSet([imgRule, docRule])).not.toThrow()
    expect(() => validateRuleSet([pngRule, jpgRule])).not.toThrow()
    expect(() => validateRuleSet([imgRule, broadImg])).toThrow('重叠')
  })

  it('matches request headers case-insensitively without parsing body and validates maxHits', async () => {
    const orderByHeader: Rule = {
      ...rule('ListOrders', 'header-orders'),
      conditions: [{ source: 'header', path: 'X-Action', value: 'ListOrders' }],
      maxHits: 2,
    }
    const customerByHeader: Rule = {
      ...rule('ListCustomers', 'header-customers'),
      conditions: [{ source: 'header', path: 'x-action', value: 'ListCustomers' }],
    }
    expect(() => validateRuleSet([orderByHeader, customerByHeader])).not.toThrow()
    expect(() => validateRuleSet([{
      ...orderByHeader,
      conditions: [
        { source: 'header', path: 'X-Action', value: 'A' },
        { source: 'header', path: 'x-action', value: 'B' },
      ],
    }])).toThrow('同一字段')
    expect(() => validateRuleSet([{ ...orderByHeader, maxHits: 0 }])).toThrow('最多生效次数')
    expect(() => validateRuleSet([{ ...orderByHeader, maxHits: 1001 }])).toThrow('最多生效次数')

    const matchedReq = new Request(target, { method: 'POST', headers: { 'x-action': 'ListOrders' }, body: 'not-json' })
    const unmatchedReq = new Request(target, { method: 'POST', headers: { 'x-action': 'Other' }, body: 'not-json' })
    expect(await matchRequest([orderByHeader], matchedReq, page)).toMatchObject({ kind: 'match', rule: { id: 'header-orders' } })
    expect(await matchRequest([orderByHeader], unmatchedReq, page)).toEqual({ kind: 'none', candidate: true })
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

  it('carries Retry-After and custom headers on an HTTP mock and rejects invalid headers', () => {
    const response = { ...rule('ListOrders').response, status: 429 }
    const built = buildResponse({
      ...response,
      retryAfterSeconds: 30,
      headers: { 'X-Total-Count': '0', 'X-Trace-Id': 'trace-1', 'Cache-Control': 'private, max-age=5' },
    }, 'POST')
    expect(built.headers.get('Retry-After')).toBe('30')
    expect(built.headers.get('X-Total-Count')).toBe('0')
    expect(built.headers.get('X-Trace-Id')).toBe('trace-1')
    expect(built.headers.get('Cache-Control')).toBe('private, max-age=5')
    expect(() => buildResponse({ ...response, retryAfterSeconds: -1 }, 'POST')).toThrow('非负整数秒')
    expect(() => buildResponse({ ...response, headers: { 'Bad Header': '1' } }, 'POST')).toThrow('响应头名称无效')
    expect(() => buildResponse({ ...response, headers: { 'X-Test': 'a\r\nb' } }, 'POST')).toThrow('的值无效')
    expect(() => buildResponse({ ...response, headers: { 'X-Test': '1', 'x-test': '2' } }, 'POST')).toThrow('重复')
  })

  it('rejects an already intercepted delay when cancelled', async () => {
    const controller = new AbortController()
    const delay = abortableDelay(10_000, controller.signal)
    controller.abort(new DOMException('已停止模拟', 'AbortError'))
    await expect(delay).rejects.toHaveProperty('name', 'AbortError')
  })
})
