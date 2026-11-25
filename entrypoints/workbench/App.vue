<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import type { CatalogEntry, CatalogOperation, CustomScenario, IgnoreRule, PanelCommand, RequestEvent, RouteGrouping, Rule, SavedPlan } from '../../lib/model'
import { ignoreKey, matchesIgnore, matchesRequestFilter, type RequestFilter } from '../../lib/request-filters'
import { endpointCovers, endpointKey, validateRuleSet } from '../../lib/rules'
import { usePanelConnection } from '../../lib/use-panel-connection'
import BackupTools from './BackupTools.vue'
import DocumentImport from './DocumentImport.vue'
import PlanEditor from './PlanEditor.vue'
import PlanShare from './PlanShare.vue'
import RequestFilters from './RequestFilters.vue'
import RuleEditor from './RuleEditor.vue'
import ScenarioLibrary from './ScenarioLibrary.vue'
import ScenarioPicker from './ScenarioPicker.vue'
import { batchAddsBroadScope, compileBatchRow, describeBatchScope, describeCondition, prepareBatch, type BatchWork } from './batch'
import { applyScenario, createDraft, draftHeaders, draftRule, type RuleDraft, type ScenarioChoice, type ScenarioSeed } from './editor'
import { compilePlanDraft, hasBroadPlanRule, preparePlanDraft, type PlanDraft } from './plan-draft'

interface EditingRule { key: string; originalId?: string; draft: RuleDraft }
interface RouteWork {
  selected: string[]
  filter: string
  requestFilter: RequestFilter
  inspected: string | null
  editor: EditingRule | null
  batch: BatchWork | null
  batchExpanded: string | null
}

function blankWork(): RouteWork {
  return { selected: [], filter: '', requestFilter: 'all', inspected: null, editor: null, batch: null, batchExpanded: null }
}

const { snapshot, connected, connectionError, send, retry } = usePanelConnection(async () => {
  const tabId = chrome.devtools?.inspectedWindow?.tabId
  if (typeof tabId !== 'number') throw new Error('请从 Chrome 开发者工具的 APIFaultLab 标签打开')
  return tabId
})
const workByRoute = new Map<string, RouteWork>()
const work = shallowRef(reactive(blankWork()))
const busy = ref(false)
const applyingRules = ref(false)
const error = ref('')
const notice = ref('')
const plansOpen = ref(false)
const backupExpanded = ref(false)
const importOpen = ref(false)
const scenariosOpen = ref(false)
const scenarioSeed = shallowRef<ScenarioSeed>()
const planDrafts = reactive(new Map<string, PlanDraft>())
const planEditorOpen = ref(false)
const planShareOpen = ref(false)
const previewPlanId = ref('')
const deletePlanId = ref('')
const list = ref<HTMLElement>()
const requestTitle = ref<HTMLElement>()
const detail = ref<HTMLElement>()
const detailTitle = ref<HTMLElement>()
const lastTrigger = shallowRef<HTMLElement>()
const permissionBusy = ref(false)

const target = computed(() => snapshot.value?.target ?? null)
const scope = computed(() => target.value ? `${target.value.tabId}\n${target.value.routeKey}` : '')
const documentScope = computed(() => target.value ? `${scope.value}\n${target.value.documentId}` : '')
const entries = computed(() => snapshot.value?.entries ?? [])
const rules = computed(() => snapshot.value?.rules ?? [])
const ruleOutcomes = computed(() => new Map(snapshot.value?.ruleOutcomes?.map(outcome => [outcome.ruleId, outcome])))
const ignores = computed(() => snapshot.value?.ignores ?? [])
const scenarios = computed(() => snapshot.value?.scenarios ?? [])
const routeGrouping = computed<RouteGrouping>(() => snapshot.value?.routeGrouping ?? 'exact')
const entryByKey = computed(() => new Map(entries.value.map(entry => [entry.key, entry])))
const rulesByEntry = computed(() => new Map(entries.value.map(entry => [entry.key,
  rules.value.filter(rule => endpointKey(rule.endpoint) === entry.key || endpointCovers(rule.endpoint, entry.endpoint)),
])))
const activeKeys = computed(() => [...rulesByEntry.value].filter(([, matches]) => matches.length).map(([key]) => key))
const ignoredKeys = computed(() => new Set(entries.value.filter(entry =>
  ignores.value.some(rule => matchesIgnore(rule, entry.endpoint)),
).map(entry => entry.key)))
const activeCount = computed(() => snapshot.value?.activeCount ?? 0)
const configuredCount = computed(() => snapshot.value?.configuredCount ?? 0)
const status = computed(() => snapshot.value?.status ?? 'loading')
const observing = computed(() => snapshot.value?.observing ?? false)
const storageError = computed(() => snapshot.value?.storageError)
const sessionWarning = computed(() => snapshot.value?.sessionWarning)
const canPersist = computed(() => connected.value && !storageError.value)
const canEdit = computed(() => Boolean(connected.value && target.value && ['observing', 'active'].includes(status.value)))
const startupBlocked = computed(() => snapshot.value?.startupState === 'blocked')
const canPrepareStartup = computed(() => canEdit.value && configuredCount.value > 0 && !snapshot.value?.earlyAccess)
const canStop = computed(() => Boolean(connected.value && target.value && (configuredCount.value || activeCount.value || status.value === 'uncertain' || startupBlocked.value)))
const canStopRoute = computed(() => canEdit.value && rules.value.length > 0)
const canAuthorize = computed(() => Boolean(connected.value && target.value && snapshot.value?.needsSiteAccess))
const canReconnect = computed(() => Boolean(connected.value && target.value && !canAuthorize.value && ['unavailable', 'uncertain'].includes(status.value)))
const statusLabel = computed(() => {
  if (!connected.value) return snapshot.value || connectionError.value ? '正在重新连接' : '正在连接'
  if (status.value === 'observing' && !observing.value) return '采集已暂停'
  return {
    loading: '正在接入页面', unavailable: '页面未就绪', observing: '正在采集', applying: '正在启用',
    active: '模拟中', stopping: '正在停止', uncertain: '状态未确认', restoring: '等待页面确认规则',
  }[status.value]
})
const displayRoute = computed(() => {
  try {
    const page = new URL(target.value?.routeKey || snapshot.value?.pageUrl || '')
    return { path: `${page.pathname}${page.search}${page.hash}`, host: page.host }
  } catch {
    return { path: '未连接到网页', host: '' }
  }
})
const routeTitle = computed(() => {
  const url = snapshot.value?.pageUrl || ''
  return routeGrouping.value === 'ignore-query' && url ? `${url}（按路径归组，已忽略查询参数）` : url
})
const visible = computed(() => {
  const keyword = work.value.filter.trim().toLowerCase()
  return entries.value.filter(entry => matchesRequestFilter(entry, work.value.requestFilter, ignores.value, ownRules(entry).length > 0) &&
    `${entry.endpoint.method} ${entry.endpoint.origin}${entry.endpoint.path} ${entry.title ?? ''}`.toLowerCase().includes(keyword))
})
const selectedKeys = computed(() => new Set(work.value.selected))
const selectedCount = computed(() => entries.value.filter(entry => selectedKeys.value.has(entry.key)).length)
const selectedEntries = computed(() => visible.value.filter(entry => selectedKeys.value.has(entry.key)))
const ignorable = computed(() => selectedEntries.value.filter(entry => !ignoredKeys.value.has(entry.key)))
const restorableKeys = computed(() => {
  const selected = selectedEntries.value.filter(entry => !ignores.value.some(rule =>
    rule.kind === 'prefix' && matchesIgnore(rule, entry.endpoint),
  ))
  return ignores.value.filter(rule => rule.kind === 'endpoint' && selected.some(entry =>
    matchesIgnore(rule, entry.endpoint),
  )).map(ignoreKey)
})
const batchEntries = computed(() => work.value.batch?.rows.map(row => ({
  row, entry: entryByKey.value.get(row.entry.key) ?? row.entry, conditions: describeBatchScope(row),
})) ?? [])
const batchUpdateCount = computed(() => work.value.batch?.rows.filter(row => row.original).length ?? 0)
const batchBroadCount = computed(() => work.value.batch?.rows.filter(batchAddsBroadScope).length ?? 0)
const batchChanges = computed(() => {
  const added = batchEntries.value.length - batchUpdateCount.value
  return [added ? `新增 ${added} 条` : '', batchUpdateCount.value ? `更新 ${batchUpdateCount.value} 条` : ''].filter(Boolean).join(' · ')
})
const selectedVisible = computed(() => selectedEntries.value.length)
const selectedHidden = computed(() => selectedCount.value - selectedVisible.value)
const allVisible = computed(() => visible.value.length > 0 && selectedVisible.value === visible.value.length)
const pendingImports = computed(() => entries.value.filter(entry => entry.imported && !entry.observed).length)
const routePlans = computed(() => snapshot.value?.plans.filter(plan => plan.routeKey === target.value?.routeKey && plan.siteOrigin === snapshot.value?.siteOrigin) ?? [])
const planDraft = computed(() => planDrafts.get(scope.value))
const previewPlan = computed(() => routePlans.value.find(plan => plan.id === previewPlanId.value))
const previewHasBroadRule = computed(() => hasBroadPlanRule(previewPlan.value?.rules ?? []))
const planVersionChanged = computed(() => {
  const draft = planDraft.value
  return !!draft && draft.expectedUpdatedAt !== null &&
    draft.expectedUpdatedAt !== routePlans.value.find(plan => plan.id === draft.id)?.updatedAt
})
const inspectedEntry = computed(() => entryByKey.value.get(work.value.inspected ?? '') ?? null)
const inspectedSample = computed(() => {
  const state = snapshot.value?.responseSample
  return state && endpointKey(state.endpoint) === inspectedEntry.value?.key ? state : undefined
})
const sampleBlocked = computed(() => {
  const entry = inspectedEntry.value
  return Boolean(entry && ownRules(entry).some(rule => !rule.conditions.length &&
    (endpointKey(rule.endpoint) === entry.key || !entry.endpoint.template)))
})
const editor = computed(() => work.value.editor?.key === inspectedEntry.value?.key ? work.value.editor : null)
const editorEntry = computed(() => {
  const entry = inspectedEntry.value
  const original = rules.value.find(rule => rule.id === editor.value?.originalId)
  return entry && original && endpointKey(original.endpoint) !== entry.key ? { ...entry, endpoint: original.endpoint } : entry
})
const editingScope = computed(() => {
  const count = editor.value?.draft.conditions.length ?? 0
  if (editorEntry.value?.endpoint.template) return count ? `路径模板 · ${count} 条匹配条件` : '匹配模板内的所有请求'
  return count ? `${count} 条匹配条件` : '匹配此接口的所有请求'
})
const activePane = computed(() => scenariosOpen.value ? 'scenarios' : importOpen.value ? 'import' : plansOpen.value ? 'plans' : work.value.batch ? 'batch' : inspectedEntry.value ? 'request' : '')
const utilityTitle = computed(() => ({
  import: '导入接口文档', plans: '测试方案', scenarios: '自定义场景', batch: '批量设置', request: '', '': '',
})[activePane.value])
const pageMessage = computed(() => {
  if (startupBlocked.value) return '首屏请求已阻止。重新启用规则，或停止标签页规则后再触发请求。'
  if (status.value === 'restoring') return snapshot.value?.earlyAccess
    ? '正在核对首屏接入和当前规则。'
    : '当前站点尚未开启首屏保护。'
  if (snapshot.value?.message) return snapshot.value.message
  if (snapshot.value?.recoveryState === 'real-confirmed') return '已收到真实响应。请核对原页面是否恢复。'
  if (snapshot.value?.recoveryState === 'awaiting-real') {
    const title = snapshot.value.recoveryScope === 'route' ? '本页规则已停止。' : '标签页规则已停止。'
    return `${title}请在网页重新触发请求以确认恢复。`
  }
})
const feedback = computed(() => connectionError.value || error.value ||
  (startupBlocked.value ? pageMessage.value : '') ||
  (canAuthorize.value ? pageMessage.value || '授权此站点后可采集请求。' : '') ||
  (canReconnect.value ? pageMessage.value || '可以重试接入当前页面。' : '') ||
  notice.value || storageError.value || pageMessage.value ||
  (canPrepareStartup.value ? '准备首屏接入后，可保护同标签页的后续刷新。' : '') ||
  (configuredCount.value && snapshot.value?.earlyAccess && snapshot.value?.startupArmed === false
    ? '该页面无法保存首屏保护标记，请在当前页面完成测试。' : ''))

watch(() => previewPlan.value?.updatedAt, () => {
  planShareOpen.value = false
})

watch(scope, key => {
  let existing = workByRoute.get(key)
  if (!existing) {
    existing = reactive(blankWork())
    if (workByRoute.size >= 60) workByRoute.delete(workByRoute.keys().next().value ?? '')
    if (key) workByRoute.set(key, existing)
  }
  work.value = existing
  error.value = ''
  notice.value = ''
  importOpen.value = false
  if (!backupExpanded.value) plansOpen.value = false
  scenariosOpen.value = false
  scenarioSeed.value = undefined
  planEditorOpen.value = false
  closePlanPreview()
  deletePlanId.value = ''
  if (list.value) list.value.scrollTop = 0
}, { immediate: true })

function ownRules(entry: CatalogEntry) {
  return rulesByEntry.value.get(entry.key) ?? []
}

function setError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '操作未完成'
}

async function command(request: Exclude<PanelCommand, { type: 'bind' }>, success?: string) {
  if (busy.value) return false
  busy.value = true
  error.value = ''
  notice.value = ''
  const sentScope = documentScope.value
  try {
    await send(request)
    if (sentScope === documentScope.value && success) notice.value = success
    return true
  } catch (cause) {
    if (sentScope === documentScope.value) setError(cause)
    return false
  } finally {
    busy.value = false
  }
}

function actionButton(key: string) {
  return [...(list.value?.querySelectorAll<HTMLButtonElement>('[data-request-key]') ?? [])]
    .find(button => button.dataset.requestKey === key)
}

function focusDetail() {
  void nextTick(() => {
    if (detail.value) detail.value.scrollTop = 0
    detailTitle.value?.focus({ preventScroll: true })
  })
}

function returnFocus(key?: string) {
  void nextTick(() => {
    const focused = key ? actionButton(key) : lastTrigger.value
    if (focused?.isConnected && focused.getClientRects().length) focused.focus({ preventScroll: true })
    else requestTitle.value?.focus({ preventScroll: true })
  })
}

function inspect(entry: CatalogEntry, origin?: HTMLElement, moveFocus = true) {
  if (origin) lastTrigger.value = origin
  importOpen.value = false
  plansOpen.value = false
  scenariosOpen.value = false
  work.value.inspected = entry.key
  if (moveFocus) focusDetail()
}

function stepRequest(entry: CatalogEntry, delta: number, event: KeyboardEvent) {
  const index = visible.value.findIndex(item => item.key === entry.key)
  const next = visible.value[index + delta]
  if (!next || !window.matchMedia('(min-width: 44rem)').matches) return
  event.preventDefault()
  inspect(next, undefined, false)
  void nextTick(() => actionButton(next.key)?.focus())
}

function openUtility(pane: 'plans' | 'import', event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) lastTrigger.value = event.currentTarget
  plansOpen.value = pane === 'plans'
  importOpen.value = pane === 'import'
  scenariosOpen.value = false
  focusDetail()
}

function openBackup(event: MouseEvent) {
  planEditorOpen.value = false
  closePlanPreview()
  backupExpanded.value = true
  openUtility('plans', event)
}

function closeDetail() {
  if (busy.value) return
  const pane = activePane.value
  if (pane === 'scenarios') {
    scenariosOpen.value = false
    scenarioSeed.value = undefined
  } else if (pane === 'import') importOpen.value = false
  else if (pane === 'plans') plansOpen.value = false
  else if (pane === 'batch') work.value.batch = null
  else {
    const key = work.value.inspected ?? undefined
    work.value.inspected = null
    returnFocus(key)
    return
  }
  if (activePane.value) focusDetail()
  else returnFocus()
}

function focusRuleEditor() {
  void nextTick(() => {
    if (detail.value) detail.value.scrollTop = 0
    detail.value?.querySelector<HTMLButtonElement>('.rule-editor .button-chip')?.focus({ preventScroll: true })
  })
}

function openEditor(entry: CatalogEntry, existing: Rule | undefined = ownRules(entry)[0]) {
  const current = work.value
  if (current.editor?.key === entry.key && current.editor.originalId === existing?.id) {
    closeEditor()
    return
  }
  const selectedEntry = existing && endpointKey(existing.endpoint) !== entry.key
    ? { ...entry, endpoint: existing.endpoint }
    : entry
  current.editor = { key: entry.key, originalId: existing?.id, draft: createDraft(selectedEntry, existing) }
  focusRuleEditor()
}

const catalogSources: Record<CatalogOperation['source'], string> = { observed: '已记录', documented: '文档', inferred: '推断' }

function newRule(entry: CatalogEntry, operation?: CatalogOperation) {
  work.value.editor = { key: entry.key, draft: createDraft(entry, undefined, operation?.conditions) }
  focusRuleEditor()
}

function closeEditor() {
  work.value.editor = null
  focusDetail()
}

async function applyRules(nextRules: Rule[], success?: string) {
  const active = target.value
  if (!active || !canEdit.value || busy.value) return false
  try {
    validateRuleSet(nextRules)
  } catch (cause) {
    setError(cause)
    return false
  }
  applyingRules.value = true
  try {
    return await command({ type: 'apply', target: active, rules: nextRules }, success)
  } finally {
    applyingRules.value = false
  }
}

async function submitEditor(entry: CatalogEntry) {
  const current = work.value
  const editor = current.editor
  const page = target.value
  if (!editor || !page || editor.key !== entry.key) return
  try {
    const original = rules.value.find(rule => rule.id === editor.originalId)
    const source = original ? { ...entry, endpoint: original.endpoint } : entry
    const next = draftRule(editor.draft, source, page.routeKey)
    if (await applyRules([...rules.value.filter(rule => rule.id !== editor.originalId), next], editor.originalId ? '规则已更新。' : '规则已启用。')) {
      current.editor = null
      if (current === work.value) focusDetail()
    }
  } catch (cause) {
    setError(cause)
  }
}

async function removeRule(id: string) {
  const current = work.value
  const row = current.editor?.originalId === id ? current.editor.key : undefined
  if (await applyRules(rules.value.filter(rule => rule.id !== id))) {
    if (current.editor?.originalId === id) current.editor = null
    if (row && current === work.value) focusDetail()
  }
}

function toggleVisible() {
  const selected = new Set(work.value.selected)
  const removing = allVisible.value
  for (const entry of visible.value) {
    if (removing) selected.delete(entry.key)
    else selected.add(entry.key)
  }
  work.value.selected = [...selected]
}

function toggleEntry(key: string, selected: boolean) {
  const current = work.value
  current.selected = selected ? [...new Set([...current.selected, key])] : current.selected.filter(item => item !== key)
}

async function addIgnores(added: IgnoreRule[]) {
  const page = target.value
  if (!page || !added.length) return
  const current = work.value
  const affected = new Set(entries.value.filter(entry => added.some(rule => matchesIgnore(rule, entry.endpoint))).map(entry => entry.key))
  if (await command({ type: 'add-ignores', target: page, rules: added }, '忽略规则已保存。')) {
    current.selected = current.selected.filter(key => !affected.has(key))
  }
}

function ignoreSelection() {
  void addIgnores(ignorable.value.map(entry => ({ kind: 'endpoint', endpoint: entry.endpoint })))
}

async function removeIgnores(keys: string[]) {
  const page = target.value
  if (!page || !keys.length) return
  const current = work.value
  const removed = ignores.value.filter(rule => keys.includes(ignoreKey(rule)))
  const affected = new Set(entries.value.filter(entry => removed.some(rule => matchesIgnore(rule, entry.endpoint))).map(entry => entry.key))
  if (await command({ type: 'remove-ignores', target: page, keys }, '已移除所选忽略规则。')) {
    current.selected = current.selected.filter(key => !affected.has(key))
  }
}

function openBatch(event: MouseEvent) {
  if (!selectedEntries.value.length) return
  if (event.currentTarget instanceof HTMLElement) lastTrigger.value = event.currentTarget
  const current = work.value
  current.batch = prepareBatch(selectedEntries.value, rules.value)
  current.batchExpanded = null
  current.inspected = null
  current.editor = null
  plansOpen.value = false
  importOpen.value = false
  scenariosOpen.value = false
  focusDetail()
}

function cancelBatch() {
  if (activePane.value === 'batch') closeDetail()
  else work.value.batch = null
}

function batchScenario(choice: ScenarioChoice) {
  for (const { row, entry } of batchEntries.value) {
    const outcome = applyScenario(choice, entry)
    row.draft.response = outcome.response
    row.draft.headers = draftHeaders(outcome.response.headers)
    row.draft.allowInvalidJson = outcome.allowInvalidJson
  }
}

async function submitBatch() {
  const current = work.value
  const batch = current.batch
  const page = target.value
  if (!batch?.rows.length || !page) return
  try {
    const currentById = new Map(rules.value.map(rule => [rule.id, rule]))
    const replacements = new Set(batch.rows.flatMap(row => row.original ? [row.original.id] : []))
    const next = batch.rows.map(row => {
      try {
        return compileBatchRow(row, row.original ? currentById.get(row.original.id) : undefined, page.routeKey)
      } catch (cause) {
        current.batchExpanded = row.draft.id
        throw cause
      }
    })
    if (await applyRules([...rules.value.filter(rule => !replacements.has(rule.id)), ...next], `已应用 ${next.length} 条规则。`)) {
      const appliedKeys = new Set(batch.rows.map(row => row.entry.key))
      current.batch = null
      current.batchExpanded = null
      current.selected = current.selected.filter(key => !appliedKeys.has(key))
      if (current === work.value) {
        if (activePane.value) focusDetail()
        else returnFocus()
      }
    }
  } catch (cause) {
    setError(cause)
  }
}

async function stop() {
  const active = target.value
  if (!active || !canStop.value) return
  await command({ type: 'stop', target: active })
}

async function stopRoute() {
  const active = target.value
  if (active && canStopRoute.value) await command({ type: 'stop-route', target: active })
}

async function reconnectPage() {
  if (target.value && canReconnect.value) await command({ type: 'reconnect', target: target.value })
}

async function checkPage() {
  if (target.value && canEdit.value) await command({ type: 'reconnect', target: target.value }, '页面接入已确认。')
}

async function sample(entry: CatalogEntry) {
  if (target.value) await command({ type: 'sample', target: target.value, endpoint: entry.endpoint })
}

async function authorizeSite(early = false) {
  const active = target.value
  if (!active || !snapshot.value?.siteOrigin || busy.value || permissionBusy.value) return
  permissionBusy.value = true
  try {
    const url = new URL(snapshot.value.siteOrigin)
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] })
    if (granted) {
      const current = target.value
      if (!current || current.tabId !== active.tabId || current.documentId !== active.documentId) return
      await command({ type: early ? 'early-access' : 'reconnect', target: current })
    } else notice.value = '浏览器需要此站点权限才能接入请求。'
  } catch (cause) {
    setError(cause)
  } finally {
    permissionBusy.value = false
  }
}

async function resumeObserving() {
  if (target.value) await command({ type: 'set-observing', target: target.value, enabled: true })
}

async function setRouteGrouping(mode: RouteGrouping) {
  if (!target.value) return
  await command(
    { type: 'set-route-grouping', target: target.value, mode },
    mode === 'ignore-query' ? '已开启忽略查询参数，翻页或筛选时保持同一组。' : '已恢复按完整页面地址归组。',
  )
}

async function addImport(imported: CatalogEntry[], mode?: 'replace', expectedKeys?: string[]) {
  if (!target.value || !imported.length) return
  const opened = scope.value
  const message = mode === 'replace' ? `当前页面目录已替换为 ${imported.length} 个接口。` : `已将 ${imported.length} 个接口加入当前页面。`
  if (await command({ type: 'import', target: target.value, entries: imported, mode, expectedKeys }, message)) {
    if (opened === scope.value) importOpen.value = false
  }
}

async function deleteImports(keys: string[]) {
  if (!target.value || !keys.length) return
  await command({ type: 'delete-imports', target: target.value, keys }, `已从当前页面目录移除 ${keys.length} 个接口。`)
}

function openScenarios(seed?: ScenarioSeed, event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) lastTrigger.value = event.currentTarget
  scenarioSeed.value = seed
  scenariosOpen.value = true
  focusDetail()
}

async function saveScenario(scenario: CustomScenario) {
  const page = target.value
  if (!page) return
  const opened = scope.value
  if (await command({ type: 'save-scenario', target: page, scenario }, '场景已保存。') &&
      opened === scope.value && scenarioSeed.value) {
    closeDetail()
  }
}

async function deleteScenario(id: string) {
  if (target.value) await command({ type: 'delete-scenario', target: target.value, id }, '场景已删除。')
}

function resumePlanDraft() {
  if (!planDraft.value) return
  closePlanPreview()
  deletePlanId.value = ''
  planEditorOpen.value = true
  void nextTick(() => {
    if (detail.value) detail.value.scrollTop = 0
  })
}

function closePlanPreview() {
  previewPlanId.value = ''
  planShareOpen.value = false
}

function returnToPlans() {
  const selected = previewPlanId.value
  planEditorOpen.value = false
  closePlanPreview()
  void nextTick(() => {
    const row = [...(detail.value?.querySelectorAll<HTMLButtonElement>('[data-plan-id]') ?? [])]
      .find(button => button.dataset.planId === selected)
    if (row) row.focus()
    else focusDetail()
  })
}

function setPlanShare(open: boolean) {
  planShareOpen.value = open
  focusDetail()
}

function editPlan(existing?: SavedPlan, duplicate = false, fromActive = false) {
  const page = target.value
  if (!page || !snapshot.value) return
  if (planDraft.value) {
    if (planDraft.value.id !== existing?.id || duplicate) notice.value = '此页面已有方案草稿。请先保存或放弃草稿。'
    resumePlanDraft()
    return
  }
  const source: SavedPlan = existing ?? {
    id: crypto.randomUUID(), siteOrigin: snapshot.value.siteOrigin, routeKey: page.routeKey,
    name: '', rules: fromActive ? rules.value : [], setup: '', trigger: '', expectation: '', updatedAt: 0,
  }
  const plan = duplicate ? { ...source, id: crypto.randomUUID(), name: `${source.name} 副本`.slice(0, 80) } : source
  planDrafts.set(scope.value, preparePlanDraft(plan, entries.value, existing && !duplicate ? existing.updatedAt : null))
  resumePlanDraft()
}

function discardPlanDraft() {
  planDrafts.delete(scope.value)
  returnToPlans()
}

async function savePlan(asCopy = false) {
  const page = target.value
  const draft = planDraft.value
  if (!page || !draft || (!asCopy && planVersionChanged.value)) return
  const opened = scope.value
  try {
    const plan = compilePlanDraft(draft)
    if (asCopy) {
      plan.id = crypto.randomUUID()
      plan.name = `${plan.name} 副本`.slice(0, 80)
    }
    const expectedUpdatedAt = asCopy ? null : draft.expectedUpdatedAt
    if (await command({ type: 'save-plan', target: page, plan, expectedUpdatedAt }, '方案已保存。')) {
      if (planDrafts.get(opened) === draft) planDrafts.delete(opened)
      if (opened === scope.value) returnToPlans()
    }
  } catch (cause) {
    setError(cause)
  }
}

async function loadPlan() {
  const plan = previewPlan.value
  if (!plan?.rules.length) return
  const opened = documentScope.value
  if (await applyRules(plan.rules)) {
    if (opened === documentScope.value) {
      notice.value = '方案已启用。'
      returnToPlans()
    }
  }
}

async function removePlan(id: string) {
  if (!target.value) return
  const opened = scope.value
  if (await command({ type: 'delete-plan', target: target.value, planId: id }, '方案已删除。') && opened === scope.value) {
    deletePlanId.value = ''
    if (previewPlanId.value === id) closePlanPreview()
  }
}

function format(mime?: string) {
  if (!mime) return ''
  if (mime.includes('json')) return 'JSON'
  if (mime.startsWith('text/')) return '文本'
  return mime.split(';')[0]
}

function phaseText(event: RequestEvent) {
  const status = event.status === undefined ? '' : ` · HTTP ${event.status}`
  return {
    request: '页面已发出请求', real: `已收到真实响应${status}`, mock: `本轮已命中${status}`,
    bypassed: '请求已放行', delay: '模拟延迟中', error: '请求处理失败', cancelled: '已取消模拟请求',
  }[event.phase]
}

function rowSummary(entry: CatalogEntry) {
  const active = ownRules(entry).length > 0
  if (entry.last && (!active || entry.last.revision === target.value?.revision)) {
    return `${phaseText(entry.last)}${entry.last.phase === 'mock' && entry.last.status === undefined ? ' · 网络错误' : ''}${entry.imported ? ' · 文档导入' : ''}`
  }
  if (active) return '等待页面发请求'
  const source = entry.imported ? (entry.realSeen ? '文档导入 · 已观察' : '文档导入 · 未触发') : '已发现'
  return [source, format(entry.contentType)].filter(Boolean).join(' · ')
}

function ruleOutcomeLabel(ruleId: string) {
  const result = ruleOutcomes.value.get(ruleId)
  if (!result) return canEdit.value ? '本轮未命中' : '等待页面确认'
  const latest = {
    mock: result.status === undefined ? '模拟网络错误' : `HTTP ${result.status}`,
    delay: '延迟中', error: '处理失败', cancelled: '已取消',
  }[result.phase]
  return result.hitCount ? `本轮命中 ${result.hitCount} 次 · 最近 ${latest}` : latest
}

function responseLabel({ response, maxHits, headersCount }: Pick<Rule, 'response' | 'maxHits'> & { headersCount?: number }) {
  const delay = response.delayMs ? ` · 延迟 ${response.delayMs} ms` : ''
  const retry = response.kind === 'http' && response.retryAfterSeconds !== undefined ? ` · Retry-After ${response.retryAfterSeconds} s` : ''
  const customHeaders = response.kind === 'http' ? (headersCount ?? Object.keys(response.headers ?? {}).length) : 0
  const headersNote = customHeaders ? ` · ${customHeaders} 个自定义头` : ''
  const limit = maxHits ? ` · 限 ${maxHits} 次` : ''
  return `${response.kind === 'network' ? '网络错误' : `HTTP ${response.status}`}${delay}${retry}${headersNote}${limit}`
}

function viewPlan(plan: SavedPlan) {
  planEditorOpen.value = false
  closePlanPreview()
  previewPlanId.value = plan.id
  focusDetail()
}

function handleEscape() {
  if (busy.value) return
  if (activePane.value === 'plans' && planEditorOpen.value) returnToPlans()
  else if (activePane.value === 'plans' && planShareOpen.value) setPlanShare(false)
  else if (activePane.value === 'plans' && previewPlan.value) returnToPlans()
  else if (activePane.value === 'request' && editor.value) closeEditor()
  else closeDetail()
}
</script>


<template>
  <div class="workspace-shell" @keydown.esc="handleEscape">
    <header class="toolbar">
      <div class="toolbar-brand">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 5.5 3.5 12 7 18.5m10 0 3.5-6.5L17 5.5M10 17l4-10" /></svg></span>
        <h1>APIFaultLab</h1>
      </div>
      <div class="route-context" aria-label="当前页面" :title="routeTitle">
        <span v-if="displayRoute.host" class="route-host mono">{{ displayRoute.host }}</span>
        <span class="route-path mono">{{ displayRoute.path }}</span>
      </div>
      <div class="toolbar-actions">
        <div class="session-info" aria-live="polite">
          <button v-if="canEdit" class="status status-check" :data-status="status === 'observing' && !observing ? 'idle' : status"
            type="button" :disabled="busy" aria-label="检查页面接入" title="检查页面接入" @click="checkPage">
            {{ statusLabel }}
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.75 6A5 5 0 1 0 13 10M12.75 2.75V6H9.5" /></svg>
          </button>
          <span v-else class="status" :data-status="!connected ? 'loading' : status">{{ statusLabel }}</span>
          <span v-if="configuredCount || activeCount" class="session-count mono" :title="activeCount > rules.length ? `其中 ${activeCount - rules.length} 条作用于其他页面` : undefined">
            {{ activeCount ? `${activeCount} 条规则` : `${configuredCount} 条待接回` }}
          </span>
        </div>
        <button v-if="canStop" type="button" class="button button-danger stop-button" title="停止此标签页所有页面的模拟规则" :disabled="busy || status === 'stopping'" @click="stop">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>
          停止标签页规则
        </button>
        <button v-else-if="status === 'observing' && !observing" type="button" class="button" :disabled="busy || !connected" @click="resumeObserving">继续采集</button>
      </div>
    </header>

    <div v-if="feedback || sessionWarning" class="feedback-strip" :class="{ 'feedback-error': error || connectionError || (!notice && storageError && !canAuthorize && !canReconnect) }">
      <div class="feedback-copy">
        <p v-if="feedback" :role="error || connectionError ? 'alert' : 'status'">{{ feedback }}</p>
        <p v-if="sessionWarning && sessionWarning !== feedback" class="session-warning" role="status">{{ sessionWarning }}</p>
      </div>
      <button v-if="!connected && connectionError" class="button button-text" type="button" @click="retry">重新连接</button>
      <button v-else-if="canAuthorize" class="button button-primary" type="button" :disabled="permissionBusy || busy" @click="authorizeSite()">
        {{ permissionBusy ? '等待浏览器确认…' : '授权此站点' }}
      </button>
      <button v-else-if="canReconnect" class="button button-text" type="button" :disabled="busy" @click="reconnectPage">重试接入</button>
      <button v-else-if="canPrepareStartup" class="button button-text" type="button" :disabled="permissionBusy || busy" @click="authorizeSite(true)">准备首屏接入</button>
      <button v-else-if="error" class="button button-text" type="button" @click="error = ''">关闭</button>
      <button v-else-if="notice" class="button button-text" type="button" @click="notice = ''">关闭</button>
      <button v-else-if="storageError" class="button button-text" type="button" :disabled="busy" @click="openBackup">数据备份</button>
    </div>

    <main class="workspace" :class="{ 'workspace-with-detail': activePane }">
      <section class="request-pane" aria-label="接口列表">
        <header class="request-header">
          <div class="request-title">
            <h2 ref="requestTitle" tabindex="-1">请求</h2>
            <span v-if="entries.length" class="request-count mono"
              :title="`显示 ${visible.length} / ${entries.length} 个请求${pendingImports ? `，${pendingImports} 个来自文档` : ''}`">{{ visible.length }}</span>
          </div>
          <div class="request-tools" aria-label="请求工具">
            <button v-if="canStopRoute" class="button button-text button-danger" type="button" :disabled="busy" @click="stopRoute">停止本页规则</button>
            <button type="button" class="button button-quiet" :disabled="!target || busy"
              :aria-pressed="activePane === 'import'" @click="activePane === 'import' ? closeDetail() : openUtility('import', $event)">导入</button>
            <button type="button" class="button button-quiet" :disabled="busy"
              :aria-pressed="activePane === 'plans'" @click="activePane === 'plans' ? closeDetail() : openUtility('plans', $event)">方案</button>
            <button type="button" class="button button-quiet" :disabled="!target || busy"
              :aria-pressed="activePane === 'scenarios'" @click="activePane === 'scenarios' ? closeDetail() : openScenarios(undefined, $event)">自定义场景</button>
          </div>
        </header>
        <label class="search-field">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></svg>
          <input v-model="work.filter" class="input" type="search" placeholder="筛选方法、路径或名称" aria-label="筛选请求" />
        </label>
        <RequestFilters v-if="target" :key="snapshot?.siteOrigin" :filter="work.requestFilter" :entries="entries" :ignores="ignores"
          :active-keys="activeKeys" :route-grouping="routeGrouping" :busy="busy || !canPersist"
          @filter="work.requestFilter = $event" @add="addIgnores" @remove="removeIgnores" @route-grouping="setRouteGrouping" />
        <p v-if="snapshot?.catalogAtCapacity" class="subtle catalog-note" role="status">请求记录达到上限，优先保留有规则的请求和业务接口。</p>

        <div v-if="entries.length" class="request-columns">
          <input type="checkbox" class="check" :checked="allVisible" :indeterminate.prop="selectedVisible > 0 && !allVisible"
            :disabled="!visible.length || !!work.batch" aria-label="选择可见接口" @change="toggleVisible" />
          <span>方法</span>
          <span>接口</span>
        </div>

        <div ref="list" class="request-scroll">
          <div v-if="!entries.length" class="empty-state">
            <h3>{{ status === 'restoring' ? '等待页面确认规则' : status === 'loading' ? '正在接入页面' : '暂无请求' }}</h3>
            <p v-if="target && !canAuthorize && status === 'restoring'">页面就绪后会继续采集请求。</p>
            <p v-else-if="target && !canAuthorize && observing">在网页中触发请求，或导入 OpenAPI / Swagger 文档。</p>
            <p v-else-if="target && status === 'observing'">采集已暂停，可继续采集或导入文档。</p>
            <p v-else-if="!target && status !== 'loading'">在需要测试的 HTTP 或 HTTPS 页面打开开发者工具。</p>
            <div v-if="target && !canAuthorize && observing && status !== 'restoring'" class="button-row compact">
              <button type="button" class="button" :disabled="busy || !connected || !observing" @click="command({ type: 'refresh', target })">刷新网页</button>
              <button type="button" class="button button-text" :disabled="busy || !connected || permissionBusy" @click="authorizeSite(true)">准备首屏接入</button>
            </div>
          </div>
          <div v-else-if="!visible.length" class="empty-filter subtle">
            <p>没有匹配的接口。</p>
            <button v-if="work.filter" type="button" class="button button-text" @click="work.filter = ''">清除搜索</button>
            <button v-else-if="work.requestFilter === 'all' && ignoredKeys.size" type="button" class="button button-text"
              @click="work.requestFilter = 'ignored'">查看已忽略的接口</button>
          </div>
          <ul v-else class="interface-list">
            <li v-for="entry in visible" :key="entry.key" class="interface-row" :class="{
              'row-picked': activePane === 'request' && inspectedEntry?.key === entry.key,
              'row-checked': work.selected.includes(entry.key),
            }">
              <input type="checkbox" class="check" :checked="selectedKeys.has(entry.key)" :disabled="!!work.batch"
                :aria-label="`选择 ${entry.endpoint.method} ${entry.endpoint.path}`" @change="toggleEntry(entry.key, ($event.target as HTMLInputElement).checked)" />
              <button type="button" class="endpoint-button" :title="`${entry.endpoint.origin}${entry.endpoint.path}`" :data-request-key="entry.key"
                :aria-pressed="activePane === 'request' && inspectedEntry?.key === entry.key" :disabled="!!work.batch"
                @click="inspect(entry, $event.currentTarget as HTMLElement)" @keydown.up="stepRequest(entry, -1, $event)" @keydown.down="stepRequest(entry, 1, $event)">
                <span class="method mono" :data-method="entry.endpoint.method">{{ entry.endpoint.method }}</span>
                <span class="endpoint-copy">
                  <span class="endpoint-path mono">{{ entry.endpoint.path }}</span>
                  <span class="row-summary" :class="{ 'row-hit': entry.last?.phase === 'mock' && entry.last.revision === target?.revision, 'row-failed': entry.last?.phase === 'error' }">
                    {{ rowSummary(entry) }}<template v-if="entry.hitCount && entry.last?.revision === target?.revision"> · 本轮累计命中 {{ entry.hitCount }} 次</template>
                    <template v-if="ignoredKeys.has(entry.key)"> · 已忽略</template>
                  </span>
                </span>
                <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 2.75 3 3.25-3 3.25" /></svg>
              </button>
            </li>
          </ul>
        </div>

        <footer v-if="selectedCount || work.batch" class="selection-bar">
          <div class="selection-count">
            <strong>选中 {{ selectedEntries.length }} 项可见接口</strong>
            <small v-if="selectedHidden">另有 {{ selectedHidden }} 项在筛选之外</small>
          </div>
          <div class="button-row compact selection-actions">
            <button v-if="work.batch" type="button" class="button button-text" :disabled="busy" @click="cancelBatch">返回勾选</button>
            <template v-else>
              <button type="button" class="button button-text" @click="work.selected = []">清空</button>
              <button v-if="work.requestFilter === 'ignored'" type="button" class="button" :disabled="busy || !canPersist || !restorableKeys.length"
                @click="removeIgnores(restorableKeys)">取消忽略</button>
              <template v-else>
                <button type="button" class="button" :disabled="busy || !canPersist || !ignorable.length" @click="ignoreSelection">忽略所选</button>
                <button type="button" class="button button-primary" :disabled="busy || !selectedEntries.length" @click="openBatch">批量设置</button>
              </template>
            </template>
          </div>
        </footer>
      </section>

      <section class="inspector" aria-label="请求详情">
        <header v-if="activePane" class="inspector-chrome">
          <button type="button" class="button button-quiet back-button" :disabled="busy" @click="closeDetail">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>返回请求
          </button>
          <h2 v-if="activePane === 'request' && inspectedEntry" ref="detailTitle" class="inspector-title" tabindex="-1">
            <span class="method mono" :data-method="inspectedEntry.endpoint.method">{{ inspectedEntry.endpoint.method }}</span>
            <span class="mono" :title="inspectedEntry.endpoint.path">{{ inspectedEntry.endpoint.path }}</span>
          </h2>
          <h2 v-else ref="detailTitle" class="inspector-title" tabindex="-1">{{ utilityTitle }}</h2>
          <button type="button" class="button button-quiet close-detail" :disabled="busy" aria-label="关闭详情" @click="closeDetail">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" /></svg>
          </button>
        </header>

        <div v-if="activePane === 'request' && editor && inspectedEntry" class="inspector-action">
          <div class="inspector-action-copy">
            <p class="mono">{{ responseLabel({ response: editor.draft.response, maxHits: editor.draft.maxHits, headersCount: editor.draft.headers.filter(item => item.name.trim()).length }) }}</p>
            <p class="subtle">{{ editingScope }}</p>
          </div>
          <div class="button-row compact">
            <button type="button" class="button button-quiet" :disabled="busy" @click="closeEditor">取消</button>
            <button type="button" class="button button-primary" :disabled="busy || !canEdit" @click="submitEditor(inspectedEntry)">
              {{ applyingRules ? '正在启用…' : editor.originalId ? '更新规则' : '启用规则' }}
            </button>
          </div>
        </div>
        <div v-else-if="activePane === 'batch' && batchEntries.length" class="inspector-action">
          <div class="inspector-action-copy">
            <p>{{ batchChanges }}</p>
            <p v-if="batchBroadCount" class="subtle inspector-scope-warning">{{ batchBroadCount }} 条新规则覆盖整个接口或路径模板</p>
          </div>
          <div class="button-row compact">
            <button type="button" class="button button-primary" :disabled="busy || !canEdit" @click="submitBatch">
              {{ applyingRules ? '正在启用…' : `启用 ${batchEntries.length} 条规则` }}
            </button>
          </div>
        </div>
        <div v-else-if="activePane === 'plans' && previewPlan && !planEditorOpen && !planShareOpen" class="inspector-action">
          <div class="inspector-action-copy">
            <p>{{ previewPlan.name }}</p>
            <p class="subtle">
              {{ previewPlan.rules.length }} 条规则 · {{ rules.length ? `替换本页 ${rules.length} 条现有规则` : '作用于本页' }}<span v-if="previewHasBroadRule" class="inspector-scope-warning"> · 含路径模板或无条件匹配</span>
            </p>
          </div>
          <div class="button-row compact">
            <button type="button" class="button button-quiet" :disabled="busy" @click="returnToPlans">关闭预览</button>
            <button type="button" class="button" :disabled="busy" @click="setPlanShare(true)">分享方案</button>
            <button type="button" class="button button-primary" :disabled="busy || !canEdit || !previewPlan.rules.length" @click="loadPlan">{{ status === 'applying' ? '启用中…' : '启用方案' }}</button>
          </div>
        </div>

        <div ref="detail" class="inspector-scroll">
          <DocumentImport v-if="activePane === 'import' && target" :key="scope" :site-origin="snapshot?.siteOrigin ?? ''" :route-key="target.routeKey"
            :imported-entries="snapshot?.importedEntries ?? []" :busy="busy || !canPersist" @import="addImport" @delete="deleteImports" />
          <ScenarioLibrary v-else-if="activePane === 'scenarios'" :scenarios="scenarios" :busy="busy || !canPersist" :seed="scenarioSeed"
            @save="saveScenario" @delete="deleteScenario" @close="closeDetail" />

          <section v-else-if="activePane === 'plans'" class="drawer plan-pane" aria-label="测试方案">
            <template v-if="!planEditorOpen && !previewPlan">
              <div class="button-row plan-actions">
                <button v-if="planDraft" class="button button-primary button-small" type="button" :disabled="busy" @click="resumePlanDraft">继续方案草稿</button>
                <template v-else>
                  <button class="button button-primary button-small" type="button" :disabled="busy || !target" @click="editPlan()">新建方案</button>
                  <button v-if="rules.length" class="button button-small" type="button" :disabled="busy || !target" @click="editPlan(undefined, false, true)">从当前规则创建</button>
                </template>
              </div>
              <BackupTools v-model:expanded="backupExpanded" :storage-error="storageError" :rescue-available="snapshot?.storageRescueAvailable" />
              <p v-if="!routePlans.length" class="subtle">{{ storageError ? '暂时无法读取已保存方案。' : target ? '此页面暂无已保存方案。' : '连接页面后可查看对应的测试方案。' }}</p>
              <ul v-if="routePlans.length" class="plan-list">
                <li v-for="plan in routePlans" :key="plan.id">
                  <div class="plan-item">
                    <button type="button" class="button button-text plan-name" :data-plan-id="plan.id" @click="viewPlan(plan)">{{ plan.name }}</button>
                    <span class="subtle">{{ plan.rules.length }} 条规则</span>
                  </div>
                  <div class="button-row compact plan-item-actions">
                    <button type="button" class="button button-text" :disabled="busy" @click="editPlan(plan)">编辑</button>
                    <button type="button" class="button button-text" :disabled="busy" @click="editPlan(plan, true)">复制</button>
                    <button type="button" class="button button-text button-danger" :disabled="busy" @click="deletePlanId = plan.id">删除</button>
                  </div>
                  <div v-if="deletePlanId === plan.id" class="button-row compact">
                    <span class="subtle">删除「{{ plan.name }}」？</span>
                    <button type="button" class="button button-text" :disabled="busy" @click="deletePlanId = ''">取消</button>
                    <button type="button" class="button button-text button-danger" :disabled="busy || !canPersist" @click="removePlan(plan.id)">删除方案</button>
                  </div>
                </li>
              </ul>
            </template>
            <PlanEditor v-else-if="planDraft && planEditorOpen" :key="planDraft.id" :draft="planDraft" :entries="entries" :scenarios="scenarios"
              :busy="busy" :can-save="canPersist" :version-changed="planVersionChanged"
              @save="savePlan()" @save-copy="savePlan(true)" @close="returnToPlans" @discard="discardPlanDraft"
              @manage-scenarios="openScenarios()" @save-scenario="openScenarios" />
            <PlanShare v-else-if="previewPlan && planShareOpen" :key="previewPlan.id" :plan="previewPlan" @close="setPlanShare(false)" />
            <div v-else-if="previewPlan" class="plan-form">
              <p class="subtle mono scope-copy">{{ previewPlan.routeKey }}</p>
              <dl v-if="previewPlan.setup || previewPlan.trigger || previewPlan.expectation" class="plan-notes">
                <template v-if="previewPlan.setup"><dt>测试前准备</dt><dd>{{ previewPlan.setup }}</dd></template>
                <template v-if="previewPlan.trigger"><dt>怎么操作</dt><dd>{{ previewPlan.trigger }}</dd></template>
                <template v-if="previewPlan.expectation"><dt>预期页面表现</dt><dd>{{ previewPlan.expectation }}</dd></template>
              </dl>
              <details v-for="rule in previewPlan.rules" :key="rule.id" class="report-details">
                <summary><span class="mono">{{ rule.endpoint.method }} {{ rule.endpoint.origin }}{{ rule.endpoint.path }}</span> · {{ responseLabel(rule) }}</summary>
                <p v-if="rule.endpoint.template" class="subtle">此路径模板匹配多种路径。</p>
                <ul v-if="rule.conditions.length">
                  <li v-for="(condition, index) in rule.conditions" :key="index" class="mono">{{ describeCondition(condition) }}</li>
                </ul>
                <p v-else class="subtle">匹配该端点的所有操作。</p>
                <dl v-if="rule.response.headers && Object.keys(rule.response.headers).length" class="plan-notes">
                  <template v-for="(value, name) in rule.response.headers" :key="name"><dt class="mono">{{ name }}</dt><dd class="mono">{{ value }}</dd></template>
                </dl>
                <pre v-if="rule.response.body" class="response-preview mono">{{ rule.response.body }}</pre>
              </details>
            </div>
          </section>

          <section v-else-if="activePane === 'batch' && work.batch" class="drawer batch-drawer" aria-label="批量设置">
            <details v-if="work.batch.skipped.length" class="report-details" :open="!batchEntries.length">
              <summary>跳过 {{ work.batch.skipped.length }} 个具体路径</summary>
              <p>这些路径由模板规则覆盖。可在请求详情中查看对应的模板并单独修改。</p>
              <ul>
                <li v-for="{ entry, templates } in work.batch.skipped" :key="entry.key" class="mono scope-copy">
                  {{ entry.endpoint.method }} {{ entry.endpoint.origin }}{{ entry.endpoint.path }} · 模板 {{ templates.join('、') }}
                </li>
              </ul>
            </details>
            <ScenarioPicker v-if="batchEntries.length" :scenarios="scenarios" :busy="busy" @choose="batchScenario" @manage="openScenarios()" />
            <ul v-if="batchEntries.length" class="batch-list" aria-label="本次模拟范围">
              <li v-for="{ row, entry, conditions } in batchEntries" :key="row.draft.id">
                <button class="button button-text batch-item-title" type="button" :aria-expanded="work.batchExpanded === row.draft.id"
                  @click="work.batchExpanded = work.batchExpanded === row.draft.id ? null : row.draft.id">
                  <span class="mono" :title="`${entry.endpoint.origin}${entry.endpoint.path}`">{{ entry.endpoint.method }} {{ entry.endpoint.path }}</span>
                  <span class="subtle">{{ row.original ? '更新' : '新增' }} · {{ responseLabel({ response: row.draft.response, maxHits: row.draft.maxHits, headersCount: row.draft.headers.filter(item => item.name.trim()).length }) }}</span>
                </button>
                <p class="subtle mono scope-copy">{{ entry.endpoint.origin }}<template v-if="entry.endpoint.template"> · 路径模板</template></p>
                <ul v-if="conditions.length" class="rule-scope subtle mono" aria-label="匹配条件，全部满足">
                  <li v-for="(condition, index) in conditions" :key="index">{{ condition }}</li>
                </ul>
                <p v-else class="subtle">匹配此端点的所有操作</p>
                <RuleEditor v-if="work.batchExpanded === row.draft.id" :entry="entry" :draft="row.draft" :scenarios="scenarios"
                  :busy="busy" :lock-conditions="Boolean(row.original)" batch @manage-scenarios="openScenarios()" @save-scenario="openScenarios" />
              </li>
            </ul>
          </section>

          <div v-else-if="activePane === 'request' && editor && editorEntry && inspectedEntry" class="request-detail request-edit">
            <RuleEditor :key="editor.draft.id" :entry="editorEntry" :draft="editor.draft"
              :scenarios="scenarios" :busy="busy" :page-ready="canEdit" :observing="observing" :sample-state="inspectedSample"
              :sample-blocked="sampleBlocked" :replacing="!!editor.originalId" @sample="sample(inspectedEntry)"
              @manage-scenarios="openScenarios()" @save-scenario="openScenarios" />
          </div>

          <div v-else-if="activePane === 'request' && inspectedEntry" class="request-detail">
            <div class="request-meta">
              <div>
                <p v-if="inspectedEntry.title" class="entry-title">{{ inspectedEntry.title }}</p>
                <p class="subtle mono scope-copy">{{ inspectedEntry.endpoint.origin }}{{ inspectedEntry.endpoint.path }}</p>
              </div>
              <button v-if="!ownRules(inspectedEntry).length" class="button button-primary" type="button"
                :disabled="busy" @click="openEditor(inspectedEntry)">添加模拟规则</button>
            </div>

            <section v-if="inspectedEntry.operations?.length" class="detail-section" aria-label="目录操作">
              <h3>目录操作</h3>
              <ul class="entry-rules">
                <li v-for="operation in inspectedEntry.operations" :key="operation.id" class="entry-rule">
                  <div>
                    <p>{{ operation.title }} <span class="subtle">· {{ catalogSources[operation.source] }}</span></p>
                    <p v-if="operation.conditions.length" class="subtle mono scope-copy">{{ operation.conditions.map(describeCondition).join(' · ') }}</p>
                    <p v-else class="subtle">未指定匹配条件</p>
                  </div>
                  <button type="button" class="button button-text" :disabled="busy" @click="newRule(inspectedEntry, operation)">创建规则草稿</button>
                </li>
              </ul>
            </section>

            <section v-if="inspectedEntry.last" class="detail-section" aria-label="最近请求">
              <h3>最近请求</h3>
              <dl class="plan-notes">
                <dt>结果</dt><dd>{{ phaseText(inspectedEntry.last) }}</dd>
                <dt>时间</dt><dd class="mono">{{ new Date(inspectedEntry.last.time).toLocaleTimeString('zh-CN') }}</dd>
                <template v-if="inspectedEntry.last.detail"><dt>说明</dt><dd>{{ inspectedEntry.last.detail }}</dd></template>
              </dl>
            </section>

            <section v-if="ownRules(inspectedEntry).length" class="detail-section" aria-label="模拟规则">
              <div class="detail-section-title">
                <h3>模拟规则</h3>
                <button type="button" class="button button-text" :disabled="busy" @click="newRule(inspectedEntry)">添加条件规则</button>
              </div>
              <ul class="entry-rules">
                <li v-for="rule in ownRules(inspectedEntry)" :key="rule.id">
                  <div class="rule-summary">
                    <div class="rule-headline">
                      <span class="mono">{{ responseLabel(rule) }}</span>
                      <small class="subtle">{{ ruleOutcomeLabel(rule.id) }}</small>
                    </div>
                    <p v-if="rule.endpoint.template" class="subtle mono scope-copy">路径模板 {{ rule.endpoint.path }}</p>
                    <ul v-if="rule.conditions.length" class="rule-scope subtle mono" aria-label="匹配条件，全部满足">
                      <li v-for="(condition, index) in rule.conditions" :key="index">{{ describeCondition(condition) }}</li>
                    </ul>
                    <p v-else class="subtle">匹配此端点的所有操作</p>
                  </div>
                  <button type="button" class="button button-text" :disabled="busy" @click="openEditor(inspectedEntry, rule)">编辑</button>
                  <button type="button" class="button button-text button-danger" :disabled="busy || !canEdit" @click="removeRule(rule.id)">停用</button>
                </li>
              </ul>
            </section>

          </div>

          <div v-else class="inspector-empty">
            <p>选择一个请求查看详情</p>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
