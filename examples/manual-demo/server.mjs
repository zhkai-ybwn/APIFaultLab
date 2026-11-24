import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const host = '127.0.0.1'
const port = Number(process.env.APIFAULTLAB_DEMO_PORT ?? 4173)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('演示端口无效。')

const page = await readFile(new URL('./index.html', import.meta.url))
const operations = new Map([
  ['StartupProbe', { data: { ready: true } }],
  ['StartupProbeXhr', { data: { ready: true } }],
  ['ListOrders', { data: [{ id: 'DEMO-001', status: '已完成' }] }],
  ['ListCustomers', { data: [{ id: 'DEMO-C01', name: '演示客户' }] }],
  ['GetVersion', { version: 'manual-demo' }],
])
const counts = new Map([...operations.keys()].map(name => [name, 0]))
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j158AAAAASUVORK5CYII=', 'base64')

function reply(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body)
}

async function handle(request, response) {
  const path = request.url?.split('?')[0]
  if (request.method === 'GET' && (path === '/' || path === '/orders')) {
    return reply(response, 200, page, 'text/html; charset=utf-8')
  }
  if (request.method === 'GET' && path === '/__counts') {
    return reply(response, 200, Object.fromEntries(counts))
  }
  if (request.method === 'GET' && /^\/tiles\/5\/0\/\d+\.png$/.test(path ?? '')) {
    return reply(response, 200, tile, 'image/png')
  }
  if (request.method !== 'POST' || path !== '/api/query') {
    return reply(response, 404, { message: '接口不存在' })
  }

  let text = ''
  let tooLarge = false
  request.setEncoding('utf8')
  for await (const chunk of request) {
    if (tooLarge || text.length + chunk.length > 4096) tooLarge = true
    else text += chunk
  }
  if (tooLarge) return reply(response, 413, { message: '请求正文过大' })
  let operation
  try { operation = JSON.parse(text)?.operationName } catch {
    return reply(response, 400, { message: '请求正文须为 JSON' })
  }
  const result = operations.get(operation)
  if (!result) return reply(response, 400, { message: '未知操作' })
  counts.set(operation, counts.get(operation) + 1)
  return reply(response, 200, { operationName: operation, ...result })
}

const server = createServer((request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) reply(response, 500, { message: '演示服务处理失败' })
    else response.end()
  })
})
server.listen(port, host, () => {
  process.stdout.write('APIFaultLab 本地验收页 http://' + host + ':' + server.address().port + '/orders\n')
})
