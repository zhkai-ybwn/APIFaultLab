import { describe, expect, it } from 'vitest'
import { exportBackup, readBackup, readLocalData, type ImportedEntry } from './backup'
import { changeImportedDirectory } from './catalog-storage'
import type { CatalogEntry } from './model'
import { endpointKey } from './rules'

const page = { siteOrigin: 'https://site.test', routeKey: 'https://site.test/orders' }
const otherPage = { ...page, routeKey: 'https://site.test/customers' }

function entry(path: string, operations: string[] = []): CatalogEntry {
  const endpoint = { method: 'POST', origin: 'https://api.test', path }
  return {
    key: endpointKey(endpoint), endpoint, imported: true, observed: false, realSeen: false, hitCount: 0,
    operations: operations.map(id => ({ id, title: id, source: 'documented', conditions: [
      { source: 'json', path: '/operationName', value: id },
    ] })),
  }
}

describe('local imported directory', () => {
  const query = entry('/query', ['list-orders'])
  const archive = entry('/archive')
  const other: ImportedEntry = { ...otherPage, entry: query }
  const directory = [{ ...page, entry: query }, { ...page, entry: archive }, other]

  it('merges newly selected operations without changing other route records', () => {
    const updated = changeImportedDirectory(directory, page, { entries: [entry('/query', ['list-customers'])] })
    expect(updated.find(item => item.routeKey === page.routeKey && item.entry.key === query.key)?.entry.operations?.map(operation => operation.id))
      .toEqual(['list-orders', 'list-customers'])
    expect(updated.find(item => item.routeKey === otherPage.routeKey)).toEqual(other)
    const backup = readBackup(exportBackup(readLocalData({ imports: updated })))
    expect(backup.imports.find(item => item.routeKey === page.routeKey && item.entry.key === query.key)?.entry.operations).toHaveLength(2)
  })

  it('prevents a stale replacement and removes only the entries under the selected page', () => {
    expect(() => changeImportedDirectory(directory, page, { mode: 'replace', expectedKeys: [query.key], entries: [query] }))
      .toThrow(/已变化/)
    const replaced = changeImportedDirectory(directory, page, { mode: 'replace', expectedKeys: [query.key, archive.key], entries: [query] })
    expect(replaced).toEqual([other, { ...page, entry: query }])
    expect(changeImportedDirectory(replaced, page, { keys: [query.key] })).toEqual([other])
  })
})
