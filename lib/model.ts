export const PANEL_PORT = 'api-fault-lab:panel'
export const PAGE_CONTROL_KEY = '__apiFaultLabControl_v1__'
export const PAGE_REPORT_MARKER = 'api-fault-lab:page-report:v1'
export const PAGE_BOOT_MESSAGE = 'apifaultlab-page-boot'
export const SAMPLE_WINDOW_MS = 20_000

export type JsonScalar = string | number | boolean | null

export interface Endpoint {
  method: string
  origin: string
  path: string
  template?: boolean
}

export interface RequestCondition {
  source: 'query' | 'json'
  path: string
  value: JsonScalar
}

export interface CatalogOperation {
  id: string
  title: string
  source: 'observed' | 'documented' | 'inferred'
  conditions: RequestCondition[]
}

export interface MockResponse {
  kind: 'http' | 'network'
  status: number
  body: string
  contentType: string
  delayMs: number
  retryAfterSeconds?: number
}

export type IgnoreRule =
  | { kind: 'endpoint'; endpoint: Endpoint }
  | { kind: 'prefix'; path: string; origin?: string }

export interface CustomScenario {
  id: string
  name: string
  response: MockResponse
  allowInvalidJson?: boolean
}

export interface Rule {
  id: string
  endpoint: Endpoint
  routeKey: string
  conditions: RequestCondition[]
  response: MockResponse
}

export interface SavedPlan {
  id: string
  name: string
  siteOrigin: string
  routeKey: string
  rules: Rule[]
  setup: string
  trigger: string
  expectation: string
  updatedAt: number
}

export type RequestPhase = 'request' | 'real' | 'mock' | 'bypassed' | 'delay' | 'error' | 'cancelled'

export interface RequestEvent {
  requestId: string
  routeKey: string
  endpoint: Endpoint
  phase: RequestPhase
  time: number
  revision: number
  status?: number
  contentType?: string
  detail?: string
  ruleId?: string
  sample?: string
  sampleId?: string
}

export interface CatalogEntry {
  key: string
  endpoint: Endpoint
  title?: string
  operations?: CatalogOperation[]
  imported: boolean
  observed: boolean
  realSeen: boolean
  contentType?: string
  sample?: string
  example?: MockResponse
  last?: RequestEvent
  hitCount: number
}

export interface PanelTarget {
  tabId: number
  documentId: string
  routeKey: string
  revision: number
}

export type PanelStatus = 'loading' | 'restoring' | 'unavailable' | 'observing' | 'applying' | 'active' | 'stopping' | 'uncertain'

export interface RuleOutcome {
  ruleId: string
  requestId: string
  phase: Extract<RequestPhase, 'mock' | 'delay' | 'error' | 'cancelled'>
  status?: number
  hitCount: number
}

export interface ResponseSampleState {
  endpoint: Endpoint
  state: 'waiting' | 'captured' | 'expired' | 'failed'
  message: string
}

export interface PanelSnapshot {
  target: PanelTarget | null
  pageUrl: string
  siteOrigin: string
  status: PanelStatus
  observing: boolean
  message?: string
  needsSiteAccess?: boolean
  storageError?: string
  storageRescueAvailable?: boolean
  sessionWarning?: string
  entries: CatalogEntry[]
  importedEntries?: CatalogEntry[]
  rules: Rule[]
  ruleOutcomes?: RuleOutcome[]
  catalogAtCapacity?: boolean
  earlyAccess?: boolean
  startupArmed?: boolean
  startupState?: 'waiting' | 'protected' | 'blocked'
  recoveryState?: 'awaiting-real' | 'real-confirmed'
  recoveryScope?: 'tab' | 'route'
  responseSample?: ResponseSampleState
  activeCount: number
  configuredCount: number
  plans: SavedPlan[]
  ignores: IgnoreRule[]
  scenarios: CustomScenario[]
}

export type PanelCommand =
  | { type: 'bind'; tabId: number }
  | { type: 'set-observing'; target: PanelTarget; enabled: boolean }
  | { type: 'reconnect'; target: PanelTarget }
  | { type: 'apply'; target: PanelTarget; rules: Rule[] }
  | { type: 'stop'; target: PanelTarget }
  | { type: 'stop-route'; target: PanelTarget }
  | { type: 'sample'; target: PanelTarget; endpoint: Endpoint }
  | { type: 'import'; target: PanelTarget; entries: CatalogEntry[]; mode?: 'replace'; expectedKeys?: string[] }
  | { type: 'delete-imports'; target: PanelTarget; keys: string[] }
  | { type: 'save-plan'; target: PanelTarget; plan: SavedPlan; expectedUpdatedAt?: number | null }
  | { type: 'delete-plan'; target: PanelTarget; planId: string }
  | { type: 'add-ignores'; target: PanelTarget; rules: IgnoreRule[] }
  | { type: 'remove-ignores'; target: PanelTarget; keys: string[] }
  | { type: 'save-scenario'; target: PanelTarget; scenario: CustomScenario }
  | { type: 'delete-scenario'; target: PanelTarget; id: string }
  | { type: 'refresh'; target: PanelTarget }
  | { type: 'early-access'; target: PanelTarget }

export interface PanelRequest {
  id: string
  command: PanelCommand
}

export type EntryResponseSources = Pick<CatalogEntry, 'example' | 'sample'>

export type PanelRequestUpdate = Pick<PanelSnapshot,
  'ruleOutcomes' | 'catalogAtCapacity' | 'message' | 'recoveryState' | 'recoveryScope' | 'responseSample'
> & {
  target: PanelTarget
  entries: Omit<CatalogEntry, 'example' | 'sample'>[]
  responseSources: [string, EntryResponseSources][]
}

export type PanelMessage =
  | { type: 'snapshot'; snapshot: PanelSnapshot }
  | { type: 'request-update'; update: PanelRequestUpdate }
  | { type: 'result'; id: string; ok: boolean; error?: string }

export type PageCommand =
  | { type: 'status' }
  | { type: 'configure'; session: string; siteOrigin: string; revision: number; observing: boolean; rules: Rule[]; overrideStartup?: boolean }
  | { type: 'observe'; session: string; enabled: boolean }
  | { type: 'sample'; session: string; id: string; endpoint: Endpoint; routeKey: string; expiresAt: number }
  | { type: 'stop'; session: string; revision: number }

export interface PageStatus {
  session: string | null
  revision: number
  activeCount: number
  observing: boolean
  intact: boolean
  startupArmed?: boolean
  startupState?: 'waiting' | 'protected' | 'blocked'
  sampleId?: string
}

export type PageControl = (command: PageCommand) => PageStatus

export interface PageReport {
  source: typeof PAGE_REPORT_MARKER
  session: string
  event: RequestEvent
}

export interface WorkerReport {
  type: 'page-report'
  session: string
  event: RequestEvent
}

export interface ImportedOperation {
  id: string
  method: string
  path: string
  title: string
  serverUrl?: string
  contentType?: string
  example?: MockResponse
  proposal?: CatalogOperation
}

export interface ApiImportPreview {
  operations: ImportedOperation[]
  suggestedBaseUrl: string
  warnings: string[]
  catalogPage?: string
}
