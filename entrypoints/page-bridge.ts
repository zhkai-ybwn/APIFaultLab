import { PAGE_BOOT_MESSAGE, PAGE_REPORT_MARKER } from '../lib/model'
import { readStartupMarker } from '../lib/page-runtime/startup-gate'
import { isValidHttpMethod } from '../lib/rules'
import type { Endpoint, PageReport, RequestEvent, RequestPhase, WorkerReport } from '../lib/model'

const BRIDGE_KEY = '__apiFaultLabBridge_v1__'
const MAX_SAMPLE_LENGTH = 512 * 1024
const REQUEST_PHASES = new Set<RequestPhase>(['request', 'real', 'mock', 'bypassed', 'delay', 'error', 'cancelled'])

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}

function optionalString(value: unknown, limit: number): value is string | undefined {
  return value === undefined || boundedString(value, limit)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readEndpoint(value: unknown): Endpoint | null {
  const endpoint = record(value)
  if (!endpoint) return null
  const { method, origin, path } = endpoint
  if (
    !isValidHttpMethod(method) ||
    !boundedString(origin, 512) ||
    !boundedString(path, 4_096) || !path.startsWith('/')
  ) return null

  try {
    const url = new URL(origin)
    if (url.origin !== origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null
  } catch {
    return null
  }
  return { method, origin, path }
}

function readReport(value: unknown): PageReport | null {
  const report = record(value)
  if (!report || report.source !== PAGE_REPORT_MARKER || !boundedString(report.session, 128)) return null
  const event = record(report.event)
  if (!event) return null
  const { requestId, routeKey, phase, time, revision, status, contentType, detail, ruleId, sample, sampleId } = event
  const endpoint = readEndpoint(event.endpoint)
  if (
    !endpoint || !boundedString(requestId, 128) || !boundedString(routeKey, 8_192) ||
    typeof phase !== 'string' || !REQUEST_PHASES.has(phase as RequestPhase) ||
    typeof time !== 'number' || !Number.isFinite(time) ||
    typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 ||
    (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)) ||
    !optionalString(contentType, 512) || !optionalString(detail, 1_024) ||
    !optionalString(ruleId, 128) || !optionalString(sample, MAX_SAMPLE_LENGTH) || !optionalString(sampleId, 120)
  ) return null

  // Construct a new allowlisted payload instead of forwarding arbitrary page messages.
  const requestEvent: RequestEvent = {
    requestId, routeKey, endpoint, phase: phase as RequestPhase, time, revision,
    status, contentType, detail, ruleId, sample, sampleId,
  }
  return { source: PAGE_REPORT_MARKER, session: report.session, event: requestEvent }
}

export default defineUnlistedScript(() => {
  const bridgeWindow = window as Window & { [BRIDGE_KEY]?: (message: MessageEvent<unknown>) => void }
  if (window.top !== window) return
  const previous = bridgeWindow[BRIDGE_KEY]
  if (typeof previous === 'function') window.removeEventListener('message', previous)

  function forward(message: MessageEvent<unknown>): void {
    if (message.source !== window || message.origin !== window.location.origin) return
    const report = readReport(message.data)
    if (!report) return

    const request: WorkerReport = { type: 'page-report', session: report.session, event: report.event }
    // Extension reload or disable can invalidate a bridge left in the page.
    try {
      void chrome.runtime.sendMessage(request).catch(() => undefined)
    } catch {
      // The MAIN adapter remains responsible for completing any intercepted request.
    }
  }
  bridgeWindow[BRIDGE_KEY] = forward
  window.addEventListener('message', forward)
  if (!previous && readStartupMarker(window)) {
    try {
      void chrome.runtime.sendMessage({ type: PAGE_BOOT_MESSAGE }).catch(() => undefined)
    } catch { /* The extension may have been reloaded. */ }
  }
})
