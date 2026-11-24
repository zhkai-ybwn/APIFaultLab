import { describe, expect, it } from 'vitest'
import { exportBackup, exportPlanShare, exportRescueData, mergeBackup, readBackup, readLocalData, salvageLocalData } from './backup'

const siteOrigin = 'https://example.test'
const routeKey = `${siteOrigin}/orders?view=active`
const endpoint = { method: 'POST', origin: siteOrigin, path: '/api/{type}/query', template: true }
const response = { kind: 'http', status: 429, body: '{"configured":true}', contentType: 'application/json', delayMs: 0, retryAfterSeconds: 30 }
const plan = {
  id: 'plan', name: '限流测试', updatedAt: 1, siteOrigin, routeKey, setup: '', trigger: '', expectation: '',
  rules: [{ id: 'rule', endpoint, routeKey, conditions: [{ source: 'json', path: '/operationName', value: 'ListOrders' }], response }],
}

describe('portable local backup', () => {
  it('round-trips all durable types and excludes captured session fields', async () => {
    const data = readLocalData({
      plans: [plan],
      imports: [{ siteOrigin, routeKey, entry: {
        endpoint, title: '订单列表', example: response, sample: 'actual response', observed: true,
        last: { detail: 'request event' }, hitCount: 7,
      } }],
      ignoresBySite: { [siteOrigin]: [{ kind: 'prefix', path: '/assets' }] },
      scenarios: [{ id: 'invalid-json', name: '解析失败', response: { ...response, body: '{' }, allowInvalidJson: true }],
    })
    const json = exportBackup(data)
    expect(json).not.toMatch(/actual response|request event|hitCount|observed/)
    expect(readBackup(json)).toEqual(data)
    expect(JSON.parse(json).data.plans[0].rules[0].response.body).toBe(response.body)
    const { preview } = await mergeBackup(data, readBackup(json))
    expect([preview.plans, preview.imports, preview.ignores, preview.scenarios]).toEqual(
      Array.from({ length: 4 }, () => ({ added: 0, conflicts: 0, unchanged: 1 })),
    )
  })

  it('rejects unknown versions, incomplete backup payloads and unreadable stored data', () => {
    const backup = JSON.parse(exportBackup(readLocalData()))
    expect(() => readBackup(JSON.stringify({ ...backup, schemaVersion: 2 }))).toThrow('无法恢复')
    expect(() => readBackup(JSON.stringify({ ...backup, data: { plans: [plan] } }))).toThrow('格式无效')
    expect(() => readLocalData({ plans: [plan], imports: null })).toThrow('格式无效')
    expect(() => readLocalData({ plans: [plan], version: 2 })).toThrow('无法识别')
  })

  it('shares an anonymous rule summary by default and restores only explicit full plan files', async () => {
    const data = readLocalData({ plans: [{ ...plan, trigger: '触发说明中有内部细节' }] })
    const saved = data.plans[0]!
    const summary = exportPlanShare(saved)
    expect(JSON.parse(summary).plan).toEqual({
      rules: [{ method: 'POST', kind: 'http', status: 429, delayMs: 0 }],
    })
    expect(summary).not.toMatch(/example\.test|ListOrders|configured|内部细节|限流测试|api\//)
    expect(() => readBackup(summary)).toThrow('仅供分享')

    const shared = readBackup(exportPlanShare(saved, true))
    expect(shared).toEqual(data)
    expect((await mergeBackup(readLocalData(), shared)).preview.plans.added).toBe(1)
  })

  it('keeps original unreadable data while salvaging only individually valid records', () => {
    const raw = {
      plans: [plan, { ...plan, id: 'bad', routeKey: 'file:///not-a-page' }, plan],
      imports: null, ignoresBySite: { [siteOrigin]: [{ kind: 'prefix', path: '/assets' }, { kind: 'prefix', path: 'broken' }] },
      scenarios: [{ id: 'valid', name: '限流', response }], future: '保留此未知字段',
    }
    const rawFile = exportRescueData(raw)
    expect(JSON.parse(rawFile).data).toEqual(raw)
    expect(() => readBackup(rawFile)).toThrow('原始救援数据')

    const { data, recovered, skipped } = salvageLocalData(raw)
    expect(recovered).toBe(3)
    expect(skipped).toBe(5)
    expect(data.plans.map(item => item.id)).toEqual(['plan'])
    expect(data.ignoresBySite).toEqual({ [siteOrigin]: [{ kind: 'prefix', path: '/assets' }] })
    expect(readBackup(exportBackup(data))).toEqual(data)
    expect(JSON.parse(exportRescueData(raw)).data).toEqual(raw)
  })
})
