<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { CatalogEntry, CustomScenario } from '../../lib/model'
import { createDraft, type ScenarioSeed } from './editor'
import type { PlanDraft } from './plan-draft'
import RuleEditor from './RuleEditor.vue'

const props = defineProps<{
  draft: PlanDraft
  entries: CatalogEntry[]
  scenarios: CustomScenario[]
  busy: boolean
  canSave: boolean
  versionChanged: boolean
}>()
const emit = defineEmits<{
  save: []
  'save-copy': []
  close: []
  discard: []
  'manage-scenarios': []
  'save-scenario': [seed: ScenarioSeed]
}>()
const selected = ref('')
const nameInput = ref<HTMLInputElement>()
const form = ref<HTMLFormElement>()
const discardConfirm = ref(false)
const choices = computed(() => props.entries.flatMap(entry => {
  const path = `${entry.endpoint.method} ${entry.endpoint.origin}${entry.endpoint.path}`
  const label = entry.title ? `${path} · ${entry.title}` : path
  return [
    { id: JSON.stringify([entry.key, null]), entry, label: entry.operations?.length ? `${path} · 自定义匹配` : label, conditions: undefined },
    ...(entry.operations ?? []).map(operation => ({
      id: JSON.stringify([entry.key, operation.id]), entry, label: `${path} · ${operation.title}`, conditions: operation.conditions,
    })),
  ]
}))
const ready = computed(() => props.canSave && !props.busy && !!props.draft.name.trim() && !!props.draft.rules.length)
const hasNotes = computed(() => [props.draft.setup, props.draft.trigger, props.draft.expectation].some(note => note.trim()))
onMounted(() => nameInput.value?.focus({ preventScroll: true }))

function addRule() {
  const choice = choices.value.find(item => item.id === selected.value)
  if (choice && !props.busy) {
    const draft = createDraft(choice.entry, undefined, choice.conditions)
    props.draft.rules.push({ entry: choice.entry, draft })
    selected.value = ''
    discardConfirm.value = false
    void nextTick(() => {
      const details = form.value?.querySelector<HTMLDetailsElement>(`[data-rule-id="${draft.id}"]`)
      if (details) {
        details.open = true
        details.querySelector('summary')?.focus()
      }
    })
  }
}
</script>

<template>
  <form ref="form" class="plan-form" @submit.prevent="ready && !versionChanged && emit('save')">
    <div class="plan-draft-actions">
      <h2>方案草稿</h2>
      <div class="button-row compact">
        <button type="button" class="button" :disabled="busy" @click="emit('close')">返回并保留</button>
        <button v-if="versionChanged" type="button" class="button button-primary" :disabled="!ready" @click="emit('save-copy')">另存副本</button>
        <button v-else type="submit" class="button button-primary" :disabled="!ready">保存方案</button>
      </div>
    </div>
    <p v-if="versionChanged" class="inline-error" role="status">此方案已有新版本。可将草稿另存为副本。</p>
    <label class="field">
      <span>方案名称</span>
      <input ref="nameInput" v-model="draft.name" class="input" maxlength="80" placeholder="例如 设备统计接口异常" :disabled="busy" required />
    </label>
    <div v-if="entries.length" class="plan-rule-add">
      <label class="field">
        <span>选择要模拟的接口</span>
        <select v-model="selected" class="input" :disabled="busy">
          <option value="">选择接口</option>
          <option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
        </select>
      </label>
      <button type="button" class="button" :disabled="busy || !selected" @click="addRule">添加接口</button>
    </div>
    <p v-else-if="!draft.rules.length" class="subtle">先在网页触发请求，或导入接口后继续编辑此草稿。</p>
    <p v-if="entries.length && !draft.rules.length" class="subtle">填写名称并添加至少一个接口后可保存。</p>
    <details v-for="(row, index) in draft.rules" :key="row.draft.id" :data-rule-id="row.draft.id" class="report-details">
      <summary>
        <span class="mono">{{ row.entry.endpoint.method }} {{ row.entry.endpoint.origin }}{{ row.entry.endpoint.path }}</span>
        · {{ row.draft.response.kind === 'network' ? '网络错误' : `HTTP ${row.draft.response.status}` }}
      </summary>
      <RuleEditor :entry="row.entry" :draft="row.draft" :scenarios="scenarios" :busy="busy" batch
        @manage-scenarios="emit('manage-scenarios')" @save-scenario="emit('save-scenario', $event)" />
      <button class="button button-text button-danger" type="button" :disabled="busy" @click="draft.rules.splice(index, 1)">从草稿移除规则</button>
    </details>
    <details class="report-details">
      <summary>复测备注（选填）<span v-if="hasNotes"> · 已填写</span></summary>
      <div class="editor-section">
        <p class="subtle">复测时可在方案预览中查看这些备注。</p>
        <label class="field">
          <span>测试前准备</span>
          <input v-model="draft.setup" class="input" maxlength="240" placeholder="例如 已登录并打开大屏" :disabled="busy" />
        </label>
        <label class="field">
          <span>怎么操作</span>
          <input v-model="draft.trigger" class="input" maxlength="240" placeholder="例如 刷新页面" :disabled="busy" />
        </label>
        <label class="field">
          <span>预期页面表现</span>
          <input v-model="draft.expectation" class="input" maxlength="240" placeholder="例如 设备统计卡片提示加载失败" :disabled="busy" />
        </label>
      </div>
    </details>
    <div v-if="discardConfirm" class="button-row editor-footer">
      <span class="subtle">放弃此草稿的所有未保存修改？</span>
      <button type="button" class="button" :disabled="busy" @click="discardConfirm = false">继续编辑</button>
      <button type="button" class="button button-text button-danger" :disabled="busy" @click="emit('discard')">放弃修改</button>
    </div>
    <div v-else class="button-row">
      <button type="button" class="button button-text" :disabled="busy" @click="discardConfirm = true">放弃草稿</button>
    </div>
  </form>
</template>

<style scoped>
.plan-draft-actions {
  position: sticky;
  inset-block-start: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: .5rem;
  padding-block: .375rem .5rem;
  border-block-end: 1px solid var(--line);
  background: var(--surface-raised);
}
.plan-rule-add { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; }
.plan-rule-add .field { flex: 1 1 13rem; }
.plan-rule-add select { max-width: 100%; }
</style>
