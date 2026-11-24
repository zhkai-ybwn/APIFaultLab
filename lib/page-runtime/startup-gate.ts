export const STARTUP_KEY = '__apiFaultLabStartup_v1__'
const STARTUP_WAIT_MS = 5000

type MinimalPage = { readonly sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
export type StartupState = 'waiting' | 'protected' | 'blocked'

export function readStartupMarker(page: MinimalPage): string | undefined {
  try {
    const marker = page.sessionStorage?.getItem(STARTUP_KEY)
    if (marker && /^[a-z\d-]{1,128}$/i.test(marker)) return marker
  } catch { /* Web Storage can be unavailable for a page. */ }
}

export function writeStartupMarker(page: MinimalPage, session?: string): boolean {
  try {
    const storage = page.sessionStorage
    if (!storage) return false
    if (session) storage.setItem(STARTUP_KEY, session)
    else storage.removeItem(STARTUP_KEY)
    return true
  } catch {
    return false
  }
}

export function createStartupGate(expectedSession: string | undefined) {
  let state: StartupState | undefined = expectedSession ? 'waiting' : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settle: ((allow: boolean) => void) | undefined
  let pending: Promise<boolean> | undefined

  function resolve(allow: boolean) {
    if (!state) return
    state = allow ? 'protected' : 'blocked'
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    settle?.(allow)
    settle = undefined
  }

  function wait() {
    if (state !== 'waiting') return Promise.resolve(state !== 'blocked')
    if (!pending) {
      pending = new Promise<boolean>(done => { settle = done })
      timer = setTimeout(() => resolve(false), STARTUP_WAIT_MS)
    }
    return pending
  }

  function confirm(session: string, explicit: boolean) {
    if (!state || state === 'protected') return true
    const match = explicit || session === expectedSession
    resolve(match)
    return match
  }

  return {
    get state() { return state },
    get holdsRequests() { return state === 'waiting' || state === 'blocked' },
    wait,
    confirm,
    discard: () => resolve(false),
  }
}

export function startupBlockedError(): TypeError {
  return new TypeError('APIFaultLab: 已阻止规则尚未确认的首屏请求。')
}
