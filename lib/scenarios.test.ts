import { describe, expect, it } from 'vitest'
import { buildResponse } from './rules'
import { applyScenario, normalizeCustomScenario, presetResponse, scenarioGroups } from './scenarios'
import type { CatalogEntry } from './model'

const entry: CatalogEntry = {
  key: 'orders', endpoint: { method: 'GET', origin: 'https://example.test', path: '/orders' },
  imported: false, observed: true, realSeen: true, hitCount: 0,
  sample: '{"orders":[1]}', contentType: 'application/json',
}

describe('response scenarios', () => {
  it('provides the requested HTTP statuses and models a rate-limit retry hint', async () => {
    const statusOptions = scenarioGroups.slice(0, 2).flatMap(group => group.options)
    expect(statusOptions.map(option => option.code)).toEqual(['400', '401', '403', '404', '429', '500', '502', '503', '504'])
    const limited = buildResponse(presetResponse('429', entry), 'GET')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('30')
    expect(await limited.json()).toEqual({ message: 'Too Many Requests' })
  })

  it('keeps slow-response sampling, empty data, and a missing body distinct', async () => {
    expect(presetResponse('slow', entry)).toMatchObject({ delayMs: 3000, body: entry.sample, contentType: entry.contentType })
    expect(presetResponse('empty', entry).body).toBe('[]')
    expect(presetResponse('empty-object', entry).body).toBe('{}')
    expect(presetResponse('empty-null', entry).body).toBe('null')
    const empty = buildResponse(presetResponse('no-content', entry), 'GET')
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
  })

  it('copies saved scenarios before use and preserves intentional parse failures', () => {
    const response = { ...presetResponse('500', entry), body: '{' }
    expect(() => normalizeCustomScenario({ id: 'decode', name: ' 无效 JSON ', response })).toThrow('发送无效 JSON')
    const scenario = normalizeCustomScenario({ id: 'decode', name: ' 无效 JSON ', response, allowInvalidJson: true })
    const single = applyScenario({ kind: 'custom', scenario }, entry)
    const batch = applyScenario({ kind: 'custom', scenario }, entry)
    single.response.body = '{}'
    expect(batch).toEqual({ response, allowInvalidJson: true })
    expect(scenario).toEqual({ id: 'decode', name: '无效 JSON', response, allowInvalidJson: true })
  })
})
