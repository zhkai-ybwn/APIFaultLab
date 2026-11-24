import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_CONTROL_KEY } from '../model'
import type { PageControl, PageReport, Rule } from '../model'

const siteOrigin = 'https://app.example.test'
const orders = `${siteOrigin}/orders`
const customers = `${siteOrigin}/customers`
const endpoint = { method: 'POST', origin: siteOrigin, path: '/api/query' }
const realFetch = vi.fn<typeof fetch>(async () => Response.json({ data: { list: ['actual item'] } }))
const postMessage = vi.fn<(report: PageReport, target: string) => void>()
const runtime = globalThis as typeof globalThis & { [PAGE_CONTROL_KEY]?: PageControl }
let revision = 0
let install: () => void

function setRoute(address: string): void {
  vi.stubGlobal('location', new URL(address))
}

function configure(delayMs = 0): number {
  const rule: Rule = {
    id: 'list-orders',
    routeKey: orders,
    endpoint,
    conditions: [{ source: 'json', path: '/operationName', value: 'ListOrders' }],
    response: {
      kind: 'http',
      status: 200,
      contentType: 'application/json',
      body: '{"data":{"list":[]}}',
      delayMs,
    },
  }
  expect(runtime[PAGE_CONTROL_KEY]?.({
    type: 'configure', session: 'this-test', siteOrigin, revision: ++revision, observing: true, rules: [rule],
  })).toMatchObject({ activeCount: 1, intact: true })
  return revision
}

function query(operationName: string): Promise<Response> {
  return fetch(`${siteOrigin}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName }),
  })
}

describe('page Fetch adapter in Node', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('top', globalThis)
    vi.stubGlobal('fetch', realFetch)
    vi.stubGlobal('XMLHttpRequest', class extends EventTarget {
      open() {}
      send() {}
    })
    vi.stubGlobal('postMessage', postMessage)
    vi.stubGlobal('addEventListener', vi.fn())
    vi.stubGlobal('removeEventListener', vi.fn())
    vi.stubGlobal('defineUnlistedScript', (entry: unknown) => entry)
    setRoute(orders)
    install = (await import('../../entrypoints/page-main')).default as unknown as () => void
    install()
  })

  beforeEach(() => {
    setRoute(orders)
    vi.stubGlobal('document', { baseURI: orders })
    realFetch.mockClear()
    postMessage.mockClear()
  })

  afterAll(() => {
    delete runtime[PAGE_CONTROL_KEY]
    vi.unstubAllGlobals()
  })

  it('captures the initiating URL before a synchronous SPA navigation', async () => {
    const applied = configure()
    const pending = query('ListOrders')
    setRoute(customers)

    expect(await (await pending).json()).toEqual({ data: { list: [] } })
    expect(realFetch).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'mock', routeKey: orders, revision: applied }),
    }), siteOrigin)
  })

  it('passes through another operation at the same POST endpoint exactly once', async () => {
    configure()
    const signal = new AbortController().signal
    const init: RequestInit = {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operationName":"ListCustomers"}', signal,
    }
    expect(await (await fetch('/api/query', init)).json()).toEqual({ data: { list: ['actual item'] } })
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(realFetch.mock.calls[0]?.[0]).toBe('/api/query')
    expect(realFetch.mock.calls[0]?.[1]).toBe(init)
    expect(postMessage.mock.calls.map(([report]) => report.event.phase)).toEqual(['request', 'bypassed', 'real'])
  })

  it('cancels only pending mocks from the route whose rules are stopped', async () => {
    const orderRule: Rule = {
      id: 'orders', routeKey: orders, endpoint, conditions: [],
      response: { kind: 'http', status: 200, contentType: 'application/json', body: '[]', delayMs: 60_000 },
    }
    const customerRule: Rule = {
      ...orderRule, id: 'customers', routeKey: customers,
      response: { ...orderRule.response, body: '["customer"]', delayMs: 250 },
    }
    const configureRoutes = (rules: Rule[]) => runtime[PAGE_CONTROL_KEY]?.({
      type: 'configure', session: 'this-test', siteOrigin, revision: ++revision, observing: true, rules,
    })
    configureRoutes([orderRule, customerRule])
    const pendingOrder = expect(query('ListOrders')).rejects.toMatchObject({ name: 'AbortError' })
    setRoute(customers)
    const pendingCustomer = query('ListCustomers')
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'delay', routeKey: customers }),
    }), siteOrigin))

    configureRoutes([customerRule])

    await pendingOrder
    expect(await (await pendingCustomer).json()).toEqual(['customer'])
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('observes a relative URL without reconstructing the original one-argument site call', async () => {
    vi.stubGlobal('document', { baseURI: `${siteOrigin}/dashboard/` })
    runtime[PAGE_CONTROL_KEY]?.({
      type: 'configure', session: 'this-test', siteOrigin, revision: ++revision, observing: true, rules: [],
    })
    const receiver = {}
    const response = new Response('original')
    realFetch.mockImplementationOnce(function (this: unknown, ...args) {
      expect(this).toBe(receiver)
      expect(args).toEqual(['query'])
      return Promise.resolve(response)
    })

    const pending = fetch.call(receiver, 'query')
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(await pending).toBe(response)
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'real', endpoint: { origin: siteOrigin, path: '/dashboard/query', method: 'GET' } }),
    }), siteOrigin)
  })

  it('inspects a Request with overridden init without consuming the body passed to the site', async () => {
    configure()
    const input = new Request(`${siteOrigin}/api/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operationName":"ListCustomers"}',
    })
    const init: RequestInit = { headers: { 'content-type': 'application/json', 'x-client': 'original' } }
    realFetch.mockImplementationOnce(async (request, requestInit) => {
      expect(request).toBe(input)
      expect(requestInit).toBe(init)
      expect(input.bodyUsed).toBe(false)
      return Response.json(await new Request(request, requestInit).json())
    })

    expect(await (await fetch(input, init)).json()).toEqual({ operationName: 'ListCustomers' })
    expect(realFetch).toHaveBeenCalledTimes(1)
  })

  it('preserves the site wrapper’s rejection reason when an unmatched POST is cancelled', async () => {
    configure()
    const controller = new AbortController()
    const init: RequestInit = {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operationName":"ListCustomers"}',
      signal: controller.signal,
    }
    realFetch.mockImplementationOnce((_url, requestInit) => new Promise((_, reject) => {
      const signal = requestInit?.signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))

    const pending = fetch('/api/query', init)
    await vi.waitFor(() => expect(realFetch).toHaveBeenCalledExactlyOnceWith('/api/query', init))
    const reason = new DOMException('cancelled by the page', 'AbortError')
    const rejection = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejection

    expect(postMessage.mock.calls.map(([report]) => report.event.phase)).toEqual(['request', 'bypassed', 'cancelled'])
  })

  it('calls a rejecting site wrapper only once when observation cannot describe the URL', () => {
    configure()
    const error = new Error('original wrapper error')
    realFetch.mockImplementationOnce(() => { throw error })

    expect(() => fetch('custom:query')).toThrow(error)
    expect(realFetch).toHaveBeenCalledExactlyOnceWith('custom:query')
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('keeps a streaming body intact and refuses to forward when its JSON condition cannot be checked', async () => {
    configure()
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"operationName":"ListOrders"}'))
      controller.close()
    } })
    const init = {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
    } satisfies RequestInit & { duplex: string }

    await expect(fetch('/api/query', init)).rejects.toThrow('could not determine the request condition')
    expect(body.locked).toBe(false)
    expect(realFetch).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'error', detail: expect.stringContaining('流式请求正文') }),
    }), siteOrigin)
  })

  it('stops a pending simulated POST and restores the next request to the original Fetch', async () => {
    const applied = configure(1_000)
    const pending = query('ListOrders')
    await vi.waitFor(() => {
      expect(postMessage.mock.calls.some(([report]) => report.event.phase === 'delay')).toBe(true)
    })
    const stopped = ++revision
    expect(runtime[PAGE_CONTROL_KEY]?.({ type: 'stop', session: 'this-test', revision: stopped }))
      .toMatchObject({ revision: stopped, activeCount: 0, intact: true })

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(realFetch).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ phase: 'cancelled', revision: applied }),
    }), siteOrigin)

    expect(await (await query('ListOrders')).json()).toEqual({ data: { list: ['actual item'] } })
    expect(realFetch).toHaveBeenCalledTimes(1)
  })

  it('repairs replaced page intrinsics without losing rules or calling through an adapter twice', async () => {
    const applied = configure()
    const earlyFetch = fetch
    const earlyXhr = XMLHttpRequest
    const siteFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => earlyFetch(input, init))
    const siteXhr = class extends earlyXhr {}
    globalThis.fetch = siteFetch
    globalThis.XMLHttpRequest = siteXhr
    expect(runtime[PAGE_CONTROL_KEY]?.({ type: 'status' }).intact).toBe(false)

    install()
    expect(runtime[PAGE_CONTROL_KEY]?.({ type: 'status' })).toMatchObject({ intact: true, activeCount: 1, revision: applied })
    expect(await (await query('ListOrders')).json()).toEqual({ data: { list: [] } })
    expect(siteFetch).not.toHaveBeenCalled()
    expect(await (await query('OtherOperation')).json()).toEqual({ data: { list: ['actual item'] } })
    expect(siteFetch).toHaveBeenCalledTimes(1)
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(new XMLHttpRequest()).toBeInstanceOf(siteXhr)
    expect(postMessage.mock.calls.map(([report]) => report.event.phase)).toEqual(['request', 'mock', 'request', 'bypassed', 'real'])
  })
})
