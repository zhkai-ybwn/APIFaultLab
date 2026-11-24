import type { CatalogEntry, Endpoint, IgnoreRule } from './model'
import { endpointCovers, endpointKey } from './rules'

export type RequestFilter = 'all' | 'api' | 'static' | 'map' | 'active' | 'ignored'

type RequestCategory = 'api' | 'static' | 'map'
type PrefixRule = Extract<IgnoreRule, { kind: 'prefix' }>

const MAX_PATH_LENGTH = 4096
const STATIC_EXTENSION = /\.(?:avif|bmp|css|gif|ico|jpe?g|jsx?|mjs|mp[34]|ogg|otf|png|svg|ttf|webm|webp|woff2?)$/i
const STATIC_DIRECTORY = /^\/(?:assets|fonts|images|img|locales|static)(?:\/|$)/i
const MAP_TILE_PATH = /\/\d+\/\d+\/\d+\.(?:avif|jpe?g|png|webp)$/i
const MAP_VECTOR_TILE = /\.(?:mvt|pbf)$/i
const MAP_STYLE = /(?:^|\/)styles\/.*\/style\.json$|\/(?:tiles?|tilejson)\/.*\.json$/i
const METHOD = /^[!#$%&'*+.^_`|~\dA-Z-]+$/

export function classifyEndpoint(entry: CatalogEntry): RequestCategory {
  if (entry.endpoint.method !== 'GET' && entry.endpoint.method !== 'HEAD') return 'api'
  const path = entry.endpoint.path
  const media = (entry.contentType ?? entry.last?.contentType ?? '').toLowerCase()
  if (MAP_TILE_PATH.test(path) || MAP_VECTOR_TILE.test(path) || MAP_STYLE.test(path) ||
      /^(?:application\/(?:vnd\.mapbox-vector-tile|x-protobuf))(?=\s*;|$)/.test(media) && /\/(?:tiles?|vt)(?:\/|$)/i.test(path)) {
    return 'map'
  }
  if (STATIC_DIRECTORY.test(path) || STATIC_EXTENSION.test(path) ||
      /^(?:image\/|font\/|audio\/|video\/|text\/css(?=\s*;|$)|(?:text|application)\/(?:javascript|ecmascript)(?=\s*;|$))/.test(media)) {
    return 'static'
  }
  return 'api'
}

function validatePath(path: string) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#\\\u0000-\u001f\u007f]/.test(path) || path.length > MAX_PATH_LENGTH) {
    throw new Error('请输入以 / 开头的路径，或 HTTP(S) 接口地址，路径不含查询参数或片段')
  }
  if (path.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new Error('忽略前缀不能含有相对路径段')
  }
}

export function parseIgnorePrefix(text: string): PrefixRule {
  const input = text.trim()
  if (!input || input.startsWith('//') || /[?#\\\u0000-\u001f\u007f]/.test(input)) {
    throw new Error('请输入以 / 开头的路径，或 HTTP(S) 接口地址，路径不含查询参数或片段')
  }

  if (input.startsWith('/')) {
    validatePath(input)
    const path = new URL(input, 'https://example.invalid').pathname.replace(/\/+$/, '') || '/'
    return { kind: 'prefix', path }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('请输入以 / 开头的路径，或完整的 HTTP(S) 接口地址')
  }
  if (!/^https?:\/\//i.test(input) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('接口地址须使用 HTTP(S)，并且不能包含账号或密码')
  }
  const rawPathStart = input.indexOf('/', input.indexOf('://') + 3)
  const rawPath = rawPathStart < 0 ? '/' : input.slice(rawPathStart)
  validatePath(rawPath)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  return { kind: 'prefix', origin: url.origin, path }
}

export function normalizeIgnoreRule(rule: IgnoreRule): IgnoreRule {
  if (rule.kind === 'prefix') {
    validatePath(rule.path)
    if (rule.origin !== undefined) {
      const url = new URL(rule.origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== rule.origin) {
        throw new Error('忽略前缀的接口来源无效')
      }
    }
    return parseIgnorePrefix(`${rule.origin ?? ''}${rule.path}`)
  }
  if (rule.kind !== 'endpoint' || !rule.endpoint) throw new Error('忽略规则无效')
  const { origin, path, method, template } = rule.endpoint
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || typeof method !== 'string' || !METHOD.test(method)) {
    throw new Error('忽略接口的地址或方法无效')
  }
  validatePath(path)
  return { kind: 'endpoint', endpoint: { origin, path, method, ...(template === true ? { template: true } : {}) } }
}

export function ignoreKey(rule: IgnoreRule): string {
  if (rule.kind === 'endpoint') return `endpoint:${endpointKey(rule.endpoint)}`
  return `prefix:${JSON.stringify([rule.origin ?? null, rule.path.replace(/\/+$/, '') || '/'])}`
}

export function ignoreLabel(rule: IgnoreRule): string {
  return rule.kind === 'endpoint'
    ? `${rule.endpoint.method} ${rule.endpoint.origin}${rule.endpoint.path}`
    : `${rule.origin ?? ''}${rule.path}`
}

export function matchesIgnore(rule: IgnoreRule, endpoint: Endpoint): boolean {
  if (rule.kind === 'endpoint') return endpointCovers(rule.endpoint, endpoint)
  if (rule.origin && rule.origin !== endpoint.origin) return false
  const path = rule.path.replace(/\/+$/, '') || '/'
  return path === '/' || endpoint.path === path || endpoint.path.startsWith(`${path}/`)
}

export function matchesRequestFilter(
  entry: CatalogEntry, filter: RequestFilter, ignores: readonly IgnoreRule[], active = false,
): boolean {
  if (filter === 'active') return active
  const ignored = ignores.some(rule => matchesIgnore(rule, entry.endpoint))
  if (filter === 'ignored') return ignored
  return !ignored && (filter === 'all' || classifyEndpoint(entry) === filter)
}
