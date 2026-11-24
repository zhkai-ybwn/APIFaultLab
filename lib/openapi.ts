import { parseDocument } from 'yaml'
import { CATALOG_FORMAT, MAX_IMPORT_BYTES, MAX_IMPORT_OPERATIONS, parseUnifiedCatalog } from './catalog'
import type { ApiImportPreview, CatalogEntry, ImportedOperation, MockResponse } from './model'
import { endpointKey, MAX_RESPONSE_BYTES } from './rules'

type DocumentObject = Record<string, unknown>

const METHODS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'] as const
const SENSITIVE_FIELD = /(?:password|secret|token|authorization|cookie|api[_-]?key|credential)/i
const SENSITIVE_CONTENT = /\bBearer\s+\S+|(?:authorization|cookie|password|secret|token|api[_-]?key)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i
const MAX_ADDRESS_LENGTH = 4096
const EXAMPLE_LIMIT_WARNING = '部分响应示例超过展开限额，已跳过。接口信息仍可导入。'
const EXAMPLE_CYCLE_WARNING = '已跳过响应示例中的循环引用。'

export interface ImportOptions {
  includeExamples?: boolean
  expectedRoute?: string
}

interface WorkBudget { nodes: number; characters: number }
interface ExampleBudget { item: WorkBudget; document: WorkBudget }

class ExampleLimit extends Error {}

function spend(budget: ExampleBudget, value?: string) {
  const characters = (value?.length ?? 0) + 12
  for (const limit of [budget.document, budget.item]) {
    limit.nodes -= 1
    limit.characters -= characters
    if (limit.nodes < 0 || limit.characters < 0) throw new ExampleLimit()
  }
}

function object(value: unknown): DocumentObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as DocumentObject : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readDocument(text: string): unknown {
  const input = text.replace(/^\uFEFF/, '').trim()
  if (!input || text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('请选择非空的接口文档，大小不超过 8 MiB')
  }
  if (input.startsWith('{') || input.startsWith('[')) {
    try { return JSON.parse(input) } catch { /* YAML also accepts flow mappings */ }
  }
  const document = parseDocument(input, { stringKeys: true, uniqueKeys: true })
  if (document.errors.length || document.warnings.some((warning) => warning.code === 'TAG_RESOLVE_FAILED')) {
    throw new Error('接口文档 YAML 格式不正确或包含不支持的标签')
  }
  return document.toJS({ maxAliasCount: 30 })
}

function createResolver(root: DocumentObject, warnings: Set<string>) {
  return (value: unknown): DocumentObject | undefined => {
    const seen = new Set<string>()
    let selected = object(value)
    while (selected && typeof selected.$ref === 'string') {
      const reference = selected.$ref
      if (!reference.startsWith('#/')) {
        warnings.add('已跳过文件外的引用，其他接口仍可导入')
        return undefined
      }
      if (seen.has(reference) || seen.size >= 16 || reference.length > 4096) {
        warnings.add('已跳过循环或过深的文档引用')
        return undefined
      }
      seen.add(reference)

      try {
        const path = decodeURIComponent(reference.slice(2)).split('/')
        let current: unknown = root
        for (const key of path) {
          const field = key.replace(/~1/g, '/').replace(/~0/g, '~')
          const parent = object(current)
          current = parent && Object.hasOwn(parent, field) ? parent[field] : undefined
        }
        selected = object(current)
      } catch {
        selected = undefined
      }
      if (!selected) warnings.add('部分本地引用无法解析')
    }
    return selected
  }
}

function serverUrl(servers: unknown): string | undefined {
  if (!Array.isArray(servers)) return undefined
  for (const entry of servers) {
    const server = object(entry)
    const url = string(server?.url)
    if (!url || url.length > MAX_ADDRESS_LENGTH) continue
    const variables = object(server?.variables)
    let size = url.length
    const expanded = url.replace(/\{([^{}]+)\}/g, (match: string, name: string) => {
      const fallback = object(variables?.[name])?.default
      if (typeof fallback !== 'string' || size - match.length + fallback.length > MAX_ADDRESS_LENGTH) return match
      size += fallback.length - match.length
      return fallback
    })
    if (!/[{}]/.test(expanded)) return expanded
  }
  return undefined
}

function safeExample(value: unknown, budget: ExampleBudget, depth = 0): unknown {
  spend(budget, typeof value === 'string' ? value : undefined)
  if (depth > 12) return null
  if (typeof value === 'string' && SENSITIVE_CONTENT.test(value)) return null
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeExample(item, budget, depth + 1))
  const record = object(value)
  if (!record) return value
  const entries: [string, unknown][] = []
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue
    spend(budget, key)
    entries.push([key, SENSITIVE_FIELD.test(key) ? null : safeExample(record[key], budget, depth + 1)])
    if (entries.length === 100) break
  }
  return Object.fromEntries(entries)
}

type Resolve = ReturnType<typeof createResolver>

function fromSchema(value: unknown, resolve: Resolve, budget: ExampleBudget, warnings: Set<string>, ancestors = new Set<DocumentObject>(), depth = 0): unknown {
  spend(budget)
  if (depth > 6) return undefined
  const schema = resolve(value)
  if (!schema) return undefined
  if (ancestors.has(schema)) {
    warnings.add(EXAMPLE_CYCLE_WARNING)
    return undefined
  }
  if (schema.example !== undefined) return schema.example
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0]
  if (schema.const !== undefined) return schema.const
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]

  const properties = object(schema.properties)
  if (properties || schema.type === 'object') {
    const entries: [string, unknown][] = []
    ancestors.add(schema)
    try {
      for (const key in properties ?? {}) {
        if (!properties || !Object.hasOwn(properties, key)) continue
        spend(budget, key)
        entries.push([key, SENSITIVE_FIELD.test(key) ? null : fromSchema(properties[key], resolve, budget, warnings, ancestors, depth + 1) ?? null])
        if (entries.length === 30) break
      }
    } finally {
      ancestors.delete(schema)
    }
    return Object.fromEntries(entries)
  }
  if (schema.type === 'array') return []
  if (schema.type === 'string') return ''
  if (schema.type === 'integer' || schema.type === 'number') return 0
  if (schema.type === 'boolean') return false
  if (schema.type === 'null') return null
  return undefined
}

function supportedMedia(value: string): boolean {
  return /^application\/(?:json|[^;]+\+json)(?:;|$)|^text\//i.test(value)
}

function exampleResponse(status: number, media: string, value: unknown, budget: ExampleBudget): MockResponse | undefined {
  if (status === 204 || status === 205) {
    return { kind: 'http', status, body: '', contentType: '', delayMs: 0 }
  }
  if (value === undefined) return undefined
  const sanitized = safeExample(value, budget)
  if (sanitized === null && typeof value === 'string') return undefined
  const body = media.startsWith('text/') && typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new ExampleLimit()
  return { kind: 'http', status, body, contentType: media, delayMs: 0 }
}

function responseDetails(
  operation: DocumentObject,
  root: DocumentObject,
  swagger: boolean,
  resolve: Resolve,
  warnings: Set<string>,
  budget?: ExampleBudget,
): Pick<ImportedOperation, 'contentType' | 'example'> {
  const responses = object(operation.responses)
  const succeeded = Object.keys(responses ?? {}).filter((status) => /^2\d\d$/.test(status)).sort()
  const status = Number(succeeded[0] ?? 200)
  const response = resolve(responses?.[succeeded[0] ?? 'default'] ?? responses?.['2XX'] ?? responses?.default)
  if (!response) return {}
  if (status === 204 || status === 205) return budget ? { example: exampleResponse(status, '', undefined, budget) } : {}

  function details(media: string, read: (limits: ExampleBudget) => unknown) {
    if (media.length > 160) return {}
    if (!budget || !supportedMedia(media)) return { contentType: media }
    try {
      return { contentType: media, example: exampleResponse(status, media, read(budget), budget) }
    } catch (cause) {
      if (!(cause instanceof ExampleLimit)) throw cause
      warnings.add(EXAMPLE_LIMIT_WARNING)
      return { contentType: media }
    }
  }

  if (swagger) {
    const examples = object(response.examples)
    const produces = operation.produces ?? root.produces
    const declared = Array.isArray(produces) ? produces.filter((item): item is string => typeof item === 'string') : []
    const candidates = [...Object.keys(examples ?? {}), ...declared]
    const media = candidates.find((item) => /^application\/(?:json|[^;]+\+json)/i.test(item)) ??
      candidates.find(supportedMedia) ?? candidates[0] ?? (response.schema ? 'application/json' : undefined)
    if (!media) return {}
    return details(media, limits => examples && Object.hasOwn(examples, media)
      ? examples[media] : fromSchema(response.schema, resolve, limits, warnings))
  }

  const content = object(response.content)
  const mediaTypes = Object.keys(content ?? {})
  const media = mediaTypes.find((item) => /^application\/(?:json|[^;]+\+json)/i.test(item)) ??
    mediaTypes.find(supportedMedia) ?? mediaTypes[0]
  if (!media || media.length > 160) return {}
  const definition = resolve(content?.[media])
  if (!definition) return { contentType: media }

  return details(media, limits => {
    if (definition.example !== undefined) return definition.example
    const examples = object(definition.examples)
    for (const key in examples ?? {}) {
      if (!examples || !Object.hasOwn(examples, key)) continue
      spend(limits, key)
      const example = resolve(examples[key])
      if (example?.externalValue) warnings.add('已跳过外部示例链接')
      if (example && Object.hasOwn(example, 'value')) {
        return example.value
      }
    }
    return fromSchema(definition.schema, resolve, limits, warnings)
  })
}

export function parseApiDocument(text: string, options: ImportOptions = {}): ApiImportPreview {
  const root = object(readDocument(text))
  if (root?.format === CATALOG_FORMAT) return parseUnifiedCatalog(root, options.expectedRoute)
  const swagger = root?.swagger === '2.0'
  if (!root || (!swagger && !/^3\.[01](?:\.\d+)?$/.test(string(root.openapi) ?? ''))) {
    throw new Error('请选择 OpenAPI 3.0/3.1、Swagger 2.0 或 APIFaultLab 接口目录文件')
  }
  const paths = object(root.paths)
  if (!paths) throw new Error('接口文档缺少 paths')

  const warnings = new Set<string>()
  const resolve = createResolver(root, warnings)
  const host = string(root.host)
  const scheme = Array.isArray(root.schemes) && root.schemes.includes('http') && !root.schemes.includes('https') ? 'http' : 'https'
  const swaggerBase = swagger ? `${host ? `${scheme}://${host}` : ''}${string(root.basePath) ?? ''}` : ''
  if (swaggerBase.length > MAX_ADDRESS_LENGTH) throw new Error('文档中的 API 地址过长')
  const suggestedBaseUrl = swagger ? swaggerBase : serverUrl(root.servers) ?? ''
  const operations: ImportedOperation[] = []
  const documentBudget: WorkBudget = { nodes: 30_000, characters: 1024 * 1024 }

  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/') || /[?#\\]/.test(path) || path.length > 4096) continue
    const definition = resolve(item)
    if (!definition) continue
    for (const method of METHODS) {
      const operation = resolve(definition[method])
      if (!operation) continue
      if (operations.length >= MAX_IMPORT_OPERATIONS) throw new Error(`单次导入最多支持 ${MAX_IMPORT_OPERATIONS} 个接口，请按业务范围拆分文档`)
      const response = responseDetails(operation, root, swagger, resolve, warnings, options.includeExamples ? {
        item: { nodes: 1500, characters: 128 * 1024 }, document: documentBudget,
      } : undefined)
      operations.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(), path,
        title: (string(operation.summary) ?? string(operation.operationId) ?? `${method.toUpperCase()} ${path}`).slice(0, 240),
        serverUrl: swagger ? suggestedBaseUrl : serverUrl(operation.servers) ?? serverUrl(definition.servers) ?? suggestedBaseUrl,
        ...response,
      })
    }
  }
  if (operations.length === 0) throw new Error('文档中没有可导入的 HTTP 接口')
  return { operations, suggestedBaseUrl, warnings: [...warnings] }
}

function normalizeApiPath(origin: string, path: string): string {
  let prefix = '__api_fault_lab_path_'
  while (path.includes(prefix)) prefix += '_'
  const placeholders = new Map<string, string>()
  const temporary = path.replace(/\{[^{}\/]+\}/g, (variable) => {
    const key = `${prefix}${placeholders.size}__`
    placeholders.set(key, variable)
    return key
  })
  let normalized = new URL(`${origin}${temporary}`).pathname
  for (const [key, variable] of placeholders) normalized = normalized.replace(key, variable)
  return normalized
}

export function mapImportedOperations(operations: ImportedOperation[], baseUrl?: string, currentSite?: string): CatalogEntry[] {
  if (operations.length > MAX_IMPORT_OPERATIONS) throw new Error(`一次最多加入 ${MAX_IMPORT_OPERATIONS} 个操作`)
  const entries = new Map<string, CatalogEntry>()
  for (const operation of operations) {
    let base: URL
    try {
      const override = baseUrl?.trim()
      const reference = override || operation.serverUrl || currentSite || ''
      if (reference.length > MAX_ADDRESS_LENGTH) throw new Error('API 地址过长')
      base = override ? new URL(override) : new URL(reference, currentSite || undefined)
    } catch {
      throw new Error(`请为 ${operation.id} 填写完整 API 地址，例如 https://api.example.test/v1`)
    }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('API 地址应为 HTTP 或 HTTPS，可包含路径前缀')
    }
    const combined = `${base.pathname.replace(/\/$/, '')}${operation.path}`
    const path = normalizeApiPath(base.origin, combined)
    if (path.length > MAX_ADDRESS_LENGTH) throw new Error('映射后的接口路径过长')
    const endpoint = { method: operation.method, origin: base.origin, path, template: /\{[^{}\/]+\}/.test(path) }
    const key = endpointKey(endpoint)
    const previous = entries.get(key)
    if (previous) {
      if (operation.proposal) (previous.operations ??= []).push(operation.proposal)
      continue
    }
    entries.set(key, {
      key, endpoint, title: operation.title, operations: operation.proposal ? [operation.proposal] : undefined,
      imported: true, observed: false, realSeen: false,
      contentType: operation.contentType, example: operation.example, hitCount: 0,
    })
  }
  return [...entries.values()]
}
