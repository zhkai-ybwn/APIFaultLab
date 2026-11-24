import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_CONTROL_KEY } from '../model'
import type { PageControl, PageReport, Rule } from '../model'

const siteOrigin = 'https://app.example.test'
const pageUrl = `${siteOrigin}/orders`
const apiUrl = `${siteOrigin}/api/query`
const postMessage = vi.fn<(report: PageReport, target: string) => void>()
const nativeSend = vi.fn()
const runtime = globalThis as typeof globalThis & { [PAGE_CONTROL_KEY]?: PageControl }
let revision = 0

// Supply just the native event target and methods the XHR adapter patches.
class NativeXhr extends EventTarget {
  readonly UNSENT = 0
  readonly OPENED = 1
  readonly HEADERS_RECEIVED = 2
  readonly LOADING = 3
  readonly DONE = 4
  readonly upload = new EventTarget()
  readyState = this.UNSENT
  responseType = 'text'
  responseURL = ''
  timeout = 0
  withCredentials = false

  open() { this.readyState = this.OPENED }
  send(body?: unknown) { nativeSend(body) }
  abort() { this.readyState = this.UNSENT }
  setRequestHeader() {}
  getResponseHeader() { return null }
  getAllResponseHeaders() { return '' }
}

function configure(delayMs: number): void {
  const rule: Rule = {
    id: 'list-orders',
    routeKey: pageUrl,
    endpoint: { method: 'POST', origin: siteOrigin, path: '/api/query' },
    conditions: [],
    response: { kind: 'http', status: 200, contentType: 'application/json', body: '[]', delayMs },
  }
  expect(runtime[PAGE_CONTROL_KEY]?.({
    type: 'configure', session: 'xhr-test', siteOrigin, revision: ++revision, observing: true, rules: [rule],
  })).toMatchObject({ activeCount: 1, intact: true })
}

function terminal(xhr: XMLHttpRequest): Promise<string> {
  return new Promise(resolve => {
    for (const event of ['load', 'abort', 'timeout', 'error']) {
      xhr.addEventListener(event, () => resolve(event), { once: true })
    }
  })
}

describe('mock XHR request lifecycle in Node', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('top', globalThis)
    vi.stubGlobal('location', new URL(pageUrl))
    vi.stubGlobal('XMLHttpRequest', NativeXhr)
    vi.stubGlobal('Document', class {})
    vi.stubGlobal('ProgressEvent', class extends Event {})
    vi.stubGlobal('postMessage', postMessage)
    vi.stubGlobal('addEventListener', vi.fn())
    vi.stubGlobal('defineUnlistedScript', (entry: unknown) => entry)
    const main = (await import('../../entrypoints/page-main')).default as unknown as () => void
    main()
  })

  beforeEach(() => {
    vi.stubGlobal('location', new URL(pageUrl))
    nativeSend.mockClear()
    postMessage.mockClear()
  })

  afterAll(() => {
    delete runtime[PAGE_CONTROL_KEY]
    vi.unstubAllGlobals()
  })

  it('stopping a delayed POST reaches the XHR abort event without native send', async () => {
    configure(1_000)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl, true)
    const outcome = terminal(xhr)
    xhr.send('body')
    await vi.waitFor(() => {
      expect(postMessage.mock.calls.some(([report]) => report.event.phase === 'delay')).toBe(true)
    })

    runtime[PAGE_CONTROL_KEY]?.({ type: 'stop', session: 'xhr-test', revision: ++revision })
    expect(await outcome).toBe('abort')
    expect(nativeSend).not.toHaveBeenCalled()
  })

  it('returns a body under the URL captured when async XHR send was called', async () => {
    configure(0)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl, true)
    const outcome = terminal(xhr)
    xhr.send('body')
    vi.stubGlobal('location', new URL(`${siteOrigin}/customers`))

    expect(await outcome).toBe('load')
    expect(xhr.responseText).toBe('[]')
    expect(nativeSend).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'mock', routeKey: pageUrl }),
    }), siteOrigin)
  })

  it('fires timeout instead of a network error if the XHR deadline precedes the mock', async () => {
    configure(1_000)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl, true)
    xhr.timeout = 15
    const outcome = terminal(xhr)
    xhr.send('body')

    expect(await outcome).toBe('timeout')
    expect(nativeSend).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'error', detail: '请求超时' }),
    }), siteOrigin)
  })

  it('keeps synchronous XHR out of the mock adapter', () => {
    configure(0)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', apiUrl, false)
      xhr.send('body')
      expect(nativeSend).toHaveBeenCalledExactlyOnceWith('body')
      expect(postMessage).not.toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
    }
  })
})
