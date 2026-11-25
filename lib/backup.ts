import type { CatalogEntry, CustomScenario, Endpoint, IgnoreRule, MockResponse, RequestCondition, RouteGrouping, Rule, SavedPlan } from './model'
import { normalizeCatalogOperations } from './catalog'
import { ignoreKey, normalizeIgnoreRule } from './request-filters'
import { endpointKey, isValidHttpMethod, normalizeResponseHeaders, routeKey, validateRuleSet } from './rules'
import { normalizeCustomScenario } from './scenarios'

export const MAX_BACKUP_BYTES = 16 * 1024 * 1024
const FORMAT = 'apifaultlab-backup'
const PLAN_FORMAT = 'apifaultlab-plan'
const RESCUE_FORMAT = 'apifaultlab-rescue'
const VERSION = 1
const DATA_FIELDS = ['plans', 'imports', 'ignoresBySite', 'scenarios', 'routeGroupingBySite']
const encoder = new TextEncoder()

export interface ImportedEntry {
  siteOrigin: string
  routeKey: string
  entry: CatalogEntry
}

export interface LocalData {
  plans: SavedPlan[]
  imports: ImportedEntry[]
  ignoresBySite: Record<string, IgnoreRule[]>
  scenarios: CustomScenario[]
  routeGroupingBySite?: Record<string, RouteGrouping>
}

interface MergeCounts {
  added: number
  unchanged: number
  conflicts: number
}

export interface BackupPreview {
  plans: MergeCounts
  imports: MergeCounts
  ignores: MergeCounts
  scenarios: MergeCounts
  confirmation: string
}

function invalid(field: string): never {
  throw new Error(`${field}格式无效。`)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as Record<string, unknown>
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field)
  return value
}

function identifier(value: unknown, field: string): string {
  const text = string(value, field)
  if (!text.trim()) invalid(field)
  return text
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field)
  return value
}

function scope(value: Record<string, unknown>, field: string) {
  const siteOrigin = string(value.siteOrigin, field)
  const route = string(value.routeKey, field)
  if (routeKey(route) !== route || new URL(route).origin !== siteOrigin) invalid(field)
  return { siteOrigin, routeKey: route }
}

function endpoint(input: unknown): Endpoint {
  const value = record(input, '接口')
  const method = string(value.method, '接口方法')
  const origin = string(value.origin, '接口来源')
  const path = string(value.path, '接口路径')
  const url = new URL(origin)
  if (!isValidHttpMethod(method) || !/^https?:$/.test(url.protocol) || url.origin !== origin ||
      !path.startsWith('/') || /[?#\\]/.test(path) || (value.template !== undefined && typeof value.template !== 'boolean') ||
      (value.template && !/\{[^{}\/]+\}/.test(path))) invalid('接口')
  return { method, origin, path, template: value.template }
}

function response(input: unknown): MockResponse {
  const value = record(input, '模拟响应')
  const { kind } = value
  if (kind !== 'http' && kind !== 'network') invalid('模拟响应类型')
  const headers = value.headers === undefined
    ? undefined
    : normalizeResponseHeaders(record(value.headers, '自定义响应头') as Record<string, string>)
  return {
    kind,
    status: integer(value.status, '状态码'),
    body: string(value.body, '响应正文'),
    contentType: string(value.contentType, '响应类型'),
    delayMs: integer(value.delayMs, '响应延迟'),
    retryAfterSeconds: value.retryAfterSeconds === undefined ? undefined : integer(value.retryAfterSeconds, '重试时间'),
    ...(headers ? { headers } : {}),
  }
}

function condition(input: unknown): RequestCondition {
  const value = record(input, '匹配条件')
  const { source, value: expected } = value
  if (source !== 'query' && source !== 'json' && source !== 'header') invalid('条件来源')
  if (expected !== null && typeof expected !== 'string' && typeof expected !== 'boolean' &&
      !(typeof expected === 'number' && Number.isFinite(expected))) invalid('条件值')
  return { source, path: string(value.path, '条件字段'), value: expected }
}

function rule(input: unknown): Rule {
  const value = record(input, '方案规则')
  const maxHits = value.maxHits === undefined ? undefined : integer(value.maxHits, '最多生效次数')
  return {
    id: identifier(value.id, '规则标识'),
    routeKey: string(value.routeKey, '规则页面'),
    endpoint: endpoint(value.endpoint),
    conditions: list(value.conditions, '匹配条件').map(condition),
    response: response(value.response),
    ...(maxHits !== undefined ? { maxHits } : {}),
  }
}

function plan(input: unknown): SavedPlan {
  const value = record(input, '方案')
  const owner = scope(value, '方案页面')
  const rules = list(value.rules, '方案规则').map(rule)
  if (rules.some(item => item.routeKey !== owner.routeKey)) invalid('方案规则页面')
  validateRuleSet(rules)
  return {
    ...owner,
    id: identifier(value.id, '方案标识'),
    name: identifier(value.name, '方案名称'),
    rules,
    setup: string(value.setup, '准备步骤'),
    trigger: string(value.trigger, '触发步骤'),
    expectation: string(value.expectation, '预期结果'),
    updatedAt: integer(value.updatedAt, '方案更新时间'),
  }
}

function imported(input: unknown): ImportedEntry {
  const value = record(input, '导入接口')
  const entry = record(value.entry, '接口目录项')
  const api = endpoint(entry.endpoint)
  return {
    ...scope(value, '接口所属页面'),
    entry: {
      key: endpointKey(api), endpoint: api, imported: true, observed: false, realSeen: false, hitCount: 0,
      title: entry.title === undefined ? undefined : string(entry.title, '接口名称'),
      contentType: entry.contentType === undefined ? undefined : string(entry.contentType, '接口响应类型'),
      example: entry.example === undefined ? undefined : response(entry.example),
      operations: entry.operations === undefined ? undefined : normalizeCatalogOperations(entry.operations),
    },
  }
}

function scenario(input: unknown): CustomScenario {
  const value = record(input, '自定义场景')
  return normalizeCustomScenario({
    id: identifier(value.id, '场景标识'), name: string(value.name, '场景名称'), response: response(value.response),
    allowInvalidJson: value.allowInvalidJson === true,
  })
}

function importedKey(item: ImportedEntry): string {
  return JSON.stringify([item.routeKey, item.entry.key])
}

function unique<T>(items: T[], key: (item: T) => string, field: string): T[] {
  if (new Set(items.map(key)).size !== items.length) throw new Error(`${field}存在重复标识。`)
  return items
}

function readRouteGroupingBySite(input: unknown): Record<string, RouteGrouping> | undefined {
  if (input === undefined) return undefined
  const sites = record(input, '站点页面归组')
  const result: Record<string, RouteGrouping> = {}
  for (const [site, mode] of Object.entries(sites)) {
    const url = new URL(site)
    if (!/^https?:$/.test(url.protocol) || url.origin !== site) invalid('站点页面归组来源')
    if (mode !== 'exact' && mode !== 'ignore-query') invalid('站点页面归组方式')
    if (mode === 'ignore-query') result[site] = mode
  }
  return Object.keys(result).length ? result : undefined
}

function readData(input: unknown, legacy = false): LocalData {
  if (legacy && input === undefined) return { plans: [], imports: [], ignoresBySite: {}, scenarios: [] }
  const value = record(input, '本地配置')
  if (Object.keys(value).some(key => !DATA_FIELDS.includes(key))) throw new Error('当前版本无法识别这份本地配置。')
  const rows = (field: string, label: string) => list(legacy && !Object.hasOwn(value, field) ? [] : value[field], label)
  const ignores = record(legacy && !Object.hasOwn(value, 'ignoresBySite') ? {} : value.ignoresBySite, '站点忽略规则')
  const ignoresBySite = Object.fromEntries(Object.entries(ignores).map(([site, input]) => {
    const url = new URL(site)
    if (!/^https?:$/.test(url.protocol) || url.origin !== site) invalid('忽略规则站点')
    return [site, unique(list(input, '站点忽略规则').map(rule => normalizeIgnoreRule(rule as IgnoreRule)), ignoreKey, '忽略规则')]
  }))
  const routeGroupingBySite = readRouteGroupingBySite(value.routeGroupingBySite)
  return {
    plans: unique(rows('plans', '方案').map(plan), item => item.id, '方案'),
    imports: unique(rows('imports', '导入接口').map(imported), importedKey, '导入接口'),
    ignoresBySite,
    scenarios: unique(rows('scenarios', '自定义场景').map(scenario), item => item.id, '自定义场景'),
    ...(routeGroupingBySite ? { routeGroupingBySite } : {}),
  }
}

export function readLocalData(input?: unknown): LocalData {
  return readData(input, true)
}

export function exportBackup(data: LocalData): string {
  const imports = data.imports.map(({ entry, ...owner }) => ({
    ...owner,
    entry: { endpoint: entry.endpoint, title: entry.title, contentType: entry.contentType, example: entry.example, operations: entry.operations },
  }))
  return JSON.stringify({ format: FORMAT, schemaVersion: VERSION, exportedAt: new Date().toISOString(), data: { ...data, imports } })
}

export function exportPlanShare(savedPlan: SavedPlan, includeContents = false): string {
  return JSON.stringify({
    format: PLAN_FORMAT, schemaVersion: VERSION, exportedAt: new Date().toISOString(),
    mode: includeContents ? 'full' : 'summary',
    plan: includeContents ? savedPlan : {
      rules: savedPlan.rules.map(({ endpoint, response }) => ({
        method: endpoint.method, kind: response.kind,
        status: response.kind === 'http' ? response.status : undefined, delayMs: response.delayMs,
      })),
    },
  }, null, 2)
}

export function exportRescueData(input: unknown): string {
  return JSON.stringify({ format: RESCUE_FORMAT, schemaVersion: VERSION, exportedAt: new Date().toISOString(), data: input })
}

export function salvageLocalData(input: unknown) {
  const data = readLocalData()
  let skipped = 0
  let value: Record<string, unknown>
  try {
    value = record(input, '本地配置')
  } catch {
    return { data, recovered: 0, skipped: 1 }
  }
  skipped += Object.keys(value).filter(key => !DATA_FIELDS.includes(key)).length

  function salvage<T>(inputRows: unknown, decode: (entry: unknown) => T, key: (entry: T) => string): T[] {
    if (inputRows === undefined) return []
    if (!Array.isArray(inputRows)) {
      skipped += 1
      return []
    }
    const entries = new Map<string, T>()
    for (const item of inputRows) {
      try {
        const decoded = decode(item)
        const id = key(decoded)
        if (entries.has(id)) skipped += 1
        else entries.set(id, decoded)
      } catch {
        skipped += 1
      }
    }
    return [...entries.values()]
  }

  data.plans = salvage(value.plans, plan, item => item.id)
  data.imports = salvage(value.imports, imported, importedKey)
  data.scenarios = salvage(value.scenarios, scenario, item => item.id)
  if (value.ignoresBySite !== undefined) {
    try {
      const sites = record(value.ignoresBySite, '站点忽略规则')
      for (const [site, rows] of Object.entries(sites)) {
        try {
          const url = new URL(site)
          if (!/^https?:$/.test(url.protocol) || url.origin !== site) invalid('忽略规则站点')
          const rules = salvage(rows, rule => normalizeIgnoreRule(rule as IgnoreRule), ignoreKey)
          if (rules.length) data.ignoresBySite[site] = rules
        } catch {
          skipped += 1
        }
      }
    } catch {
      skipped += 1
    }
  }

  if (value.routeGroupingBySite !== undefined) {
    try {
      const sites = record(value.routeGroupingBySite, '站点页面归组')
      const recoveredGrouping: Record<string, RouteGrouping> = {}
      for (const [site, mode] of Object.entries(sites)) {
        try {
          const url = new URL(site)
          if (!/^https?:$/.test(url.protocol) || url.origin !== site || (mode !== 'exact' && mode !== 'ignore-query')) {
            invalid('站点页面归组')
          }
          if (mode === 'ignore-query') recoveredGrouping[site] = mode
        } catch {
          skipped += 1
        }
      }
      if (Object.keys(recoveredGrouping).length) data.routeGroupingBySite = recoveredGrouping
    } catch {
      skipped += 1
    }
  }

  const recovered = data.plans.length + data.imports.length + data.scenarios.length +
    Object.values(data.ignoresBySite).reduce((total, rules) => total + rules.length, 0) +
    Object.keys(data.routeGroupingBySite ?? {}).length
  return { data, recovered, skipped }
}

export function readBackup(json: string): LocalData {
  if (typeof json !== 'string' || encoder.encode(json).byteLength > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 16 MiB。')
  let value: unknown
  try {
    value = JSON.parse(json.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('无法读取备份，请选择有效的 JSON 文件。')
  }
  const backup = record(value, '备份')
  if (backup.format === RESCUE_FORMAT) throw new Error('这是原始救援数据，请改用「导出可读取配置」生成的备份。')
  if (backup.format !== FORMAT && backup.format !== PLAN_FORMAT) throw new Error('请选择 APIFaultLab 导出的 JSON 备份或方案。')
  if (backup.schemaVersion !== VERSION) throw new Error('当前版本无法恢复此版本的备份。')
  if (typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt))) invalid('备份时间')
  if (backup.format === PLAN_FORMAT) {
    if (backup.mode !== 'full') throw new Error('方案摘要仅供分享，请选择包含完整方案的文件。')
    return { ...readLocalData(), plans: [plan(backup.plan)] }
  }
  return readData(backup.data)
}

function merge<T>(current: T[], incoming: T[], key: (item: T) => string, counts: MergeCounts) {
  const existing = new Map(current.map(item => [key(item), item]))
  const additions = incoming.filter(item => {
    const previous = existing.get(key(item))
    if (previous === undefined) {
      counts.added += 1
      return true
    }
    if (JSON.stringify(previous) === JSON.stringify(item)) counts.unchanged += 1
    else counts.conflicts += 1
    return false
  })
  return [...current, ...additions]
}

function emptyCounts(): MergeCounts {
  return { added: 0, unchanged: 0, conflicts: 0 }
}

export async function mergeBackup(current: LocalData, incoming: LocalData) {
  const counts = { plans: emptyCounts(), imports: emptyCounts(), ignores: emptyCounts(), scenarios: emptyCounts() }
  const ignoresBySite = { ...current.ignoresBySite }
  for (const [site, rules] of Object.entries(incoming.ignoresBySite)) {
    ignoresBySite[site] = merge(ignoresBySite[site] ?? [], rules, ignoreKey, counts.ignores)
  }
  const routeGroupingBySite: Record<string, RouteGrouping> = { ...current.routeGroupingBySite }
  let groupingAdded = false
  for (const [site, mode] of Object.entries(incoming.routeGroupingBySite ?? {})) {
    if (!Object.hasOwn(routeGroupingBySite, site) && mode === 'ignore-query') {
      routeGroupingBySite[site] = mode
      groupingAdded = true
    }
  }
  const merged: LocalData = {
    plans: merge(current.plans, incoming.plans, item => item.id, counts.plans),
    imports: merge(current.imports, incoming.imports, importedKey, counts.imports),
    ignoresBySite,
    scenarios: merge(current.scenarios, incoming.scenarios, item => item.id, counts.scenarios),
    ...(Object.keys(routeGroupingBySite).length ? { routeGroupingBySite } : {}),
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([current, incoming])))
  const confirmation = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const preview: BackupPreview = { ...counts, confirmation }
  const added = groupingAdded || Object.values(counts).some(group => group.added > 0)
  return { data: added ? merged : current, preview }
}
