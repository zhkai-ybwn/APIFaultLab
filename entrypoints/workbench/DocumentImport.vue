<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { MAX_IMPORT_BYTES } from '../../lib/catalog'
import type { ApiImportPreview, CatalogEntry } from '../../lib/model'
import { mapImportedOperations } from '../../lib/openapi'

const props = defineProps<{ siteOrigin: string; routeKey: string; busy: boolean; importedEntries: CatalogEntry[] }>()
const emit = defineEmits<{
  import: [entries: CatalogEntry[], mode?: 'replace', expectedKeys?: string[]]
  delete: [keys: string[]]
}>()
const preview = shallowRef<ApiImportPreview>()
const chosen = ref<string[]>([])
const removeKeys = ref<string[]>([])
const confirmRemoval = ref(false)
const replace = ref(false)
const includeExamples = ref(false)
const baseUrl = ref('')
const fileName = ref('')
const loading = ref(false)
const error = ref('')
const filter = ref('')
const directoryFilter = ref('')
let disposed = false
let fileText = ''
let worker: Worker | undefined
let parseTimer: ReturnType<typeof setTimeout> | undefined
const list = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  return preview.value?.operations.filter(operation =>
    (operation.method + ' ' + operation.path + ' ' + operation.title).toLowerCase().includes(keyword),
  ) ?? []
})
const importedKeys = computed(() => props.importedEntries.map(entry => entry.key))
const managementEntries = computed(() => {
  const keyword = directoryFilter.value.trim().toLowerCase()
  return props.importedEntries.filter(entry =>
    (entry.endpoint.method + ' ' + entry.endpoint.path + ' ' + (entry.title ?? '')).toLowerCase().includes(keyword))
})
const mapped = computed(() => {
  if (!preview.value || !chosen.value.length) return { entries: [] }
  try {
    const selected = new Set(chosen.value)
    const operations = preview.value.operations.filter(operation => selected.has(operation.id))
    return { entries: mapImportedOperations(operations, baseUrl.value.trim() || undefined, props.siteOrigin) }
  } catch (cause) {
    return { entries: [], error: cause instanceof Error ? cause.message : '无法映射接口地址' }
  }
})
const importImpact = computed(() => {
  const existingKeys = new Set(importedKeys.value)
  const freshKeys = new Set(mapped.value.entries.map(entry => entry.key))
  return {
    add: [...freshKeys].filter(key => !existingKeys.has(key)).length,
    update: [...freshKeys].filter(key => existingKeys.has(key)).length,
    remove: replace.value ? [...existingKeys].filter(key => !freshKeys.has(key)).length : 0,
  }
})

watch(importedKeys, (keys, previous) => {
  const valid = new Set(keys)
  removeKeys.value = removeKeys.value.filter(key => valid.has(key))
  if (!removeKeys.value.length) confirmRemoval.value = false
  if (keys.length !== previous.length || previous.some(key => !valid.has(key))) {
    confirmRemoval.value = false
    replace.value = false
  }
})

function stopWorker() {
  clearTimeout(parseTimer)
  worker?.terminate()
  worker = undefined
}

onUnmounted(() => {
  disposed = true
  stopWorker()
})

function processFile(selectAll = false) {
  stopWorker()
  loading.value = true
  error.value = ''
  const onError = (message: string) => {
    stopWorker()
    loading.value = false
    preview.value = undefined
    error.value = message
  }
  try {
    const parser = new Worker(new URL('./document-import.worker.ts', import.meta.url), { type: 'module' })
    worker = parser
    parseTimer = setTimeout(() => onError('文档解析超时，请拆分文档后重试'), 15_000)
    parser.onmessage = (event: MessageEvent<ApiImportPreview | { error: string }>) => {
      if (worker !== parser) return
      stopWorker()
      loading.value = false
      if ('error' in event.data) {
        preview.value = undefined
        error.value = event.data.error
      } else {
        preview.value = event.data
        const valid = new Set(event.data.operations.map(operation => operation.id))
        chosen.value = selectAll ? [...valid] : chosen.value.filter(id => valid.has(id))
      }
    }
    parser.onerror = () => { if (worker === parser) onError('无法读取接口文档') }
    parser.postMessage({ text: fileText, options: { includeExamples: includeExamples.value, expectedRoute: props.routeKey } })
  } catch {
    onError('无法启动文档解析')
  }
}

async function readFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  preview.value = undefined
  chosen.value = []
  includeExamples.value = false
  replace.value = false
  baseUrl.value = ''
  filter.value = ''
  error.value = ''
  fileText = ''
  if (file.size > MAX_IMPORT_BYTES) {
    error.value = '文件超过 8 MiB，请拆分后再导入'
    return
  }
  try {
    loading.value = true
    fileText = await file.text()
    if (disposed) return
    fileName.value = file.name
    processFile(true)
  } catch {
    loading.value = false
    error.value = '无法读取接口文档'
  }
}

function selectVisible() {
  chosen.value = [...new Set([...chosen.value, ...list.value.map(operation => operation.id)])]
}

function submit() {
  if (!mapped.value.entries.length || loading.value || props.busy) return
  emit('import', mapped.value.entries, replace.value ? 'replace' : undefined, replace.value ? importedKeys.value : undefined)
}

function deleteSelected() {
  if (confirmRemoval.value) emit('delete', [...removeKeys.value])
  confirmRemoval.value = false
}
</script>

<template>
  <form class="drawer" aria-label="导入和管理接口目录" @submit.prevent>
    <details v-if="importedEntries.length" class="report-details">
      <summary>已导入目录 · {{ importedEntries.length }} 个接口</summary>
      <p class="subtle">仅管理当前页面的导入记录。观察记录、模拟规则和已保存方案独立保留。</p>
      <label class="field">
        <span>查找接口</span>
        <input v-model="directoryFilter" class="input" type="search" placeholder="路径、名称或方法" />
      </label>
      <ul class="document-operations imported-directory">
        <li v-for="entry in managementEntries" :key="entry.key">
          <label class="import-operation">
            <input v-model="removeKeys" class="check" type="checkbox" :value="entry.key" :disabled="busy" @change="confirmRemoval = false" />
            <span class="method mono" :data-method="entry.endpoint.method">{{ entry.endpoint.method }}</span>
            <span class="import-operation-info">
              <span class="mono">{{ entry.endpoint.path }}</span>
              <span class="subtle">{{ entry.endpoint.origin }}<template v-if="entry.operations?.length"> · {{ entry.operations.length }} 个操作</template></span>
            </span>
          </label>
        </li>
      </ul>
      <p v-if="!managementEntries.length" class="subtle">没有匹配的目录接口</p>
      <div class="button-row compact">
        <button class="button button-text button-danger" type="button" :disabled="busy || !removeKeys.length" @click="confirmRemoval ? deleteSelected() : confirmRemoval = true">
          {{ confirmRemoval ? `确认移除 ${removeKeys.length} 个接口` : '移除所选' }}
        </button>
        <button v-if="confirmRemoval" class="button button-text" type="button" @click="confirmRemoval = false">取消</button>
      </div>
    </details>

    <label class="field">
      <span>选择 OpenAPI、Swagger 或 APIFaultLab 目录</span>
      <input class="file-input" type="file" accept=".json,.yaml,.yml,application/json,application/yaml"
        :disabled="loading || busy" @change="readFile" />
    </label>
    <p v-if="loading" class="subtle" role="status">正在读取文档</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>

    <template v-if="preview">
      <div class="import-preview-actions">
        <div class="import-preview-summary">
          <p class="subtle file-name">{{ fileName }}</p>
          <p class="subtle" aria-live="polite">
            已选 {{ chosen.length }} / {{ preview.operations.length }} 个操作<template v-if="mapped.entries.length">
              · {{ importImpact.add }} 个新增 · {{ importImpact.update }} 个更新<template v-if="replace"> · {{ importImpact.remove }} 个移除</template>
            </template>
          </p>
        </div>
        <button class="button button-primary" type="button" :disabled="busy || loading || !mapped.entries.length" @click="submit">
          {{ replace ? '替换当前目录' : '加入当前页面' }}
        </button>
      </div>
      <label v-if="importedEntries.length" class="check-line subtle">
        <input v-model="replace" class="check" type="checkbox" :disabled="busy || loading" />替换当前页面的全部导入目录
      </label>
      <p v-if="mapped.error" class="inline-error" role="alert">{{ mapped.error }}</p>
      <template v-if="!preview.catalogPage">
        <label class="field">
          <span>覆盖 API 地址和路径前缀（可选）</span>
          <input v-model="baseUrl" class="input mono" type="url" :placeholder="/^https?:\/\//.test(preview.suggestedBaseUrl) ? preview.suggestedBaseUrl : siteOrigin || 'https://example.test/api'" :disabled="busy" />
        </label>
        <label class="check-line subtle">
          <input v-model="includeExamples" class="check" type="checkbox" :disabled="loading || busy" @change="processFile()" />
          同时导入响应示例
        </label>
        <p v-if="includeExamples" class="subtle">示例会保存在本机，可能包含业务数据。请先检查原文档。</p>
      </template>
      <p v-else class="subtle scope-copy">目录页面 · <span class="mono">{{ preview.catalogPage }}</span></p>
      <details v-if="preview.warnings.length" class="report-details">
        <summary>{{ preview.warnings.length }} 条导入提示</summary>
        <ul><li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li></ul>
      </details>
      <label v-if="preview.operations.length > 8" class="field">
        <span>筛选文档操作</span>
        <input v-model="filter" class="input" type="search" placeholder="路径、名称或方法" :disabled="busy" />
      </label>
      <div class="button-row compact">
        <button class="button button-text" type="button" :disabled="!list.length || busy || loading" @click="selectVisible">选择可见操作</button>
        <button v-if="chosen.length" class="button button-text" type="button" :disabled="busy || loading" @click="chosen = []">清空选择</button>
      </div>
      <ul class="document-operations">
        <li v-for="operation in list" :key="operation.id">
          <label class="import-operation">
            <input v-model="chosen" class="check" type="checkbox" :value="operation.id" :disabled="busy || loading" />
            <span class="method mono" :data-method="operation.method">{{ operation.method }}</span>
            <span class="import-operation-info">
              <span class="mono">{{ operation.path }}</span>
              <span v-if="operation.title && operation.title !== operation.path" class="subtle">{{ operation.title }}</span>
              <span v-if="!baseUrl && operation.serverUrl" class="subtle mono">{{ operation.serverUrl }}</span>
            </span>
          </label>
        </li>
      </ul>
      <p v-if="!list.length" class="subtle">没有匹配的文档操作</p>
    </template>
  </form>
</template>
<style scoped>
.imported-directory { padding-inline-start: 0; list-style: none; }
.import-preview-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .4375rem .75rem; }
.import-preview-summary { flex: 1 1 10rem; min-width: 0; }
</style>
