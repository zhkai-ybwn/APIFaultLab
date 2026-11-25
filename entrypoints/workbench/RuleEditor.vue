<script setup lang="ts">
import { computed, ref, shallowRef, useId } from 'vue'
import type { CatalogEntry, CustomScenario, RequestCondition, ResponseSampleState } from '../../lib/model'
import { applyScenario, presetResponse, presets, sameScenarioResponse, scenarioKey, type ScenarioChoice, type ScenarioSeed } from '../../lib/scenarios'
import { compileDraftHeaders, draftHeaders, emptyWithStructure, newCondition, newResponseHeader, type RuleDraft } from './editor'
import ScenarioPicker from './ScenarioPicker.vue'

const props = defineProps<{
  entry: CatalogEntry
  draft: RuleDraft
  busy: boolean
  pageReady?: boolean
  observing?: boolean
  sampleState?: ResponseSampleState
  sampleBlocked?: boolean
  scenarios?: CustomScenario[]
  batch?: boolean
  replacing?: boolean
  lockConditions?: boolean
}>()

const emit = defineEmits<{
  sample: []
  'manage-scenarios': []
  'save-scenario': [seed: ScenarioSeed]
}>()
const id = useId()
const conditionsOpen = ref(props.draft.conditions.length > 0)
const responseOpen = ref(Boolean(props.replacing))
const preserveOpen = ref(false)
const listPath = ref('/data/list')
const totalPath = ref('/data/total')
const structureError = ref('')
const baseJson = computed(() => props.entry.sample ?? props.entry.example?.body)
const noBody = computed(() => props.entry.endpoint.method === 'HEAD' || [204, 205].includes(props.draft.response.status))
const lastChoice = shallowRef<ScenarioChoice>()
const currentResponse = computed(() => {
  if (props.draft.response.kind !== 'http') return props.draft.response
  try {
    const headers = compileDraftHeaders(props.draft.headers)
    return { ...props.draft.response, ...(headers ? { headers } : { headers: undefined }) }
  } catch {
    return props.draft.response
  }
})
const selectedPreset = computed(() => {
  const response = currentResponse.value
  if (lastChoice.value) {
    const choice = applyScenario(lastChoice.value, props.entry)
    if (props.draft.allowInvalidJson === choice.allowInvalidJson && sameScenarioResponse(response, choice.response)) {
      return scenarioKey(lastChoice.value)
    }
  }
  if (!props.draft.allowInvalidJson) {
    const builtin = presets.find(({ value }) => sameScenarioResponse(response, presetResponse(value, props.entry)))
    if (builtin) return `builtin:${builtin.value}`
  }
  const custom = props.scenarios?.find(scenario => props.draft.allowInvalidJson === Boolean(scenario.allowInvalidJson) &&
    sameScenarioResponse(response, scenario.response))
  return custom ? `custom:${custom.id}` : undefined
})

function choosePreset(choice: ScenarioChoice) {
  const { response, allowInvalidJson } = applyScenario(choice, props.entry)
  props.draft.response = response
  props.draft.headers = draftHeaders(response.headers)
  props.draft.allowInvalidJson = allowInvalidJson
  lastChoice.value = choice
  structureError.value = ''
}

function editRetry(event: Event) {
  const input = event.target as HTMLInputElement
  props.draft.response.retryAfterSeconds = input.value ? input.valueAsNumber : undefined
}

function editMaxHits(event: Event) {
  const input = event.target as HTMLInputElement
  props.draft.maxHits = input.value ? input.valueAsNumber : undefined
}

function conditionMeta(source: RequestCondition['source']) {
  if (source === 'query') return { title: '查询参数', field: '参数名', fieldPlaceholder: 'page', valuePlaceholder: '1' }
  if (source === 'header') return { title: '请求头', field: '请求头名称', fieldPlaceholder: 'X-Action', valuePlaceholder: 'ListOrders' }
  return { title: 'JSON 字段', field: 'JSON 路径', fieldPlaceholder: '/operationName', valuePlaceholder: 'ListOrders' }
}

function saveAsScenario() {
  emit('save-scenario', {
    response: { ...currentResponse.value, ...(currentResponse.value.headers ? { headers: { ...currentResponse.value.headers } } : {}) },
    allowInvalidJson: props.draft.allowInvalidJson,
  })
}

function useSample() {
  if (props.entry.sample === undefined) return
  props.draft.response.body = props.entry.sample
  if (props.entry.contentType) props.draft.response.contentType = props.entry.contentType
  props.draft.allowInvalidJson = false
}

function useExample() {
  if (!props.entry.example) return
  props.draft.response = { ...props.entry.example, ...(props.entry.example.headers ? { headers: { ...props.entry.example.headers } } : {}) }
  props.draft.headers = draftHeaders(props.entry.example.headers)
  props.draft.allowInvalidJson = false
}

function preserveStructure() {
  if (!baseJson.value) return
  try {
    props.draft.response = emptyWithStructure(baseJson.value, listPath.value, totalPath.value)
    props.draft.allowInvalidJson = false
    structureError.value = ''
    preserveOpen.value = false
  } catch (error) {
    structureError.value = error instanceof Error ? error.message : '无法读取响应结构'
  }
}
</script>

<template>
  <div class="rule-editor" :aria-label="`${entry.endpoint.method} ${entry.endpoint.path} 的模拟规则`">
    <p v-if="entry.endpoint.template" class="subtle scope-copy">模板 <code>{{ entry.endpoint.path }}</code> 中的变量匹配任意一个路径段。</p>
    <ScenarioPicker :scenarios="scenarios" :selected="selectedPreset" :busy="busy" @choose="choosePreset" @manage="emit('manage-scenarios')" />

    <div v-if="!lockConditions" class="editor-disclosure">
      <button type="button" class="button button-text" :aria-expanded="conditionsOpen" :aria-controls="`${id}-conditions`"
        @click="conditionsOpen = !conditionsOpen">
        {{ conditionsOpen ? '收起请求条件' : '设置请求条件' }}
      </button>
      <p v-if="!conditionsOpen" class="subtle">{{ draft.conditions.length ? `已设置 ${draft.conditions.length} 条条件` : '匹配此端点的所有操作' }}</p>
    </div>
    <div v-if="!lockConditions && conditionsOpen" :id="`${id}-conditions`" class="editor-section">
      <p class="subtle">全部条件同时满足时生效。JSON 路径示例 /operationName，请求头名称不区分大小写。</p>
      <div v-for="(condition, index) in draft.conditions" :key="condition.id" class="condition">
        <div class="condition-top">
          <span class="field-label">{{ conditionMeta(condition.source).title }}</span>
          <button type="button" class="button button-text button-danger" :disabled="busy" :aria-label="`移除条件 ${index + 1}`"
            @click="draft.conditions.splice(index, 1)">移除</button>
        </div>
        <div class="editor-grid">
          <label class="field">
            <span>{{ conditionMeta(condition.source).field }}</span>
            <input v-model="condition.path" class="input mono" :disabled="busy" :placeholder="conditionMeta(condition.source).fieldPlaceholder" />
          </label>
          <label class="field">
            <span>等于</span>
            <input v-model="condition.value" class="input mono" :disabled="busy" :placeholder="conditionMeta(condition.source).valuePlaceholder" />
          </label>
        </div>
        <label v-if="condition.source === 'json'" class="check-line subtle">
          <input type="checkbox" class="check" :checked="condition.valueKind === 'scalar'" :disabled="busy"
            @change="condition.valueKind = ($event.target as HTMLInputElement).checked ? 'scalar' : 'text'" />
          使用数字、布尔值或 null
        </label>
      </div>
      <div class="button-row">
        <button type="button" class="button button-small" :disabled="busy" @click="draft.conditions.push(newCondition('query'))">添加查询条件</button>
        <button type="button" class="button button-small" :disabled="busy" @click="draft.conditions.push(newCondition('header'))">添加请求头条件</button>
        <button type="button" class="button button-small" :disabled="busy" @click="draft.conditions.push(newCondition('json'))">添加 JSON 条件</button>
      </div>
    </div>

    <div class="editor-disclosure">
      <button type="button" class="button button-text" :aria-expanded="responseOpen" :aria-controls="`${id}-response`"
        @click="responseOpen = !responseOpen">{{ responseOpen ? '收起响应' : '编辑响应' }}</button>
      <p v-if="!responseOpen" class="subtle mono">
        {{ draft.response.kind === 'http' ? `HTTP ${draft.response.status}` : '网络错误' }}
        <span v-if="draft.response.delayMs"> · {{ draft.response.delayMs }} 毫秒</span>
        <span v-if="draft.maxHits"> · 限 {{ draft.maxHits }} 次</span>
      </p>
      <button type="button" class="button button-text" :disabled="busy" @click="saveAsScenario">保存为场景</button>
    </div>
    <div v-if="responseOpen" :id="`${id}-response`" class="editor-section">
      <div class="editor-grid">
        <label class="field">
          <span>HTTP 状态</span>
          <input v-model.number="draft.response.status" class="input mono" type="number" min="200" max="599" step="1"
            :disabled="busy || draft.response.kind === 'network'" required />
        </label>
        <label class="field">
          <span>延迟（毫秒）</span>
          <input v-model.number="draft.response.delayMs" class="input mono" type="number" min="0" max="60000" step="1" :disabled="busy" required />
        </label>
        <label class="field">
          <span>最多生效次数</span>
          <input :value="draft.maxHits ?? ''" type="number" min="1" max="1000" step="1" placeholder="不限" class="input mono" :disabled="busy" @input="editMaxHits" />
        </label>
        <label v-if="draft.response.kind === 'http' && ([429, 503].includes(draft.response.status) || draft.response.retryAfterSeconds !== undefined)" class="field">
          <span>Retry-After（秒）</span>
          <input :value="draft.response.retryAfterSeconds ?? ''" type="number" min="0" step="1" class="input mono" :disabled="busy" @input="editRetry" />
        </label>
      </div>
      <label class="check-line subtle">
        <input type="checkbox" class="check" :checked="draft.response.kind === 'network'" :disabled="busy"
          @change="draft.response.kind = ($event.target as HTMLInputElement).checked ? 'network' : 'http'" />
        模拟网络错误
      </label>
      <div v-if="draft.response.kind === 'http'" class="editor-section">
        <div class="condition-top">
          <span class="field-label">自定义响应头（可选）</span>
          <button type="button" class="button button-text" :disabled="busy || draft.headers.length >= 20"
            @click="draft.headers.push(newResponseHeader())">添加响应头</button>
        </div>
        <div v-for="(header, index) in draft.headers" :key="header.id" class="condition">
          <div class="condition-top">
            <span class="subtle">响应头 {{ index + 1 }}</span>
            <button type="button" class="button button-text button-danger" :disabled="busy" :aria-label="`移除响应头 ${index + 1}`"
              @click="draft.headers.splice(index, 1)">移除</button>
          </div>
          <div class="editor-grid">
            <label class="field">
              <span>名称</span>
              <input v-model="header.name" class="input mono" placeholder="X-Total-Count" :disabled="busy" />
            </label>
            <label class="field">
              <span>值</span>
              <input v-model="header.value" class="input mono" placeholder="0" :disabled="busy" />
            </label>
          </div>
        </div>
      </div>
      <template v-if="draft.response.kind === 'http' && !noBody">
        <label class="field">
          <span>响应类型</span>
          <input v-model="draft.response.contentType" class="input mono" placeholder="application/json" :disabled="busy" />
        </label>
        <div class="button-row compact">
          <button v-if="baseJson" type="button" class="button button-text" :aria-expanded="preserveOpen" :aria-controls="`${id}-preserve`"
            @click="preserveOpen = !preserveOpen">保留结构置空</button>
          <button v-if="entry.sample !== undefined" type="button" class="button button-text" :disabled="busy"
            @click="useSample">使用真实样本</button>
          <button v-if="entry.example" type="button" class="button button-text" :disabled="busy"
            @click="useExample">使用文档示例</button>
          <button v-if="!batch" type="button" class="button button-text"
            :disabled="busy || !pageReady || !observing || sampleBlocked || sampleState?.state === 'waiting'" @click="emit('sample')">
            {{ sampleState?.state === 'waiting' ? '等待真实响应' : '采集响应样本' }}
          </button>
        </div>
        <p v-if="!batch && pageReady && !observing" class="subtle">继续采集后可读取真实响应。</p>
        <p v-else-if="!batch && sampleBlocked" class="subtle">停用覆盖此接口所有操作的规则后可采集真实响应。</p>
        <p v-else-if="!batch && sampleState" class="subtle" role="status">{{ sampleState.message }}</p>
        <div v-if="preserveOpen" :id="`${id}-preserve`" class="condition editor-section">
          <div class="editor-grid">
            <label class="field"><span>列表路径</span><input v-model="listPath" class="input mono" :disabled="busy" /></label>
            <label class="field"><span>总数路径（可选）</span><input v-model="totalPath" class="input mono" :disabled="busy" /></label>
          </div>
          <p v-if="structureError" class="inline-error" role="alert">{{ structureError }}</p>
          <button type="button" class="button button-small" :disabled="busy" @click="preserveStructure">生成空列表</button>
        </div>
        <label class="field">
          <span>响应正文预览</span>
          <textarea v-model="draft.response.body" class="input mono code-editor" rows="5" spellcheck="false" :disabled="busy" />
        </label>
        <label v-if="draft.response.contentType.toLowerCase().includes('json')" class="check-line subtle">
          <input v-model="draft.allowInvalidJson" type="checkbox" class="check" :disabled="busy" />发送无效 JSON
        </label>
      </template>
      <p v-else-if="noBody && draft.response.kind === 'http'" class="subtle">此响应使用空正文。</p>
    </div>

  </div>
</template>
