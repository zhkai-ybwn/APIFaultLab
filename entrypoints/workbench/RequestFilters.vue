<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CatalogEntry, IgnoreRule } from '../../lib/model'
import { ignoreKey, ignoreLabel, matchesIgnore, parseIgnorePrefix, type RequestFilter } from '../../lib/request-filters'

const props = defineProps<{
  filter: RequestFilter
  entries: CatalogEntry[]
  ignores: IgnoreRule[]
  activeKeys: string[]
  busy: boolean
}>()

const emit = defineEmits<{
  filter: [value: RequestFilter]
  add: [rules: IgnoreRule[]]
  remove: [keys: string[]]
}>()

const filters: { value: RequestFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'api', label: '业务' },
  { value: 'static', label: '静态' },
  { value: 'map', label: '地图' },
  { value: 'active', label: '有规则' },
  { value: 'ignored', label: '已忽略' },
]

const expanded = ref(false)
const prefixText = ref('')
const awaiting = ref<string[]>([])
const settingsButton = ref<HTMLButtonElement>()
const prefixInput = ref<HTMLTextAreaElement>()
const existingKeys = computed(() => new Set(props.ignores.map(ignoreKey)))
const ignoredCount = computed(() => props.entries.filter(entry =>
  props.ignores.some(rule => matchesIgnore(rule, entry.endpoint))).length)
const activeSet = computed(() => new Set(props.activeKeys))
const preview = computed(() => {
  const rules = new Map<string, IgnoreRule>()
  let lineIndex = 0
  for (const line of prefixText.value.split(/\r?\n/)) {
    lineIndex += 1
    if (!line.trim()) continue
    try {
      const rule = parseIgnorePrefix(line)
      const key = ignoreKey(rule)
      if (!existingKeys.value.has(key)) rules.set(key, rule)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '前缀无效'
      return { rules: [], error: `第 ${lineIndex} 行：${message}`, count: 0 }
    }
  }
  const newRules = Array.from(rules.values())
  const count = props.entries.filter(entry => !props.ignores.some(rule => matchesIgnore(rule, entry.endpoint)) &&
    newRules.some(rule => matchesIgnore(rule, entry.endpoint))).length
  return { rules: newRules, error: '', count }
})

watch(existingKeys, keys => {
  if (!awaiting.value.length || !awaiting.value.every(key => keys.has(key))) return
  awaiting.value = []
  prefixText.value = ''
})

function selectFilter(filter: RequestFilter) {
  emit('filter', filter)
}

function toggleSettings() {
  expanded.value = !expanded.value
  if (expanded.value) void nextTick(() => prefixInput.value?.focus())
}

function closeSettings() {
  expanded.value = false
  void nextTick(() => settingsButton.value?.focus())
}

function addPrefixes() {
  if (props.busy || !preview.value.rules.length) return
  awaiting.value = preview.value.rules.map(ignoreKey)
  emit('add', preview.value.rules)
}
</script>

<template>
  <div class="request-filters">
    <div class="filter-line">
      <div class="filter-options" role="group" aria-label="请求分类">
        <button v-for="option in filters" :key="option.value" type="button" class="filter-option"
          :aria-pressed="filter === option.value" @click="selectFilter(option.value)">
          {{ option.label }}<span v-if="option.value === 'active' && activeSet.size" class="filter-number">{{ activeSet.size }}</span><span
            v-if="option.value === 'ignored' && ignoredCount" class="filter-number">{{ ignoredCount }}</span>
        </button>
      </div>
      <button ref="settingsButton" type="button" class="button button-text filter-settings"
        :aria-expanded="expanded" aria-controls="ignore-settings" @click="toggleSettings">忽略规则</button>
    </div>

    <section v-if="expanded" id="ignore-settings" class="ignore-settings" aria-label="站点忽略规则" @keydown.esc.stop="closeSettings">
      <form class="prefix-form" @submit.prevent="addPrefixes">
        <label class="field" for="ignore-prefixes"><span>本网站忽略前缀</span></label>
        <textarea id="ignore-prefixes" ref="prefixInput" v-model="prefixText" rows="2" class="input mono"
          placeholder="/assets/&#10;/styles/" :disabled="busy" aria-describedby="ignore-prefix-help"
          :aria-invalid="preview.error ? 'true' : undefined" />
        <p id="ignore-prefix-help" class="subtle">一行一个前缀。填写完整接口地址可限定来源。</p>
        <p v-if="preview.error" class="inline-error" role="alert">{{ preview.error }}</p>
        <div class="prefix-actions">
          <p v-if="preview.rules.length" class="subtle" aria-live="polite">当前列表将少显示 {{ preview.count }} 项</p>
          <p v-else-if="prefixText.trim() && !preview.error" class="subtle">这些前缀已保存</p>
          <button type="submit" class="button button-small" :disabled="busy || !preview.rules.length">添加前缀</button>
        </div>
      </form>

      <div v-if="ignores.length" class="ignore-list">
        <ul aria-label="已保存的忽略规则">
          <li v-for="rule in ignores" :key="ignoreKey(rule)" class="ignore-entry">
            <div class="ignore-name">
              <span class="subtle">{{ rule.kind === 'prefix' ? '前缀' : '接口' }}</span>
              <code class="mono" :title="ignoreLabel(rule)">{{ ignoreLabel(rule) }}</code>
            </div>
            <button type="button" class="button button-text button-small" :aria-label="`取消忽略 ${ignoreLabel(rule)}`"
              :disabled="busy" @click="emit('remove', [ignoreKey(rule)])">取消忽略</button>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.request-filters { flex: none; min-width: 0; padding: 0 var(--workbench-gutter) .5rem; }
.filter-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .125rem .5rem; }
.filter-options { display: flex; flex-wrap: wrap; align-items: center; gap: .1875rem; min-width: 0; }
.filter-option {
  display: inline-flex; align-items: center; justify-content: center; gap: .25rem;
  min-height: 1.5625rem; padding: .1875rem .4375rem; border: 1px solid transparent;
  border-radius: .375rem; background: transparent; color: var(--text-secondary);
  font-size: .6875rem; line-height: 1.3; white-space: nowrap;
}
.filter-option:hover { background: var(--surface-hover); color: var(--text); }
.filter-option[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.filter-option:active { background: var(--surface-active); }
.filter-number { font-variant-numeric: tabular-nums; opacity: .78; }
.filter-settings { min-height: 1.5625rem; font-size: .6875rem; white-space: nowrap; }
.filter-settings[aria-expanded="true"] { color: var(--accent); }
.ignore-settings {
  max-height: min(16rem, 42dvh); overflow: auto; margin-top: .375rem; border: 1px solid var(--line);
  border-radius: .4375rem; background: var(--surface-raised); overscroll-behavior: contain;
}
.prefix-form { display: grid; gap: .375rem; padding: .5rem .625rem; }
.prefix-form :is(textarea, p) { margin: 0; }
.prefix-form textarea { resize: vertical; min-height: 2.625rem; }
.prefix-actions { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.prefix-actions button { margin-inline-start: auto; flex: none; }
.ignore-list { padding: 0 .625rem; border-top: 1px solid var(--line); }
.ignore-entry { display: flex; align-items: center; justify-content: space-between; gap: .375rem; padding: .1875rem 0; }
.ignore-entry + .ignore-entry { border-top: 1px solid var(--line); }
.ignore-name { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .375rem; align-items: baseline; min-width: 0; }
.ignore-name code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .6875rem; }
.ignore-entry button { flex: none; }
</style>
