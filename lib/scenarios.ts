import type { CatalogEntry, CustomScenario, MockResponse } from './model'
import { buildResponse } from './rules'

const json = 'application/json'

const httpErrors = {
  '400': { label: '请求参数错误', message: 'Bad Request' },
  '401': { label: '未登录或凭据过期', message: 'Unauthorized' },
  '403': { label: '没有访问权限', message: 'Forbidden' },
  '404': { label: '接口不存在', message: 'Not Found' },
  '429': { label: '请求过多', message: 'Too Many Requests' },
  '500': { label: '服务内部异常', message: 'Internal Server Error' },
  '502': { label: '上游响应异常', message: 'Bad Gateway' },
  '503': { label: '服务暂时不可用', message: 'Service Unavailable' },
  '504': { label: '网关等待超时', message: 'Gateway Timeout' },
} as const

type ErrorPreset = keyof typeof httpErrors
export type Preset = ErrorPreset | 'empty' | 'empty-object' | 'empty-null' | 'no-content' | 'business-error' | 'slow' | 'network'

interface PresetOption {
  value: Preset
  label: string
  code?: string
  description?: string
}

function errorOption(value: ErrorPreset): PresetOption {
  return { value, code: value, label: httpErrors[value].label, description: value === '429' ? '建议 30 秒后重试' : undefined }
}

const dataOptions: PresetOption[] = [
  { value: 'empty', label: '空列表', code: '200', description: '返回 []' },
  { value: 'empty-object', label: '空对象', code: '200', description: '返回 {}' },
  { value: 'empty-null', label: '空值', code: '200', description: '返回 null' },
  { value: 'no-content', label: '无响应正文', code: '204' },
  { value: 'business-error', label: '业务失败', code: '200', description: '成功状态码，失败正文' },
  { value: 'slow', label: '慢响应', description: '延迟 3 秒后返回' },
  { value: 'network', label: '网络错误', description: '模拟请求断开' },
]

export const scenarioGroups = [
  { name: '客户端错误', options: (['400', '401', '403', '404', '429'] as const).map(errorOption) },
  { name: '服务端错误', options: (['500', '502', '503', '504'] as const).map(errorOption) },
  { name: '响应与网络', options: dataOptions },
]

export const presets = scenarioGroups.flatMap(group => group.options)

export const commonPresets: { value: Preset; label: string }[] = [
  { value: 'empty', label: '空列表' },
  { value: '404', label: '404' },
  { value: '429', label: '429 限流' },
  { value: 'slow', label: '慢响应' },
]

export interface ScenarioSeed {
  response: MockResponse
  allowInvalidJson: boolean
}

export type ScenarioChoice = { kind: 'builtin'; preset: Preset } | { kind: 'custom'; scenario: CustomScenario }

function http(status: number, body: string): MockResponse {
  return { kind: 'http', status, body, contentType: json, delayMs: 0 }
}

export function presetResponse(preset: Preset, entry?: Pick<CatalogEntry, 'sample' | 'example' | 'contentType'>): MockResponse {
  switch (preset) {
    case 'empty': return http(200, '[]')
    case 'empty-object': return http(200, '{}')
    case 'empty-null': return http(200, 'null')
    case 'no-content': return { ...http(204, ''), contentType: '' }
    case 'business-error': return http(200, JSON.stringify({ success: false, code: 'FAILED', message: '业务处理失败' }, null, 2))
    case 'network': return { ...http(500, ''), kind: 'network', contentType: '' }
    case 'slow': {
      const response = entry?.sample === undefined
        ? entry?.example ?? http(200, '{}')
        : { ...http(200, entry.sample), contentType: entry.contentType ?? json }
      return { ...response, delayMs: 3000 }
    }
    default: {
      const response = http(Number(preset), JSON.stringify({ message: httpErrors[preset].message }, null, 2))
      return preset === '429' ? { ...response, retryAfterSeconds: 30 } : response
    }
  }
}

export function scenarioKey(choice: ScenarioChoice): string {
  return choice.kind === 'builtin' ? `builtin:${choice.preset}` : `custom:${choice.scenario.id}`
}

export function applyScenario(choice: ScenarioChoice, entry: CatalogEntry): ScenarioSeed {
  if (choice.kind === 'builtin') return { response: presetResponse(choice.preset, entry), allowInvalidJson: false }
  return { response: { ...choice.scenario.response }, allowInvalidJson: choice.scenario.allowInvalidJson === true }
}

export function sameScenarioResponse(left: MockResponse, right: MockResponse): boolean {
  if (left.kind !== right.kind || left.delayMs !== right.delayMs) return false
  return left.kind === 'network' || (left.status === right.status && left.body === right.body &&
    left.contentType === right.contentType && left.retryAfterSeconds === right.retryAfterSeconds)
}

export function hasInvalidJson(response: MockResponse): boolean {
  if (response.kind !== 'http' || !response.body || !/(?:[+/])json(?:\s*;|\s*$)/i.test(response.contentType)) return false
  try {
    JSON.parse(response.body)
    return false
  } catch {
    return true
  }
}

export function validateScenarioResponse(response: MockResponse, allowInvalidJson: boolean, method = 'GET'): MockResponse {
  if (!response || typeof response !== 'object') throw new Error('请填写响应设置')
  const configured = { ...response }
  if (configured.kind === 'network') {
    configured.status = 500
    configured.body = ''
    configured.contentType = ''
    delete configured.retryAfterSeconds
  } else if (method === 'HEAD' || configured.status === 204 || configured.status === 205) {
    configured.body = ''
    if (configured.status === 204 || configured.status === 205) configured.contentType = ''
  }
  buildResponse(configured, method)
  if (!allowInvalidJson && hasInvalidJson(configured)) {
    throw new Error('响应不是有效的 JSON。若要模拟解析失败，请选择「发送无效 JSON」')
  }
  return configured
}

export function normalizeCustomScenario(input: CustomScenario): CustomScenario {
  if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 128) throw new Error('场景标识无效')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 48) throw new Error('请输入 1 至 48 个字符的场景名称')
  const response = validateScenarioResponse(input.response, input.allowInvalidJson === true)
  return { id: input.id, name, response, allowInvalidJson: hasInvalidJson(response) }
}
