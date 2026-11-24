<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import type { CustomScenario } from '../../lib/model'
import { commonPresets, scenarioGroups, type ScenarioChoice } from '../../lib/scenarios'

withDefaults(defineProps<{
  scenarios?: CustomScenario[]
  busy: boolean
  selected?: string
}>(), { scenarios: () => [] })

const emit = defineEmits<{ choose: [choice: ScenarioChoice]; manage: [] }>()
const open = ref(false)
const panelId = useId()
const trigger = ref<HTMLButtonElement | null>(null)

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function choose(choice: ScenarioChoice, fromList = false) {
  close(fromList)
  emit('choose', choice)
}

function manage() {
  close()
  emit('manage')
}
</script>

<template>
  <div class="scenario-picker">
    <div class="presets" role="group" aria-label="常用场景">
      <button v-for="preset in commonPresets" :key="preset.value" type="button" class="button button-small button-chip"
        :disabled="busy" :aria-pressed="selected === `builtin:${preset.value}`"
        @click="choose({ kind: 'builtin', preset: preset.value })">
        {{ preset.label }}
      </button>
      <button ref="trigger" type="button" class="button button-small scenario-more" :disabled="busy"
        :aria-expanded="open" :aria-controls="panelId" @click="open = !open">
        {{ open ? '收起场景' : '更多场景' }}
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
          <path :d="open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'" />
        </svg>
      </button>
    </div>

    <div v-if="open" :id="panelId" class="scenario-panel" @keydown.esc.stop.prevent="close(true)">
      <div class="scenario-groups">
        <section v-for="group in scenarioGroups" :key="group.name" :aria-label="group.name" class="scenario-group">
          <h3>{{ group.name }}</h3>
          <button v-for="option in group.options" :key="option.value" type="button" class="button scenario-choice"
            :disabled="busy" :aria-pressed="selected === `builtin:${option.value}`"
            @click="choose({ kind: 'builtin', preset: option.value }, true)">
            <span v-if="option.code" class="scenario-code mono">{{ option.code }}</span>
            <span class="scenario-description">
              <span>{{ option.label }}</span>
              <small v-if="option.description">{{ option.description }}</small>
            </span>
          </button>
        </section>
        <section v-if="scenarios.length" class="scenario-group" aria-label="自定义场景">
          <h3>自定义场景</h3>
          <button v-for="scenario in scenarios" :key="scenario.id" type="button" class="button scenario-choice"
            :disabled="busy" :aria-pressed="selected === `custom:${scenario.id}`"
            @click="choose({ kind: 'custom', scenario }, true)">
            <span v-if="scenario.response.kind === 'http'" class="scenario-code mono">{{ scenario.response.status }}</span>
            <span class="scenario-description">
              <span>{{ scenario.name }}</span>
              <small v-if="scenario.response.kind === 'network' || scenario.response.delayMs">
                {{ scenario.response.kind === 'network' ? '网络错误' : `延迟 ${scenario.response.delayMs} 毫秒` }}
              </small>
            </span>
          </button>
        </section>
      </div>
      <div class="scenario-panel-footer">
        <button type="button" class="button button-small button-text" :disabled="busy" @click="manage">
          {{ scenarios.length ? '管理自定义场景' : '添加自定义场景' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scenario-picker { display: grid; gap: .375rem; min-width: 0; container-type: inline-size; }
.scenario-more { display: inline-flex; align-items: center; gap: .25rem; }
.scenario-more svg { width: .75rem; height: .75rem; }
.scenario-panel { border: 1px solid var(--line); border-radius: .4375rem; background: var(--surface); }
.scenario-groups { display: grid; gap: .5rem; padding: .5rem; }
.scenario-group { display: grid; gap: .125rem; align-content: start; min-width: 0; }
.scenario-group h3 { padding: .25rem .375rem; color: var(--text-muted); font-size: .6875rem; font-weight: 650; }
.scenario-choice {
  display: flex;
  gap: .375rem;
  align-items: baseline;
  justify-content: flex-start;
  min-height: 2rem;
  padding: .25rem .375rem;
  border-color: transparent;
  text-align: left;
  white-space: normal;
  background: transparent;
}
.scenario-choice[aria-pressed='true'] { color: var(--accent); background: var(--accent-soft); }
.scenario-code { flex: none; width: 1.625rem; color: var(--text-secondary); }
.scenario-description { display: grid; min-width: 0; overflow-wrap: anywhere; }
.scenario-description small { color: var(--text-muted); font-size: .6875rem; }
.scenario-panel-footer { padding: .375rem .5rem; border-top: 1px solid var(--line); }

@container (min-width: 26rem) {
  .scenario-groups { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: .625rem; }
}
</style>
