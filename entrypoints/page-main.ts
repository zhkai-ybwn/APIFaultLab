import { XMLHttpRequestInterceptor } from '@mswjs/interceptors/XMLHttpRequest/web'
import { PAGE_CONTROL_KEY, PAGE_REPORT_MARKER, SAMPLE_WINDOW_MS } from '../lib/model'
import type {
  Endpoint,
  PageCommand,
  PageControl,
  PageReport,
  PageStatus,
  RequestEvent,
  Rule,
} from '../lib/model'
import {
  abortableDelay,
  buildResponse,
  endpointCovers,
  endpointFromUrl,
  matchRequest,
  readLimitedText,
  routeKey,
} from '../lib/rules'
import { createStartupGate, readStartupMarker, startupBlockedError, writeStartupMarker } from '../lib/page-runtime/startup-gate'

const SAMPLE_LIMIT = 512 * 1024
const SAMPLE_READ_TIMEOUT_MS = 3_000

type Snapshot = Extract<PageCommand, { type: 'configure' }>
type InstalledControl = PageControl & { detach?: () => Snapshot | null }
type PageWindow = Window & typeof globalThis & { [PAGE_CONTROL_KEY]?: InstalledControl }
type FetchArguments = Parameters<typeof fetch>
type Launch = { snapshot: Snapshot; route: string; startedAt: number; stopSignal: AbortSignal }
type Call = { launch: Launch; event: RequestEvent }
type XhrLaunch = { launch: Launch; timeout: number; call?: Call; forwarded?: boolean; forcedTimeout?: boolean }
type Decision =
  | { kind: 'forward'; candidate: boolean; detail?: string }
  | { kind: 'mock'; response: Response; rule: Rule }
  | { kind: 'failure'; error: Error; phase: 'cancelled' | 'error'; detail: string; ruleId?: string; timeout?: boolean }

function abortError(): DOMException {
  return new DOMException('APIFaultLab cancelled this request', 'AbortError')
}

function awaitAbortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) {
      void work.catch(() => undefined)
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function supportsRequest(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

function failureFor(reason: unknown, ruleId?: string): Extract<Decision, { kind: 'failure' }> {
  const error = reason instanceof Error ? reason : new TypeError('APIFaultLab could not complete the request')
  if (error.name === 'TimeoutError') {
    return { kind: 'failure', error, phase: 'error', detail: '请求超时', ruleId, timeout: true }
  }
  if (error.name === 'AbortError') {
    return { kind: 'failure', error, phase: 'cancelled', detail: '已取消，未向服务端发送', ruleId }
  }
  return { kind: 'failure', error, phase: 'error', detail: '模拟失败，未向服务端发送', ruleId }
}

function installPageAdapter(page: PageWindow): void {
  if (page.top !== page || !supportsRequest(page.location.href)) return
  const previous = page[PAGE_CONTROL_KEY]
  const previousStatus = previous?.({ type: 'status' })
  if (previous && (previousStatus?.intact || !previous.detach)) return

  // A page may replace either global after document_start. Deactivate our older
  // closures before wrapping the page's current clients, including wrappers
  // that still call the older adapter.
  let configuration = previous?.detach?.() ?? null
  const marker = readStartupMarker(page)
  const wasHolding = previousStatus?.startupState === 'waiting' || previousStatus?.startupState === 'blocked'
  let gate = createStartupGate(configuration && !wasHolding ? undefined : marker)
  if (previousStatus?.startupState === 'blocked') gate.discard()
  let startupArmed = Boolean(marker)
  const nativeFetch = page.fetch
  const nativeXhr = page.XMLHttpRequest
  const xhrInterceptor = new XMLHttpRequestInterceptor()
  const xhrLaunches = new WeakMap<XMLHttpRequest, XhrLaunch>()
  const startupXhrs = new WeakMap<XMLHttpRequest, { url: string; time: number; timeout: number; forcedTimeout?: boolean }>()
  let currentWork = new AbortController()
  const routeWork = new Map<string, AbortController>()
  const ruleHits = new Map<string, number>()
  let sample: { id: string; session: string; route: string; endpoint: Endpoint; expiresAt: number } | null = null

  function currentRoute(url = page.location.href): string {
    return routeKey(url, configuration?.routeGrouping ?? 'exact')
  }

  function stopWork(): void {
    currentWork.abort(abortError())
    for (const controller of routeWork.values()) controller.abort(abortError())
    routeWork.clear()
    ruleHits.clear()
    currentWork = new AbortController()
    sample = null
  }

  function launch(initiatingRoute = currentRoute(), initiatingTime = Date.now()): Launch | null {
    if (!configuration || configuration.siteOrigin !== page.location.origin) return null
    if (!configuration.observing && configuration.rules.length === 0) return null
    let work = routeWork.get(initiatingRoute)
    if (!work && configuration.rules.some(rule => rule.routeKey === initiatingRoute)) {
      work = new AbortController()
      routeWork.set(initiatingRoute, work)
    }
    return {
      snapshot: configuration,
      route: initiatingRoute,
      startedAt: initiatingTime,
      stopSignal: work?.signal ?? currentWork.signal,
    }
  }

  function announce(call: Call, patch: Pick<RequestEvent, 'phase'> & Partial<RequestEvent>): void {
    if (configuration?.session !== call.launch.snapshot.session) return
    const report: PageReport = {
      source: PAGE_REPORT_MARKER,
      session: call.launch.snapshot.session,
      event: { ...call.event, ...patch, time: Date.now() },
    }
    try {
      page.postMessage(report, call.launch.snapshot.siteOrigin)
    } catch {
      // A page can replace postMessage. Reporting must not affect its requests.
    }
  }

  function beginCall(start: Launch, endpoint: Endpoint): { call: Call; candidates: Rule[] } {
    const candidates = start.snapshot.rules.filter(
      (rule) => rule.routeKey === start.route && endpointCovers(rule.endpoint, endpoint),
    )
    const call: Call = {
      launch: start,
      event: {
        requestId: page.crypto.randomUUID?.() ?? String(Math.random()).slice(2),
        routeKey: start.route,
        endpoint,
        phase: 'request',
        time: start.startedAt,
        revision: start.snapshot.revision,
      },
    }
    if (start.snapshot.observing || candidates.length) announce(call, { phase: 'request' })
    return { call, candidates }
  }

  async function decide(
    call: Call, candidates: Rule[], request: Request, { timeout = 0, inspectBody = true } = {},
  ): Promise<Decision> {
    if (candidates.length === 0) return { kind: 'forward', candidate: false }
    const deadline = new AbortController()
    const remaining = timeout - (Date.now() - call.launch.startedAt)
    let timeoutId: number | undefined
    if (timeout > 0) {
      const expire = () => deadline.abort(new DOMException('The request timed out', 'TimeoutError'))
      if (remaining > 0) timeoutId = page.setTimeout(expire, remaining)
      else expire()
    }
    const signal = AbortSignal.any([request.signal, call.launch.stopSignal, deadline.signal])
    let ruleId: string | undefined

    try {
      signal.throwIfAborted()
      const match = await awaitAbortable(matchRequest(candidates, request, call.launch.route, { inspectBody }), signal)
      signal.throwIfAborted()
      if (match.kind === 'none') return { kind: 'forward', candidate: match.candidate }
      if (match.kind === 'invalid') {
        return {
          kind: 'failure',
          error: new TypeError('APIFaultLab could not determine the request condition'),
          phase: 'error',
          detail: match.detail,
          ruleId: match.ruleId,
        }
      }
      const { rule } = match
      if (rule.maxHits !== undefined) {
        const used = ruleHits.get(rule.id) ?? 0
        if (used >= rule.maxHits) {
          return { kind: 'forward', candidate: true, detail: `已达本轮 ${rule.maxHits} 次生效上限，已放行真实请求` }
        }
        ruleHits.set(rule.id, used + 1)
      }
      ruleId = rule.id
      if (rule.response.delayMs > 0) {
        announce(call, { phase: 'delay', ruleId, detail: `延迟 ${rule.response.delayMs} 毫秒` })
        await abortableDelay(rule.response.delayMs, signal)
      }
      signal.throwIfAborted()
      return { kind: 'mock', response: buildResponse(rule.response, request.method), rule }
    } catch (reason) {
      return failureFor(reason, ruleId)
    } finally {
      if (timeoutId !== undefined) page.clearTimeout(timeoutId)
    }
  }

  function reportFailure(call: Call, outcome: Extract<Decision, { kind: 'failure' }>): void {
    announce(call, { phase: outcome.phase, detail: outcome.detail, ruleId: outcome.ruleId })
  }

  function reportMock(call: Call, response: Response, ruleId?: string): void {
    announce(call, {
      phase: 'mock',
      ruleId,
      status: response.status || undefined,
      contentType: response.headers.get('content-type') ?? undefined,
      detail: response.type === 'error' ? '模拟网络失败' : undefined,
    })
  }

  function reportReal(call: Call, response: Response): void {
    const contentType = response.headers.get('content-type') ?? undefined
    const fields = { phase: 'real' as const, status: response.status || undefined, contentType }
    announce(call, fields)
    const capture = sample
    if (
      !capture ||
      capture.session !== call.launch.snapshot.session ||
      capture.expiresAt < Date.now() ||
      capture.route !== call.launch.route ||
      capture.route !== currentRoute() ||
      !endpointCovers(capture.endpoint, call.event.endpoint)
    ) return

    sample = null
    const declaredLength = Number(response.headers.get('content-length'))
    if (declaredLength > SAMPLE_LIMIT) {
      announce(call, { ...fields, sampleId: capture.id, detail: '响应正文超过采样上限。' })
      return
    }
    try {
      const copy = response.clone()
      void readLimitedText(copy.body, SAMPLE_LIMIT, call.launch.stopSignal, SAMPLE_READ_TIMEOUT_MS).then(
        (body) => {
          if (configuration?.observing && capture.route === currentRoute()) {
            announce(call, { ...fields, sample: body, sampleId: capture.id })
          }
        },
        () => announce(call, { ...fields, sampleId: capture.id, detail: '未能读取响应样本，请重试或手动设置。' }),
      )
    } catch {
      announce(call, { ...fields, sampleId: capture.id, detail: '未能读取响应样本，请重试或手动设置。' })
    }
  }

  function forwardFetch(call: Call, signal: AbortSignal | null | undefined, send: () => Promise<Response>): Promise<Response> {
    function reportError() {
      announce(call, { phase: signal?.aborted ? 'cancelled' : 'error', detail: '原生请求未收到响应' })
    }

    try {
      return Promise.resolve(send()).then(response => {
        try { reportReal(call, response) } catch { /* Preserve page wrappers' responses. */ }
        return response
      }, error => {
        reportError()
        throw error
      })
    } catch (error) {
      reportError()
      throw error
    }
  }

  async function interceptFetch(
    call: Call, candidates: Rule[], url: string, [input, init]: FetchArguments, send: () => Promise<Response>,
  ): Promise<Response> {
    let request: Request
    let ownedBody: Request | undefined
    let decision: Decision
    try {
      if (input instanceof Request && !init) {
        if (input.bodyUsed || input.body?.locked) throw new TypeError('请求正文已读取或锁定')
        request = input
      } else {
        // A Request constructor can consume an input Request's body. Inspect a separate branch.
        if (input instanceof Request && input.body && init?.body == null) ownedBody = input.clone()
        request = new Request(ownedBody ?? (input instanceof Request ? input : url), init)
        if (ownedBody) ownedBody = request
      }
      decision = await decide(call, candidates, request, { inspectBody: !(init?.body instanceof ReadableStream) })
    } catch (error) {
      reportFailure(call, failureFor(error))
      throw error
    } finally {
      void ownedBody?.body?.cancel().catch(() => undefined)
    }

    if (decision.kind === 'failure') {
      reportFailure(call, decision)
      throw decision.error
    }
    if (decision.kind === 'mock') {
      if (request.signal.aborted || call.launch.stopSignal.aborted) {
        const failure = failureFor(request.signal.reason ?? call.launch.stopSignal.reason, decision.rule.id)
        reportFailure(call, failure)
        throw failure.error
      }
      if (decision.response.type === 'error') {
        reportMock(call, decision.response, decision.rule.id)
        throw new TypeError('Failed to fetch')
      }
      // Native fetch responses carry the original request URL, which clients may inspect.
      Object.defineProperty(decision.response, 'url', { value: request.url, configurable: true })
      reportMock(call, decision.response, decision.rule.id)
      return decision.response
    }
    if (decision.candidate) {
      announce(call, { phase: 'bypassed', detail: decision.detail ?? '请求条件未匹配' })
    }
    return forwardFetch(call, request.signal, send)
  }

  function describeFetch([input, init]: FetchArguments) {
    try {
      const request = input instanceof Request ? input : undefined
      const address = request?.url ?? (input instanceof URL ? input.href : input)
      const method = init?.method ?? request?.method ?? 'GET'
      if (typeof address !== 'string' || typeof method !== 'string') return
      const url = new URL(address, page.document?.baseURI ?? page.location.href).href
      if (!supportsRequest(url)) return
      const initSignal = init?.signal
      return { url, endpoint: endpointFromUrl(method, url), signal: initSignal === undefined ? request?.signal : initSignal }
    } catch {
      // Unrecognized page-specific inputs still go to the site's original client.
    }
  }

  function patchedFetch(this: unknown, ...args: FetchArguments): Promise<Response> {
    const send = () => Reflect.apply(nativeFetch, this, args)
    const initiallyHeld = gate.holdsRequests
    const start = initiallyHeld ? null : launch()
    if (!initiallyHeld && !start) return send()
    const details = describeFetch(args)
    function run(ready: Launch | null): Promise<Response> {
      if (!ready || !details) return send()
      const { url, endpoint, signal } = details
      const { call, candidates } = beginCall(ready, endpoint)
      if (candidates.length) return interceptFetch(call, candidates, url, args, send)
      return ready.snapshot.observing ? forwardFetch(call, signal, send) : send()
    }
    if (!initiallyHeld) return run(start)

    const url = page.location.href
    const time = Date.now()
    const waited = details?.signal ? awaitAbortable(gate.wait(), details.signal) : gate.wait()
    return waited.then(allow => {
      details?.signal?.throwIfAborted()
      if (!allow) throw startupBlockedError()
      return run(launch(currentRoute(url), time))
    })
  }

  xhrInterceptor.on('request', async ({ request, initiator, controller }) => {
    const xhr = initiator as XMLHttpRequest
    if (!supportsRequest(request.url)) return
    let started = xhrLaunches.get(xhr)
    const held = startupXhrs.get(xhr)
    if (!started && held) {
      const remaining = held.timeout > 0 ? held.timeout - (Date.now() - held.time) : undefined
      try {
        if (remaining !== undefined && remaining <= 0) throw new DOMException('The request timed out', 'TimeoutError')
        const signal = remaining === undefined ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(remaining)])
        if (!await awaitAbortable(gate.wait(), signal)) throw startupBlockedError()
        const ready = launch(currentRoute(held.url), held.time)
        if (!ready) return
        started = { launch: ready, timeout: held.timeout }
        xhrLaunches.set(xhr, started)
      } catch (reason) {
        if (!request.signal.aborted && controller.readyState === 0) {
          const failure = failureFor(reason)
          held.forcedTimeout = failure.timeout
          controller.errorWith(failure.error)
        }
        return
      }
    }
    if (!started) return
    const { call, candidates } = beginCall(started.launch, endpointFromUrl(request.method, request.url))
    if (started.launch.snapshot.observing || candidates.length) started.call = call
    const decision = await decide(call, candidates, request, { timeout: started.timeout })

    if (decision.kind === 'forward') {
      started.forwarded = true
      if (decision.candidate) announce(call, { phase: 'bypassed', detail: decision.detail ?? '请求条件未匹配' })
      return
    }
    if (decision.kind === 'failure') {
      reportFailure(call, decision)
      if (controller.readyState === 0) {
        started.forcedTimeout = decision.timeout
        // MSW converts an error without the client's abort signal to an XHR error event.
        if (decision.phase === 'cancelled' && !request.signal.aborted) xhr.abort()
        controller.errorWith(decision.error)
      }
      return
    }
    if (controller.readyState !== 0 || request.signal.aborted || started.launch.stopSignal.aborted) {
      const failure = failureFor(request.signal.reason ?? started.launch.stopSignal.reason ?? abortError(), decision.rule.id)
      reportFailure(call, failure)
      if (controller.readyState === 0) {
        if (failure.phase === 'cancelled' && !request.signal.aborted) xhr.abort()
        controller.errorWith(failure.error)
      }
      return
    }
    call.event.ruleId = decision.rule.id
    if (decision.response.type === 'error') reportMock(call, decision.response, decision.rule.id)
    controller.respondWith(decision.response)
  })

  xhrInterceptor.on('response', ({ response, responseType, initiator }) => {
    const call = xhrLaunches.get(initiator as XMLHttpRequest)?.call
    if (!call) return
    if (responseType === 'mock') reportMock(call, response, call.event.ruleId)
    else reportReal(call, response)
  })

  function wrapXhr(interceptorXhr: typeof XMLHttpRequest): typeof XMLHttpRequest {
    return new Proxy(interceptorXhr, {
      construct(target, args, newTarget) {
        if (!gate.holdsRequests && (!configuration || (!configuration.observing && configuration.rules.length === 0))) {
          return Reflect.construct(nativeXhr, args, newTarget)
        }
        const xhr: XMLHttpRequest = Reflect.construct(target, args, newTarget)
        const open = xhr.open
        const send = xhr.send
        let synchronous = false
        const trackedOpen = new Proxy(open, {
          apply(nativeOpen, receiver, openArgs) {
            const useAsync = openArgs[2] === undefined || Boolean(openArgs[2])
            // Convert explicitly supplied falsy values as the native WebIDL boolean does.
            if (openArgs[2] !== undefined) openArgs[2] = useAsync
            const result = Reflect.apply(nativeOpen, receiver, openArgs)
            synchronous = !useAsync
            return result
          },
        })
        const trackedSend = new Proxy(send, {
          apply(nativeSend, receiver, sendArgs) {
            const previous = xhrLaunches.get(xhr)
            const start = gate.holdsRequests ? null : launch()
            if (gate.holdsRequests) {
              startupXhrs.set(xhr, { url: page.location.href, time: Date.now(), timeout: xhr.timeout })
            } else startupXhrs.delete(xhr)
            if (start) xhrLaunches.set(xhr, { launch: start, timeout: xhr.timeout })
            else xhrLaunches.delete(xhr)
            try {
              return Reflect.apply(nativeSend, receiver, sendArgs)
            } catch (error) {
              if (previous) xhrLaunches.set(xhr, previous)
              else xhrLaunches.delete(xhr)
              throw error
            }
          },
        })
        xhr.addEventListener('error', (event) => {
          const started = xhrLaunches.get(xhr)
          const timedOut = started?.forcedTimeout ? started : startupXhrs.get(xhr)
          if (timedOut?.forcedTimeout) {
            timedOut.forcedTimeout = false
            event.stopImmediatePropagation()
            xhr.dispatchEvent(new ProgressEvent('timeout'))
          } else if (started?.forwarded && started.call) {
            announce(started.call, { phase: 'error', detail: '原生请求未收到响应' })
          }
        }, { capture: true })
        xhr.addEventListener('timeout', () => {
          const started = xhrLaunches.get(xhr)
          if (started?.forwarded && started.call) announce(started.call, { phase: 'error', detail: '原生请求超时' })
        })
        xhr.addEventListener('abort', () => {
          const started = xhrLaunches.get(xhr)
          if (started?.forwarded && started.call) announce(started.call, { phase: 'cancelled', detail: '原生请求已取消' })
        })
        return new Proxy(xhr, {
          get(instance, name) {
            if (name === 'open') return trackedOpen
            if (name === 'send' && !synchronous) return trackedSend
            return Reflect.get(instance, name)
          },
        })
      },
    })
  }

  let interceptorXhr: typeof XMLHttpRequest | undefined
  let patchedXhr: typeof XMLHttpRequest | undefined
  try {
    xhrInterceptor.apply()
    interceptorXhr = page.XMLHttpRequest
    if (interceptorXhr !== nativeXhr) {
      patchedXhr = wrapXhr(interceptorXhr)
      page.XMLHttpRequest = patchedXhr
      page.fetch = patchedFetch
    }
  } catch {
    // Undo a partial setup when the second global cannot be assigned.
    if (page.XMLHttpRequest === patchedXhr && interceptorXhr) page.XMLHttpRequest = interceptorXhr
    if (page.fetch === patchedFetch) page.fetch = nativeFetch
    xhrInterceptor.dispose()
  }

  function status(): PageStatus {
    return {
      session: configuration?.session ?? null,
      revision: configuration?.revision ?? 0,
      activeCount: configuration?.rules.length ?? 0,
      observing: configuration?.observing ?? false,
      routeGrouping: configuration?.routeGrouping,
      sampleId: sample?.id,
      intact: page.fetch === patchedFetch && page.XMLHttpRequest === patchedXhr,
      startupArmed,
      startupState: gate.state,
    }
  }

  function control(command: PageCommand): PageStatus {
    if (command.type === 'configure') {
      if (command.siteOrigin !== page.location.origin || !status().intact) return status()
      if (configuration?.session === command.session && command.revision < configuration.revision) return status()
      if (configuration?.session !== command.session) stopWork()
      else if (configuration.revision !== command.revision) {
        const routes = new Set(command.rules.map(rule => rule.routeKey))
        for (const [route, controller] of routeWork) {
          if (routes.has(route)) continue
          controller.abort(abortError())
          routeWork.delete(route)
        }
        ruleHits.clear()
        sample = null
      }
      configuration = command
      if (gate.confirm(command.session, Boolean(command.overrideStartup))) {
        const saved = writeStartupMarker(page, command.rules.length ? command.session : undefined)
        startupArmed = saved && command.rules.length > 0
      }
      if (!command.observing) sample = null
    } else if (command.type !== 'status' && configuration?.session === command.session) {
      if (command.type === 'observe') {
        configuration = { ...configuration, observing: command.enabled }
        if (!command.enabled) sample = null
      } else if (command.type === 'sample') {
        if (configuration.observing && command.routeKey === currentRoute() &&
            typeof command.id === 'string' && Number.isFinite(command.expiresAt) && command.expiresAt > Date.now()) {
          sample = {
            id: command.id,
            session: command.session,
            endpoint: command.endpoint,
            route: command.routeKey,
            expiresAt: Math.min(command.expiresAt, Date.now() + SAMPLE_WINDOW_MS),
          }
        }
      } else if (command.type === 'stop' && command.revision >= configuration.revision) {
        configuration = { ...configuration, revision: command.revision, rules: [] }
        gate.confirm(command.session, true)
        writeStartupMarker(page)
        startupArmed = false
        stopWork()
      }
    }
    return status()
  }

  function pageHidden(): void {
    // A document restored from the back-forward cache must await a new acknowledgement.
    configuration = null
    gate.discard()
    stopWork()
  }

  function pageShown(event: PageTransitionEvent): void {
    if (event.persisted && !configuration) gate = createStartupGate(readStartupMarker(page))
  }

  page[PAGE_CONTROL_KEY] = Object.assign(control, {
    detach() {
      const saved = configuration
      pageHidden()
      const xhrWasReplaced = page.XMLHttpRequest !== patchedXhr
      const pageXhr = xhrWasReplaced ? Object.getOwnPropertyDescriptor(page, 'XMLHttpRequest') : undefined
      if (page.fetch === patchedFetch) page.fetch = nativeFetch
      xhrInterceptor.dispose()
      // The interceptor restores its previous property on disposal. A wrapper
      // installed by the page since then must remain in the request chain.
      if (pageXhr) Object.defineProperty(page, 'XMLHttpRequest', pageXhr)
      else if (xhrWasReplaced) Reflect.deleteProperty(page, 'XMLHttpRequest')
      page.removeEventListener('pagehide', pageHidden)
      page.removeEventListener('pageshow', pageShown)
      return saved
    },
  })
  page.addEventListener('pagehide', pageHidden)
  page.addEventListener('pageshow', pageShown)
}

export default defineUnlistedScript(() => installPageAdapter(window))
