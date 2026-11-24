import type { BackupPreview } from './backup'

export type LocalDataCommand =
  | { type: 'export-backup' }
  | { type: 'export-rescue'; mode: 'raw' | 'readable' }
  | { type: 'preview-backup'; json: string }
  | { type: 'restore-backup'; json: string; preview: BackupPreview }
  | { type: 'retry-storage' }

export interface LocalDataRequest {
  type: 'local-data'
  command: LocalDataCommand
}

export interface RescueFile {
  json: string
  recovered: number
  skipped: number
}

type LocalResult = { json: string } | RescueFile | BackupPreview | undefined

export type LocalDataResponse = { ok: true; value: LocalResult } | { ok: false; error: string }

export function requestLocalData(command: { type: 'export-backup' }): Promise<{ json: string }>
export function requestLocalData(command: { type: 'export-rescue'; mode: 'raw' | 'readable' }): Promise<RescueFile>
export function requestLocalData(command: Extract<LocalDataCommand, { type: 'preview-backup' | 'restore-backup' }>): Promise<BackupPreview>
export function requestLocalData(command: { type: 'retry-storage' }): Promise<undefined>
export async function requestLocalData(command: LocalDataCommand): Promise<LocalResult> {
  const request: LocalDataRequest = { type: 'local-data', command }
  let result: LocalDataResponse | undefined
  try {
    result = await chrome.runtime.sendMessage(request)
  } catch {
    throw new Error('扩展暂时无法读取本地数据，请重新打开面板后重试。')
  }
  if (!result) throw new Error('扩展没有返回本地数据，请重试。')
  if (!result.ok) throw new Error(result.error)
  return result.value
}
