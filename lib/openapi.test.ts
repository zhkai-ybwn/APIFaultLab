import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MAX_IMPORT_OPERATIONS } from './catalog'
import { mapImportedOperations, parseApiDocument } from './openapi'

describe('local API document import', () => {
  it('imports Swagger POST paths with their base path and response example', () => {
    const preview = parseApiDocument(`swagger: '2.0'
host: api.example.test
schemes: [https]
basePath: /v1
paths:
  /orders:
    post:
      operationId: listOrders
      responses:
        '200':
          examples:
            application/json: {code: 0, data: []}
`, { includeExamples: true })
    const [entry] = mapImportedOperations(preview.operations)
    expect(entry).toMatchObject({
      endpoint: { method: 'POST', origin: 'https://api.example.test', path: '/v1/orders' },
      title: 'listOrders', imported: true, observed: false, realSeen: false,
    })
    expect(JSON.parse(entry?.example?.body ?? '')).toEqual({ code: 0, data: [] })
  })

  it('resolves local schema references, leaves external paths unresolved and supports an explicit server mapping', () => {
    const preview = parseApiDocument(JSON.stringify({
      openapi: '3.1.0',
      servers: [{ url: 'https://production.example.test/v1' }],
      paths: {
        '/orders/{id}': {
          post: {
            servers: [{ url: 'https://api.example.test/v2' }],
            responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
          },
        },
        '/external': { $ref: 'https://example.test/paths.yaml' },
      },
      components: { schemas: { Order: { type: 'object', properties: {
        total: { type: 'integer' }, accessToken: { type: 'string', default: 'secret-example' },
      } } } },
    }), { includeExamples: true })
    expect(preview.operations).toHaveLength(1)
    expect(preview.warnings).toContain('已跳过文件外的引用，其他接口仍可导入')
    expect(mapImportedOperations(preview.operations)[0]?.endpoint).toEqual({
      method: 'POST', origin: 'https://api.example.test', path: '/v2/orders/{id}', template: true,
    })
    const [mapped] = mapImportedOperations(preview.operations, 'http://localhost:3000/proxy')
    expect(mapped?.endpoint.path).toBe('/proxy/orders/{id}')
    expect(JSON.parse(mapped?.example?.body ?? '')).toEqual({ total: 0, accessToken: null })
  })

  it('resolves a relative operation server against the current site when no override was entered', () => {
    const preview = parseApiDocument(JSON.stringify({
      openapi: '3.0.3', servers: [{ url: 'https://production.example.test/v1' }],
      paths: { '/orders': { post: { servers: [{ url: '/api' }], responses: { '200': {} } } } },
    }))
    const [entry] = mapImportedOperations(preview.operations, undefined, 'http://localhost:5173')
    expect(entry?.endpoint).toMatchObject({ method: 'POST', origin: 'http://localhost:5173', path: '/api/orders' })
  })

  it('requires an explicit selection to retain examples and filters recognized secrets', () => {
    const document = JSON.stringify({ openapi: '3.0.3', paths: {
      '/service': { get: { responses: { 200: { content: {
        'application/json': { example: { password: 'keep-out', data: { id: 42 } } },
      } } } } },
      '/text': { get: { responses: { 200: { content: {
        'text/plain': { example: 'Bearer keep-out' },
      } } } } },
    } })
    const original = parseApiDocument(document).operations
    const withExamples = parseApiDocument(document, { includeExamples: true }).operations
    expect(original.map(operation => operation.example)).toEqual([undefined, undefined])
    expect(withExamples.map(operation => operation.example?.body)).toEqual(['{"password":null,"data":{"id":42}}', undefined])
    expect(original.map(operation => operation.contentType)).toEqual(['application/json', 'text/plain'])
  })

  it('bounds both recursive references and wide schema example expansion', () => {
    const ref = (name: string) => ({ $ref: '#/components/schemas/' + name })
    const schemas = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
      'Wide' + index,
      { type: 'object', properties: Object.fromEntries(Array.from({ length: 30 }, (_, branch) => [
        'field' + branch, index === 6 ? { type: 'number' } : ref('Wide' + (index + 1)),
      ])) },
    ]))
    schemas.Loop = { type: 'object', properties: { child: ref('Loop') } }
    const operation = (name: string) => ({ get: { responses: { 200: { content: {
      'application/json': { schema: ref(name) },
    } } } } })
    const preview = parseApiDocument(JSON.stringify({
      openapi: '3.0.3', components: { schemas }, paths: { '/wide': operation('Wide0'), '/loop': operation('Loop') },
    }), { includeExamples: true })
    expect(preview.operations.map(item => item.example?.body)).toEqual([undefined, '{"child":null}'])
    expect(preview.warnings).toHaveLength(2)
  })

  it('uses one operation limit across parsing and mapping', () => {
    const paths = Object.fromEntries(Array.from({ length: MAX_IMPORT_OPERATIONS + 1 }, (_, i) => ['/path' + i, { get: {} }]))
    expect(() => parseApiDocument(JSON.stringify({ openapi: '3.0.3', paths }))).toThrow(/500/)
  })

  it('groups named operations for one endpoint and enforces the catalog page before importing', () => {
    const input = readFileSync(new URL('../skills/apifaultlab-catalog/references/共用请求目录.json', import.meta.url), 'utf8')
    const route = 'http://127.0.0.1:4173/orders'
    const result = parseApiDocument(input, { expectedRoute: route })
    const [entry] = mapImportedOperations(result.operations)
    expect(mapImportedOperations(result.operations)).toHaveLength(1)
    expect(entry?.operations?.map(operation => operation.conditions[0]?.value)).toEqual(['ListOrders', 'ListCustomers'])
    expect(() => parseApiDocument(input, { expectedRoute: route + '/other' })).toThrow(/其他页面/)
    expect(() => parseApiDocument(input.replace('/operationName', '/password'))).toThrow(/凭据/)
  })
})
