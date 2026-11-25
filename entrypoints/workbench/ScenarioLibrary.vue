<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CustomScenario } from '../../lib/model'
import { normalizeCustomScenario, presetResponse, sameScenarioResponse, validateScenarioResponse, type ScenarioSeed } from '../../lib/scenarios'
import { compileDraftHeaders, draftHeaders, newResponseHeader, type DraftHeader } from './editor'

const props = defineProps<{
  scenarios: CustomScenario[]
  busy: boolean
  seed?: ScenarioSeed
}>()

const emit = defineEmits<{ save: [scenario: CustomScenario]; delete: [id: string]; close: [] }>()
const draft = ref<CustomScenario | null>(null)
const headerRows = ref<DraftHeader[]>([])
const pending = ref<CustomScenario | null>(null)
const deleteId = ref<string | null>(null)
const editorName = ref<HTMLInputElement | null>(null)
const addButton = ref<HTMLButtonElement | null>(null)
const responseDetails = ref<HTMLDetailsElement | null>(null)
const error = ref('')
const editing = computed(() => props.scenarios.some(scenario => scenario.id === draft.value?.id))
const hasBody = computed(() => draft.value?.response.kind === 'http' && ![204, 205].includes(draft.value.response.status))
const preview = computed(() => {
  if (!draft.value) return null
  try {
    const headers = draft.value.response.kind === 'http' ? compileDraftHeaders(headerRows.value) : undefined
    return validateScenarioResponse({ ...draft.value.response, ...(headers ? { headers } : { headers: undefined }) }, draft.value.allowInvalidJson === true)
  } catch {
    return null
  }
})

function clearDraft() {
  draft.value = null
  headerRows.value = []
  pending.value = null
  error.value = ''
}

function openDraft(source?: CustomScenario | ScenarioSeed) {
  const baseResponse = source?.response ?? presetResponse('500')
  draft.value = {
    id: source && 'id' in source ? source.id : crypto.randomUUID(),
    name: source && 'name' in source ? source.name : '',
    response: { ...baseResponse, ...(baseResponse.headers ? { headers: { ...baseResponse.headers } } : {}) },
    allowInvalidJson: source?.allowInvalidJson ?? false,
  }
  headerRows.value = draftHeaders(baseResponse.headers)
  pending.value = null
  deleteId.value = null
  error.value = ''
  void nextTick(() => editorName.value?.focus())
}

function save() {
  if (!draft.value) return
  error.value = ''
  try {
    const headers = draft.value.response.kind === 'http' ? compileDraftHeaders(headerRows.value) : undefined
    const scenario = normalizeCustomScenario({
      ...draft.value,
      response: { ...draft.value.response, ...(headers ? { headers } : { headers: undefined }) },
    })
    pending.value = scenario
    emit('save', scenario)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法保存自定义场景'
    if (!preview.value && responseDetails.value) responseDetails.value.open = true
  }
}

function cancelDraft() {
  clearDraft()
  void nextTick(() => addButton.value?.focus())
}

function editRetry(event: Event) {
  if (!draft.value) return
  const input = event.target as HTMLInputElement
  draft.value.response.retryAfterSeconds = input.value ? input.valueAsNumber : undefined
}

function remove(id: string) {
  emit('delete', id)
}

watch(() => props.seed, (seed) => {
  if (seed) openDraft(seed)
}, { immediate: true })

watch(() => props.scenarios, (items) => {
  if (deleteId.value && !items.some(scenario => scenario.id === deleteId.value)) {
    if (draft.value?.id === deleteId.value) clearDraft()
    deleteId.value = null
    void nextTick(() => addButton.value?.focus())
  }
  const submitted = pending.value
  if (submitted && items.some(scenario => scenario.id === submitted.id && scenario.name === submitted.name &&
      Boolean(scenario.allowInvalidJson) === Boolean(submitted.allowInvalidJson) &&
      sameScenarioResponse(scenario.response, submitted.response))) cancelDraft()
})
</script>

<template>
  <section class="drawer scenario-library" aria-label="自定义场景">
    <div class="button-row scenario-library-actions">
      <button ref="addButton" type="button" class="button button-small" :disabled="busy" @click="openDraft()">添加场景</button>
      <button type="button" class="button button-small button-text" :disabled="busy" @click="emit('close')">关闭</button>
    </div>
    <p v-if="!draft" class="subtle">保存后，可在规则编辑器的「更多场景」中选用。</p>

    <form v-if="draft" class="plan-form scenario-form" novalidate @submit.prevent="save">
      <h3>{{ editing ? '编辑自定义场景' : '新建自定义场景' }}</h3>
      <label class="field">
        <span>场景名称</span>
        <input ref="editorName" v-model="draft.name" class="input" maxlength="48" placeholder="例如 设备离线" :disabled="busy" required />
      </label>
      <label class="check-line subtle">
        <input type="checkbox" class="check" :checked="draft.response.kind === 'network'" :disabled="busy"
          @change="draft.response.kind = ($event.target as HTMLInputElement).checked ? 'network' : 'http'" />
        模拟网络错误
      </label>
      <label v-if="draft.response.kind === 'http'" class="field">
        <span>HTTP 状态码</span>
        <input v-model.number="draft.response.status" type="number" min="200" max="599" step="1" class="input mono" :disabled="busy" required />
      </label>
      <details :key="draft.id" ref="responseDetails" class="report-details" open>
        <summary>
          {{ hasBody ? '响应正文、延迟等设置' : '响应延迟等设置' }}
          <span v-if="preview?.delayMs"> · 延迟 {{ preview.delayMs }} 毫秒</span>
        </summary>
        <div class="editor-section">
          <label v-if="hasBody" class="field">
            <span>响应正文</span>
            <textarea v-model="draft.response.body" class="input mono code-editor" rows="5" spellcheck="false" :disabled="busy" />
          </label>
          <div class="editor-grid">
            <label class="field">
              <span>延迟（毫秒）</span>
              <input v-model.number="draft.response.delayMs" type="number" min="0" max="60000" step="1" class="input mono" :disabled="busy" required />
            </label>
            <label v-if="draft.response.kind === 'http' && ([429, 503].includes(draft.response.status) || draft.response.retryAfterSeconds !== undefined)" class="field">
              <span>Retry-After（秒）</span>
              <input :value="draft.response.retryAfterSeconds ?? ''" type="number" min="0" step="1" class="input mono" :disabled="busy" @input="editRetry" />
            </label>
          </div>
          <label v-if="hasBody" class="field">
            <span>响应类型</span>
            <input v-model="draft.response.contentType" class="input mono" placeholder="application/json" :disabled="busy" />
          </label>
          <label v-if="hasBody && draft.response.contentType.toLowerCase().includes('json')" class="check-line subtle">
            <input v-model="draft.allowInvalidJson" type="checkbox" class="check" :disabled="busy" />发送无效 JSON
          </label>
          <div v-if="draft.response.kind === 'http'" class="editor-section">
            <div class="condition-top">
              <span class="field-label">自定义响应头（可选）</span>
              <button type="button" class="button button-text" :disabled="busy || headerRows.length >= 20"
                @click="headerRows.push(newResponseHeader())">添加响应头</button>
            </div>
            <div v-for="(header, index) in headerRows" :key="header.id" class="condition">
              <div class="condition-top">
                <span class="subtle">响应头 {{ index + 1 }}</span>
                <button type="button" class="button button-text button-danger" :disabled="busy" :aria-label="`移除响应头 ${index + 1}`"
                  @click="headerRows.splice(index, 1)">移除</button>
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
        </div>
      </details>
      <details v-if="preview" :key="`preview-${draft.id}`" class="report-details" open>
        <summary>
          响应预览
          <span class="mono">{{ preview.kind === 'network' ? '网络错误' : `HTTP ${preview.status}` }}</span>
          <span v-if="preview.delayMs"> · {{ preview.delayMs }} 毫秒</span>
        </summary>
        <dl v-if="preview.kind === 'http'" class="plan-notes">
          <template v-if="preview.contentType"><dt>Content-Type</dt><dd class="mono">{{ preview.contentType }}</dd></template>
          <template v-if="preview.retryAfterSeconds !== undefined"><dt>Retry-After</dt><dd class="mono">{{ preview.retryAfterSeconds }}</dd></template>
          <template v-for="(value, name) in preview.headers" :key="name"><dt class="mono">{{ name }}</dt><dd class="mono">{{ value }}</dd></template>
        </dl>
        <pre v-if="preview.body" class="response-preview mono">{{ preview.body }}</pre>
        <p v-else-if="preview.kind === 'http'" class="subtle">无响应正文</p>
      </details>

      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <div class="button-row editor-footer">
        <button type="button" class="button" :disabled="busy" @click="cancelDraft">取消</button>
        <button type="submit" class="button button-primary" :disabled="busy">保存场景</button>
      </div>
    </form>

    <ul v-if="scenarios.length" class="plan-list">
      <li v-for="scenario in scenarios" :key="scenario.id" class="scene-row">
        <div class="plan-item">
          <span class="scene-name">{{ scenario.name }}</span>
          <span class="mono subtle">{{ scenario.response.kind === 'network' ? '网络错误' : `HTTP ${scenario.response.status}` }}</span>
        </div>
        <div v-if="deleteId === scenario.id" class="button-row compact scene-actions">
          <button type="button" class="button button-small" :disabled="busy" @click="deleteId = null">取消</button>
          <button type="button" class="button button-small button-danger" :disabled="busy" @click="remove(scenario.id)">删除场景</button>
        </div>
        <div v-else class="button-row compact scene-actions">
          <button type="button" class="button button-small button-text" :disabled="busy" :aria-label="`编辑 ${scenario.name}`" @click="openDraft(scenario)">编辑</button>
          <button type="button" class="button button-small button-text button-danger" :disabled="busy" :aria-label="`删除 ${scenario.name}`" @click="deleteId = scenario.id">删除</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.scenario-library-actions { justify-content: space-between; }
.scenario-form h3 { font-size: .8125rem; font-weight: 650; }
.scene-row { display: grid; gap: .125rem; }
.scene-name { min-width: 0; overflow-wrap: anywhere; font-weight: 620; }
.scene-row .plan-item > :last-child { flex: none; }
.scene-actions { justify-content: flex-end; }
.scenario-form .plan-notes + .response-preview { margin-top: .375rem; }
</style>
