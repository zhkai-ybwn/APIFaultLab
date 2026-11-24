<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SavedPlan } from '../../lib/model'
import { exportPlanShare } from '../../lib/backup'
import { downloadJson } from './download-json'

const props = defineProps<{ plan: SavedPlan }>()
const emit = defineEmits<{ close: [] }>()
const full = ref(false)
const exported = ref(false)
const summary = computed(() => exportPlanShare(props.plan))

function saveFile() {
  downloadJson(full.value ? exportPlanShare(props.plan, true) : summary.value,
    full.value ? 'APIFaultLab-方案.json' : 'APIFaultLab-方案摘要.json')
  exported.value = true
}
</script>

<template>
  <section class="plan-form" aria-label="分享方案">
    <h2>分享方案</h2>
    <p class="subtle">摘要只包含方法、响应状态和延迟。</p>
    <label class="check-line">
      <input v-model="full" type="checkbox" class="check" @change="exported = false" />
      包含可导入的完整方案
    </label>
    <template v-if="full">
      <p class="subtle scope-copy">页面范围 {{ plan.routeKey }}</p>
      <p class="subtle">完整文件包含方案名称、说明、页面 URL、接口路径、匹配条件及响应正文。分享前请在方案预览里检查这些字段。</p>
    </template>
    <pre v-else class="response-preview mono" aria-label="方案摘要预览">{{ summary }}</pre>
    <div class="button-row editor-footer">
      <button type="button" class="button" @click="emit('close')">返回预览</button>
      <button type="button" class="button button-primary" @click="saveFile">{{ full ? '下载完整方案' : '下载摘要' }}</button>
    </div>
    <p v-if="exported" class="subtle" role="status">已发起下载。</p>
  </section>
</template>
