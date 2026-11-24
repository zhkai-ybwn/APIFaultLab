import type { ApiImportPreview, CatalogOperation, ImportedOperation, RequestCondition } from './model'
import { routeKey, validateRequestConditions } from './rules'

export const CATALOG_FORMAT = 'apifaultlab-catalog'
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024
export const MAX_IMPORT_OPERATIONS = 500
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const PRIVATE_FIELD = /password|secret|token|authorization|cookie|api[_-]?key|credential/i
const PRIVATE_VALUE = /\bBearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i
const PATH_PARAMETER = /\{[^{}\/]+\}/g

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('接口目录需要 JSON 对象')
  return value as Record<string, unknown>
}

function field(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(label + '格式无效')
  }
  return value
}

export function normalizeCatalogOperations(input: unknown): CatalogOperation[] {
  if (!Array.isArray(input) || input.length > MAX_IMPORT_OPERATIONS) throw new Error('接口目录操作数无效')
  const ids = new Set<string>()
  return input.map(entry => {
    const value = record(entry)
    const id = field(value.id, 120, '操作标识')
    if (!CATALOG_ID.test(id) || ids.has(id)) throw new Error('操作标识重复或格式无效')
    ids.add(id)
    const source = value.source
    if (source !== 'observed' && source !== 'documented' && source !== 'inferred') throw new Error('操作来源无效')
    const conditions = value.conditions === undefined ? [] : value.conditions
    if (!Array.isArray(conditions) || conditions.length > 20) throw new Error('每个操作最多包含 20 个匹配条件')
    const validated = conditions.map(inputCondition => {
      const condition = record(inputCondition)
      const path = field(condition.path, 512, '匹配字段')
      const expected = condition.value
      if (PRIVATE_FIELD.test(path) || (typeof expected === 'string' && (expected.length > 512 || PRIVATE_VALUE.test(expected)))) {
        throw new Error('接口目录条件不能保存凭据或过长的值')
      }
      return { source: condition.source, path, value: expected } as RequestCondition
    })
    validateRequestConditions(validated)
    return { id, source, title: field(value.title, 240, '操作名称'), conditions: validated }
  })
}

export function parseUnifiedCatalog(input: unknown, expectedRoute?: string): ApiImportPreview {
  const catalog = record(input)
  if (catalog.format !== CATALOG_FORMAT || catalog.schemaVersion !== 1) throw new Error('接口目录版本无效或当前版本不支持')
  const page = field(catalog.page, 4096, '目录页面')
  let normalizedPage: string
  try { normalizedPage = routeKey(page) } catch { throw new Error('目录页面需使用完整的 HTTP 或 HTTPS 地址') }
  if (normalizedPage !== page) throw new Error('目录页面格式无效或包含凭据')
  if (expectedRoute && expectedRoute !== page) throw new Error('此目录属于其他页面，请在对应网页打开后再导入')
  const proposals = normalizeCatalogOperations(catalog.operations)
  if (!proposals.length) throw new Error('接口目录中没有可导入的操作')
  const operations: ImportedOperation[] = (catalog.operations as unknown[]).map((value, index) => {
    const item = record(value)
    const method = field(item.method, 12, '请求方法')
    if (!METHODS.includes(method)) throw new Error('接口目录包含不支持的 HTTP 方法')
    const origin = field(item.origin, 320, '接口来源')
    try {
      const url = new URL(origin)
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error()
    } catch { throw new Error('接口来源需使用不含路径的 HTTP 或 HTTPS 来源') }
    const path = field(item.path, 4096, '接口路径')
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path) || /[{}]/.test(path.replace(PATH_PARAMETER, '')) ||
        path.split('/').some(part => /^(?:\.|%2e){1,2}$/i.test(part))) {
      throw new Error('接口路径须以 / 开头，不含查询参数、片段或相对路径')
    }
    const proposal = proposals[index]!
    return {
      id: proposal.id, method, serverUrl: origin, path, title: proposal.title, proposal,
      contentType: item.contentType === undefined ? undefined : field(item.contentType, 160, '响应类型'),
    }
  })
  return { operations, catalogPage: page, suggestedBaseUrl: '', warnings: [] }
}
