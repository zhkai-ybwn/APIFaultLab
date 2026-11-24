import { parseApiDocument, type ImportOptions } from '../../lib/openapi'

self.addEventListener('message', (event: MessageEvent<{ text: string; options: ImportOptions }>) => {
  try {
    self.postMessage(parseApiDocument(event.data.text, event.data.options))
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : '无法读取接口文档' })
  }
})
