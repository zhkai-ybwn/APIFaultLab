import type { Endpoint, JsonScalar, MockResponse, RequestCondition, RouteGrouping, Rule } from './model'

export const MAX_RESPONSE_BYTES = 512 * 1024
export const MAX_RULE_HITS = 1000
const MAX_CONDITION_BYTES = 256 * 1024
const MAX_CUSTOM_HEADERS = 20
const MAX_RULES = 200
const MAX_RULE_SET_BYTES = 4 * 1024 * 1024
const PATH_VARIABLE = /\{[^{}\/]+\}/g
export const HTTP_METHOD_PATTERN = /^[!#$%&'*+.^_`|~\dA-Z-]+$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const JSON_MEDIA = /(?:^|[+/])json(?:\s*;|$)/i

export function isValidHttpMethod(method: unknown): method is string {
  return typeof method === 'string' && method.length > 0 && method.length <= 32 && HTTP_METHOD_PATTERN.test(method)
}

export function normalizeResponseHeaders(input?: Record<string, string>): Record<string, string> | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('自定义响应头格式无效')
  }
  const entries = Object.entries(input)
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new Error(`最多可设置 ${MAX_CUSTOM_HEADERS} 个自定义响应头`)
  }
  const seen = new Set<string>()
  const normalized: Record<string, string> = {}
  for (const [rawName, value] of entries) {
    const name = rawName.trim()
    if (!name || name.length > 128 || !HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`响应头名称无效：${rawName || '（空）'}`)
    }
    const lower = name.toLowerCase()
    if (seen.has(lower)) {
      throw new Error(`响应头 ${name} 重复，请合并为一项`)
    }
    if (typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/.test(value)) {
      throw new Error(`响应头 ${name} 的值无效`)
    }
    seen.add(lower)
    normalized[name] = value
  }
  return seen.size ? normalized : undefined
}
const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 204: 'No Content', 205: 'Reset Content', 400: 'Bad Request',
  401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}

function httpUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('当前页面地址需使用 HTTP 或 HTTPS')
  }
  return url
}

export function routeKey(input: string, grouping: RouteGrouping = 'exact'): string {
  const url = httpUrl(input)
  if (grouping === 'ignore-query') {
    const hash = url.hash.includes('?') ? url.hash.slice(0, url.hash.indexOf('?')) : url.hash
    return `${url.origin}${url.pathname}${hash === '#' ? '' : hash}`
  }
  return `${url.origin}${url.pathname}${url.search}${url.hash}`
}

export function endpointFromUrl(method: string, input: string): Endpoint {
  const url = httpUrl(input)
  return { method: method.toUpperCase(), origin: url.origin, path: url.pathname }
}

export function endpointKey(endpoint: Endpoint): string {
  return JSON.stringify([endpoint.method, endpoint.origin, endpoint.path, endpoint.template === true])
}

function escapeRegex(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesPath(endpoint: Endpoint, path: string): boolean {
  if (!endpoint.template) return endpoint.path === path
  const tokens = endpoint.path.split(/(\{[^{}\/]+\})/)
  const pattern = tokens.map((token, index) => index % 2 === 0 ? escapeRegex(token) : '[^/]+').join('')
  return new RegExp(`^${pattern}$`).test(path)
}

export function endpointCovers(expected: Endpoint, actual: Endpoint): boolean {
  return expected.method === actual.method && expected.origin === actual.origin && matchesPath(expected, actual.path)
}

function templateSegmentsOverlap(left: string, right: string): boolean {
  const leftTokens = left.split(/(\{[^{}\/]+\})/)
  const rightTokens = right.split(/(\{[^{}\/]+\})/)
  const leftPrefix = leftTokens[0] ?? ''
  const rightPrefix = rightTokens[0] ?? ''
  if (!leftPrefix.startsWith(rightPrefix) && !rightPrefix.startsWith(leftPrefix)) return false
  const leftSuffix = leftTokens.at(-1) ?? ''
  const rightSuffix = rightTokens.at(-1) ?? ''
  return leftSuffix.endsWith(rightSuffix) || rightSuffix.endsWith(leftSuffix)
}

function endpointsOverlap(left: Endpoint, right: Endpoint): boolean {
  if (left.method !== right.method || left.origin !== right.origin) return false
  if (!left.template) return matchesPath(right, left.path)
  if (!right.template) return matchesPath(left, right.path)

  const leftSegments = left.path.split('/')
  const rightSegments = right.path.split('/')
  if (leftSegments.length !== rightSegments.length) return false
  return leftSegments.every((part, index) => {
    const other = rightSegments[index]
    if (other === undefined) return false
    if (!part.includes('{')) return matchesPath({ ...right, path: other }, part)
    if (!other.includes('{')) return matchesPath({ ...left, path: part }, other)
    return templateSegmentsOverlap(part, other)
  })
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/')) return [pointer]
  if (/~(?:[^01]|$)/.test(pointer)) throw new Error('JSON 字段路径格式不正确')
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function conditionKey(condition: RequestCondition): string {
  if (condition.source === 'query') return `query:${condition.path}`
  if (condition.source === 'header') return `header:${condition.path.trim().toLowerCase()}`
  return `json:${JSON.stringify(pointerParts(condition.path))}`
}

function jsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
}

export function validateRequestConditions(conditions: RequestCondition[]): void {
  if (!Array.isArray(conditions) || conditions.length > 20) throw new Error('每条规则最多包含 20 个条件')
  const fields = new Set<string>()
  for (const condition of conditions) {
    if (!condition.path || condition.path.length > 512 || !jsonScalar(condition.value) ||
        (condition.source !== 'query' && condition.source !== 'json' && condition.source !== 'header') ||
        ((condition.source === 'query' || condition.source === 'header') && typeof condition.value !== 'string')) {
      throw new Error('请检查查询参数、请求头或 JSON 字段条件')
    }
    if (condition.source === 'header' && (condition.path.length > 128 || !HEADER_NAME_PATTERN.test(condition.path))) {
      throw new Error('请求头名称格式不正确')
    }
    const key = conditionKey(condition)
    if (fields.has(key)) throw new Error('同一字段只能配置一个条件')
    fields.add(key)
  }
}

export function validateRuleSet(rules: Rule[]): void {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error(`最多可启用 ${MAX_RULES} 条规则`)

  const identifiers = new Set<string>()
  const encoder = new TextEncoder()
  let bytes = 0
  for (const rule of rules) {
    const { endpoint } = rule
    if (!rule.id || identifiers.has(rule.id)) throw new Error('规则标识重复或缺失')
    identifiers.add(rule.id)
    if (routeKey(rule.routeKey) !== rule.routeKey) throw new Error('页面地址不完整')
    if (!isValidHttpMethod(endpoint.method) || httpUrl(endpoint.origin).origin !== endpoint.origin ||
        !endpoint.path.startsWith('/') || /[?#\\]/.test(endpoint.path) ||
        endpoint.path.length > 4096) {
      throw new Error('接口地址或请求方法无效')
    }
    if (endpoint.template && !endpoint.path.match(PATH_VARIABLE)) throw new Error('路径模板缺少有效的参数')
    if (rule.maxHits !== undefined && (!Number.isSafeInteger(rule.maxHits) || rule.maxHits < 1 || rule.maxHits > MAX_RULE_HITS)) {
      throw new Error(`最多生效次数应为 1 到 ${MAX_RULE_HITS} 的整数`)
    }
    validateRequestConditions(rule.conditions)
    buildResponse(rule.response, endpoint.method)
    bytes += encoder.encode(JSON.stringify(rule)).byteLength
    if (bytes > MAX_RULE_SET_BYTES) throw new Error('当前标签页的规则总大小不得超过 4 MiB')
  }

  for (const [index, left] of rules.entries()) {
    for (const right of rules.slice(index + 1)) {
      if (left.routeKey !== right.routeKey || !endpointsOverlap(left.endpoint, right.endpoint)) continue
      const exclusive = left.conditions.some((condition) => right.conditions.some((pair) =>
        conditionKey(condition) === conditionKey(pair) && condition.value !== pair.value,
      ))
      if (!exclusive) {
        throw new Error(`${left.endpoint.method} ${left.endpoint.path} 的规则范围重叠，请收紧匹配条件`)
      }
    }
  }
}

export async function readLimitedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
  timeoutMs = 2000,
): Promise<string> {
  signal?.throwIfAborted()
  if (!stream) return ''

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  let completed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const limit = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('读取正文超时')), timeoutMs)
    onAbort = () => reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), limit])
      if (done) {
        completed = true
        return text + decoder.decode()
      }
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('正文超过读取上限')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (!completed) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function fieldValue(value: unknown, path: string): unknown {
  let current = value
  for (const part of pointerParts(path)) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export type RequestMatch =
  | { kind: 'match'; rule: Rule }
  | { kind: 'none'; candidate: boolean }
  | { kind: 'invalid'; detail: string; ruleId?: string }

export async function matchRequest(
  rules: Rule[], request: Request, initiatingRoute: string, { inspectBody = true } = {},
): Promise<RequestMatch> {
  const endpoint = endpointFromUrl(request.method, request.url)
  const candidates = rules.filter((rule) => rule.routeKey === initiatingRoute && endpointCovers(rule.endpoint, endpoint))
  if (candidates.length === 0) return { kind: 'none', candidate: false }

  const query = new URL(request.url).searchParams
  const selected = candidates.filter((rule) => rule.conditions.every((condition) => {
    if (condition.source === 'query') {
      const values = query.getAll(condition.path)
      return values.length === 1 && values[0] === condition.value
    }
    if (condition.source === 'header') {
      return request.headers.get(condition.path) === condition.value
    }
    return true
  }))
  if (selected.length === 0) return { kind: 'none', candidate: true }

  const unconditional = selected.find((rule) => rule.conditions.every((condition) => condition.source !== 'json'))
  if (unconditional) return { kind: 'match', rule: unconditional }

  try {
    if (!inspectBody) throw new Error('无法在保留原始调用的同时读取流式请求正文')
    const media = request.headers.get('content-type') ?? ''
    if (!JSON_MEDIA.test(media)) throw new Error('请求正文未声明为 JSON')
    const declared = Number(request.headers.get('content-length'))
    if (declared > MAX_CONDITION_BYTES) throw new Error('请求正文超过读取上限')
    const clone = request.clone()
    const body: unknown = JSON.parse(await readLimitedText(clone.body, MAX_CONDITION_BYTES, request.signal))
    const matching = selected.find((rule) => rule.conditions.every((condition) =>
      condition.source !== 'json' || fieldValue(body, condition.path) === condition.value,
    ))
    return matching ? { kind: 'match', rule: matching } : { kind: 'none', candidate: true }
  } catch (error) {
    return {
      kind: 'invalid',
      detail: `无法匹配请求正文：${error instanceof SyntaxError ? 'JSON 格式不正确' :
        error instanceof Error ? error.message : '读取失败'}`,
      ruleId: selected.length === 1 ? selected[0]?.id : undefined,
    }
  }
}

export function buildResponse(response: MockResponse, method: string): Response {
  if (!Number.isInteger(response.delayMs) || response.delayMs < 0 || response.delayMs > 60_000) {
    throw new Error('延迟应为 0 到 60000 毫秒')
  }
  if (response.kind === 'network') return Response.error()
  if (response.kind !== 'http') throw new Error('响应场景无效')

  const { status, body, contentType } = response
  if (!Number.isInteger(status) || !((status >= 200 && status <= 299) || (status >= 400 && status <= 599))) {
    throw new Error('请选择 2xx、4xx 或 5xx 状态码')
  }
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('模拟正文不得超过 512 KiB')
  }
  if (typeof contentType !== 'string' || /[\r\n]/.test(contentType) || contentType.length > 256) {
    throw new Error('响应媒体类型无效')
  }
  const customHeaders = normalizeResponseHeaders(response.headers)
  const hasBody = method !== 'HEAD' && status !== 204 && status !== 205
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  if (status !== 204 && status !== 205 && contentType) headers.set('Content-Type', contentType)
  if (response.retryAfterSeconds !== undefined) {
    if (!Number.isSafeInteger(response.retryAfterSeconds) || response.retryAfterSeconds < 0) {
      throw new Error('Retry-After 请填写非负整数秒')
    }
    headers.set('Retry-After', String(response.retryAfterSeconds))
  }
  for (const [name, value] of Object.entries(customHeaders ?? {})) headers.set(name, value)
  return new Response(hasBody ? body : null, { status, statusText: STATUS_TEXT[status], headers })
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (ms <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
