<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { MAX_BACKUP_BYTES, type BackupPreview } from '../../lib/backup'
import { requestLocalData } from '../../lib/local-data-client'
import { downloadJson } from './download-json'

defineProps<{ storageError?: string; rescueAvailable?: boolean }>()
const expanded = defineModel<boolean>('expanded', { required: true })
const operation = ref<'export' | 'preview' | 'restore' | 'retry' | 'rescue'>()
const error = ref('')
const notice = ref('')
const pending = shallowRef<{ fileName: string; json: string; preview: BackupPreview }>()
const categories = [
  { key: 'plans', label: '测试方案' },
  { key: 'imports', label: '接口目录' },
  { key: 'ignores', label: '忽略规则' },
  { key: 'scenarios', label: '自定义场景' },
] as const
const toAdd = computed(() => categories.reduce((total, { key }) => total + (pending.value?.preview[key].added ?? 0), 0))

async function run(kind: NonNullable<typeof operation.value>, action: () => Promise<void>) {
  if (operation.value) return
  operation.value = kind
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '备份操作未完成，请重试。'
  } finally {
    operation.value = undefined
  }
}

function exportBackup() {
  void run('export', async () => {
    const { json } = await requestLocalData({ type: 'export-backup' })
    downloadJson(json, `APIFaultLab-备份-${new Date().toISOString().slice(0, 10)}.json`)
    notice.value = '下载已发起，请将备份保存在扩展之外。'
  })
}

function exportRescue(mode: 'raw' | 'readable') {
  void run('rescue', async () => {
    const { json, recovered, skipped } = await requestLocalData({ type: 'export-rescue', mode })
    downloadJson(json, mode === 'raw' ? 'APIFaultLab-原始救援数据.json' : 'APIFaultLab-可读取配置.json')
    notice.value = mode === 'raw' ? '已发起原始数据下载，请妥善保管。' :
      `已导出 ${recovered} 项可读取配置，跳过 ${skipped} 项无效或无法识别的内容。`
  })
}

function readBackup(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  void run('preview', async () => {
    pending.value = undefined
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过可读取大小。')
    const json = await file.text()
    const preview = await requestLocalData({ type: 'preview-backup', json })
    pending.value = { fileName: file.name, json, preview }
  })
}

function restoreBackup() {
  const backup = pending.value
  if (!backup || !toAdd.value) return
  void run('restore', async () => {
    const result = await requestLocalData({ type: 'restore-backup', json: backup.json, preview: backup.preview })
    const added = categories.reduce((total, { key }) => total + result[key].added, 0)
    pending.value = undefined
    notice.value = `已恢复 ${added} 项配置。可以到相应页面查看方案和接口。`
  })
}

function refreshPreview() {
  const backup = pending.value
  if (!backup) return
  void run('preview', async () => {
    const preview = await requestLocalData({ type: 'preview-backup', json: backup.json })
    pending.value = { ...backup, preview }
  })
}

function retryStorage() {
  void run('retry', async () => {
    await requestLocalData({ type: 'retry-storage' })
    notice.value = '已重新读取本地数据。'
  })
}
</script>

<template>
  <details class="report-details backup-tools" :open="expanded" @toggle="expanded = ($event.currentTarget as HTMLDetailsElement).open">
    <summary>数据备份</summary>
    <div class="backup-body">
      <p class="subtle">备份包含所有站点的已保存方案、接口目录、忽略规则和自定义场景。分享文件前，请检查保存的响应正文和页面 URL。</p>
      <div v-if="storageError" class="backup-storage-error">
        <p class="inline-error" role="alert">{{ storageError }}</p>
        <button class="button button-small" type="button" :disabled="!!operation" @click="retryStorage">
          {{ operation === 'retry' ? '正在读取…' : '重试读取' }}
        </button>
      </div>
      <div v-if="rescueAvailable" class="backup-body">
        <p class="subtle">先保存原始 JSON，再将可读取配置的备份导入另一个干净的 Chrome 用户配置。</p>
        <p class="subtle">原始文件可能包含敏感数据，请勿直接分享。</p>
        <div class="button-row compact">
          <button type="button" class="button button-small" :disabled="!!operation" @click="exportRescue('raw')">下载原始 JSON</button>
          <button type="button" class="button button-small" :disabled="!!operation" @click="exportRescue('readable')">导出可读取配置</button>
        </div>
      </div>
      <div v-if="!storageError" class="backup-actions">
        <button class="button button-small" type="button" :disabled="!!operation" @click="exportBackup">
          {{ operation === 'export' ? '正在导出…' : '导出 JSON' }}
        </button>
        <label class="field backup-file">
          <span>导入备份或完整方案</span>
          <input class="file-input" type="file" accept=".json,application/json" :disabled="!!operation" @change="readBackup" />
        </label>
      </div>
      <p v-if="operation === 'preview'" class="subtle" role="status">正在检查备份文件…</p>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="subtle" role="status">{{ notice }}</p>
      <div v-if="pending" class="backup-preview">
        <h3 class="file-name">{{ pending.fileName }}</h3>
        <table class="backup-counts" aria-label="恢复预览">
          <thead><tr><th scope="col">配置</th><th scope="col">新增</th><th scope="col">已有</th><th scope="col">冲突</th></tr></thead>
          <tbody>
            <tr v-for="category in categories" :key="category.key">
              <th scope="row">{{ category.label }}</th>
              <td class="mono">{{ pending.preview[category.key].added }}</td>
              <td class="mono">{{ pending.preview[category.key].unchanged }}</td>
              <td class="mono">{{ pending.preview[category.key].conflicts }}</td>
            </tr>
          </tbody>
        </table>
        <p class="subtle">恢复只加入新增项，有冲突时保留本机版本。恢复后可手动启用方案。</p>
        <p v-if="!toAdd" class="subtle">此备份没有可新增的配置。</p>
        <div class="button-row compact">
          <button class="button button-small" type="button" :disabled="!!operation" @click="pending = undefined; error = ''">关闭预览</button>
          <button v-if="error || operation === 'preview'" class="button button-small" type="button" :disabled="!!operation" @click="refreshPreview">重新预览</button>
          <button v-if="toAdd" class="button button-primary button-small" type="button" :disabled="!!operation || !!storageError" @click="restoreBackup">
            {{ operation === 'restore' ? '正在恢复…' : `恢复 ${toAdd} 项配置` }}
          </button>
        </div>
      </div>
    </div>
  </details>
</template>
