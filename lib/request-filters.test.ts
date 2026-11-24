import { describe, expect, it } from 'vitest'
import type { CatalogEntry, Endpoint, IgnoreRule } from './model'
import { classifyEndpoint, ignoreKey, matchesIgnore, matchesRequestFilter, normalizeIgnoreRule, parseIgnorePrefix } from './request-filters'
import { endpointKey } from './rules'

const origin = 'https://page.test'

function entry(path: string, method = 'GET', contentType?: string): CatalogEntry {
  const endpoint: Endpoint = { origin, path, method }
  return { endpoint, key: endpointKey(endpoint), imported: false, observed: true, realSeen: true, hitCount: 0, contentType }
}

describe('quick request filters', () => {
  it('keeps business JSON distinct from asset JSON and identifies map styles and tiles', () => {
    expect(classifyEndpoint(entry('/api/report', 'GET', 'application/json'))).toBe('api')
    expect(classifyEndpoint(entry('/assets/i18n/en.json', 'GET', 'application/json'))).toBe('static')
    expect(classifyEndpoint(entry('/styles/terrain/en/style.json', 'GET', 'application/json'))).toBe('map')
    expect(classifyEndpoint(entry('/terrain/5/15/13.png', 'GET', 'image/png'))).toBe('map')
    expect(classifyEndpoint(entry('/api/report', 'GET', 'image/png'))).toBe('static')
    expect(classifyEndpoint(entry('/api/report', 'POST', 'image/png'))).toBe('api')
  })

  it('can still show an active simulation for an endpoint hidden by an ignore rule', () => {
    const request = entry('/assets/i18n.json')
    const rules = [parseIgnorePrefix('/assets/')]
    expect(matchesRequestFilter(request, 'all', rules)).toBe(false)
    expect(matchesRequestFilter(request, 'static', rules)).toBe(false)
    expect(matchesRequestFilter(request, 'ignored', rules)).toBe(true)
    expect(matchesRequestFilter(request, 'active', rules, true)).toBe(true)
    expect(matchesRequestFilter(request, 'active', rules)).toBe(false)
  })
})

describe('saved request ignores', () => {
  it('matches whole path segments and respects an explicit request origin', () => {
    const prefix = parseIgnorePrefix('https://maps.test:8443/tiles/')
    const tile = { method: 'GET', origin: 'https://maps.test:8443', path: '/tiles/8/0/1.png' }
    expect(matchesIgnore(prefix, tile)).toBe(true)
    expect(matchesIgnore(prefix, { ...tile, path: '/tiles' })).toBe(true)
    expect(matchesIgnore(prefix, { ...tile, path: '/tiles-v2/8/0/1.png' })).toBe(false)
    expect(matchesIgnore(prefix, { ...tile, origin: 'https://maps.test' })).toBe(false)
    expect(ignoreKey(parseIgnorePrefix('/assets/'))).toBe(ignoreKey(parseIgnorePrefix('/assets')))
  })

  it('keeps selected interface ignores specific to their request method', () => {
    const endpoint = entry('/api/shared').endpoint
    const rule: IgnoreRule = { kind: 'endpoint', endpoint }
    expect(matchesIgnore(rule, endpoint)).toBe(true)
    expect(matchesIgnore(rule, { ...endpoint, method: 'POST' })).toBe(false)
    expect(matchesIgnore(rule, { ...endpoint, path: '/api/shared/child' })).toBe(false)
  })

  it('rejects URL inputs that could broaden or obscure the prefix', () => {
    for (const input of ['', '//maps.test/a', 'ftp://maps.test/a', '/assets?test=1', '/assets#anchor', '/assets/../', 'https://user:pass@maps.test/a', 'https://maps.test/assets/%2e%2E']) {
      expect(() => parseIgnorePrefix(input)).toThrow()
    }
    expect(parseIgnorePrefix('/')).toEqual({ kind: 'prefix', path: '/' })
    expect(() => normalizeIgnoreRule({ kind: 'prefix', origin: 'https://maps.test', path: '' })).toThrow()
    expect(() => normalizeIgnoreRule({ kind: 'prefix', origin: '/assets', path: '/tiles' })).toThrow()
  })
})
