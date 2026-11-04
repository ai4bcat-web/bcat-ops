/**
 * Test doubles for tms-spot-quoter: an in-memory SpotStore that records every write, a
 * recording Gmail port, a scripted model and a fake CRM. Imported only by *.test.ts, so
 * what the suites assert is which rows were written and whether anything was sent.
 */
import type {
  AiAgentsSettings,
  GmailConnectionRecord,
  SpotRequestRecord,
  SpotRequestStatus,
  SpotSettingsRecord,
} from '../../../src/types/tms'
import type { GmailMessageMeta, GmailPort, OutgoingReply } from '../../../src/lib/spot/port'
import type { RawSpotModelOutput } from '../../../src/lib/spot/normalize'
import type { SenderMatch } from '../../../src/lib/crm/types'
import type { SpotAutoQuoteEvent, SpotAutoQuoteResult } from '../../../src/lib/spot/types'
import type { CrmPort, OAuthPort, SimPorts, SpotDeps } from './deps'
import type { SpotModel } from './model'
import { ConflictError, type Row, type SpotStore } from './store'

export interface WriteLogEntry {
  op: string
  table: 'request' | 'connection' | 'settings' | 'audit'
  id: string
  patch?: Row
}

export interface MemoryStore extends SpotStore {
  requests: Map<string, SpotRequestRecord>
  connections: Map<string, GmailConnectionRecord>
  customers: Map<string, Row>
  quotes: Map<string, Row>
  profiles: Map<string, Row>
  integrations: Map<string, Row>
  tmsSettings: { value: Row | null }
  settings: { value: SpotSettingsRecord | null }
  writes: WriteLogEntry[]
  audits: Array<{ entityType: string; entityId: string; action: string; actorEmail: string; changes: Row }>
}

export function memoryStore(clock: () => Date = () => new Date()): MemoryStore {
  const requests = new Map<string, SpotRequestRecord>()
  const connections = new Map<string, GmailConnectionRecord>()
  const customers = new Map<string, Row>()
  const quotes = new Map<string, Row>()
  const profiles = new Map<string, Row>()
  const integrations = new Map<string, Row>()
  const tmsSettings: { value: Row | null } = { value: null }
  const settings: { value: SpotSettingsRecord | null } = { value: null }
  const writes: WriteLogEntry[] = []
  const audits: MemoryStore['audits'] = []

  function applyPatch<T extends { version?: number | null }>(base: T, patch: Row): T {
    const next: Row = { ...(base as Row) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'id' || key === 'version') continue
      if (value === null) delete next[key]
      else next[key] = value
    }
    next.version = (base.version ?? 0) + 1
    next.updatedAt = clock().toISOString()
    return next as T
  }

  return {
    db: null,
    requests, connections, customers, quotes, profiles, integrations, tmsSettings, settings, writes, audits,

    async getSpotSettings() {
      return settings.value
    },
    async putSpotSettings(row, expectedVersion) {
      const current = settings.value
      if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) throw new ConflictError('stale')
      settings.value = { ...row, id: 'default', version: (current?.version ?? 0) + 1 }
      writes.push({ op: 'put', table: 'settings', id: 'default' })
      return settings.value
    },

    async getConnection(userId) {
      return connections.get(userId) ?? null
    },
    async listConnections() {
      return [...connections.values()]
    },
    async putConnection(row) {
      connections.set(row.id, { ...row })
      writes.push({ op: 'put', table: 'connection', id: row.id })
    },
    async updateConnection(userId, patch, expectedVersion) {
      const current = connections.get(userId)
      if (!current) throw new ConflictError('missing')
      if (expectedVersion !== undefined && (current.version ?? 0) !== expectedVersion) throw new ConflictError('stale')
      const next = applyPatch(current, patch)
      connections.set(userId, next)
      writes.push({ op: 'update', table: 'connection', id: userId, patch })
      return next
    },
    async claimPoll(userId, startedAt, staleBefore) {
      const current = connections.get(userId)
      if (!current) return false
      if (current.lastPollStartedAt && current.lastPollStartedAt >= staleBefore) return false
      connections.set(userId, { ...current, lastPollStartedAt: startedAt })
      return true
    },

    async getRequest(id) {
      return requests.get(id) ?? null
    },
    async putRequestIfAbsent(row) {
      if (requests.has(row.id)) return false
      requests.set(row.id, { ...row })
      writes.push({ op: 'put', table: 'request', id: row.id, patch: row as unknown as Row })
      return true
    },
    async updateRequest(id, patch, guard) {
      const current = requests.get(id)
      if (!current) throw new ConflictError('missing')
      if (guard?.statusIn && !guard.statusIn.includes(current.status)) throw new ConflictError('status')
      if (guard?.expectedVersion !== undefined && (current.version ?? 0) !== guard.expectedVersion) throw new ConflictError('stale')
      const next = applyPatch(current, patch)
      requests.set(id, next)
      writes.push({ op: 'update', table: 'request', id, patch })
      return next
    },
    async requestsByThread(threadId) {
      return [...requests.values()].filter((r) => r.gmailThreadId === threadId && threadId !== '')
    },
    async requestsByUser(userId, opts = {}) {
      const rows = [...requests.values()]
        .filter((r) => r.userId === userId && (!opts.status || r.status === opts.status))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      return opts.limit === undefined ? rows : rows.slice(0, opts.limit)
    },
    async requestsByStatus(status: SpotRequestStatus, limit) {
      const rows = [...requests.values()].filter((r) => r.status === status)
      return limit === undefined ? rows : rows.slice(0, limit)
    },
    async deleteRequest(id) {
      requests.delete(id)
      writes.push({ op: 'delete', table: 'request', id })
    },

    async getCustomer(id) {
      return customers.get(id) ?? null
    },
    async getQuote(id) {
      return quotes.get(id) ?? null
    },
    async getUserProfile(id) {
      return profiles.get(id) ?? null
    },
    async getTmsSettings() {
      return tmsSettings.value
    },
    async getIntegration(provider) {
      return integrations.get(provider) ?? null
    },
    async writeAudit(entityType, entityId, action, actorEmail, changes) {
      audits.push({ entityType, entityId, action, actorEmail, changes })
      writes.push({ op: 'audit', table: 'audit', id: entityId })
    },
  }
}

// ── Gmail port ───────────────────────────────────────────────────────────────

export interface FakeMail {
  meta: GmailMessageMeta
  body: string
  attachments?: { name: string; contentType: string; size: number }[]
}

export class FakePort implements GmailPort {
  mails = new Map<string, FakeMail>()
  /** Message ids `listSince` / `listRecent` return next. */
  inbox: string[] = []
  history = '100'
  expired = false
  drafts = new Map<string, OutgoingReply & { messageId: string }>()
  sentDrafts: string[] = []
  sentReplies: OutgoingReply[] = []
  bodyCalls: string[] = []
  recentCalls = 0
  sinceCalls = 0
  failBody = new Set<string>()
  failSend = false
  failDraft = false
  private seq = 0

  add(meta: GmailMessageMeta, body: string): void {
    this.mails.set(meta.id, { meta, body })
    this.inbox.push(meta.id)
  }

  get sendCalls(): number {
    return this.sentDrafts.length + this.sentReplies.length
  }

  async profile() {
    return { emailAddress: 'rep@zz-bcat.test', historyId: this.history }
  }
  async listRecent() {
    this.recentCalls += 1
    return [...this.inbox]
  }
  async listSince() {
    this.sinceCalls += 1
    if (this.expired) return { expired: true as const }
    return { ids: [...this.inbox], historyId: this.history }
  }
  async getMetadata(id: string) {
    const mail = this.mails.get(id)
    if (!mail) throw new Error(`no mail ${id}`)
    return mail.meta
  }
  async getBody(id: string) {
    this.bodyCalls.push(id)
    if (this.failBody.has(id)) throw new Error('gmail 500')
    const mail = this.mails.get(id)
    if (!mail) throw new Error(`no mail ${id}`)
    return { text: mail.body, attachments: mail.attachments ?? [] }
  }
  async threadMessages(threadId: string) {
    return [...this.mails.values()].filter((m) => m.meta.threadId === threadId).map((m) => m.meta)
  }
  async createDraft(d: OutgoingReply) {
    if (this.failDraft) throw new Error('draft failed')
    this.seq += 1
    const draftId = `draft-${this.seq}`
    this.drafts.set(draftId, { ...d, messageId: `dm-${this.seq}` })
    return { draftId, messageId: `dm-${this.seq}` }
  }
  async updateDraft(draftId: string, d: OutgoingReply) {
    const current = this.drafts.get(draftId)
    if (!current) throw new Error('no draft')
    this.drafts.set(draftId, { ...d, messageId: current.messageId })
  }
  async getDraft(draftId: string) {
    const d = this.drafts.get(draftId)
    return d ? { exists: true, to: d.to, subject: d.subject, text: d.text } : { exists: false, to: '', subject: '', text: '' }
  }
  async sendDraft(draftId: string) {
    this.sentDrafts.push(draftId)
    return { messageId: 'sent-1' }
  }
  async sendReply(d: OutgoingReply) {
    if (this.failSend) throw new Error('send failed')
    this.sentReplies.push(d)
    return { messageId: 'sent-2' }
  }

  /** "The rep pressed Send": the draft leaves and a SENT message appears in the thread. */
  repSends(draftId: string, at: number): void {
    const d = this.drafts.get(draftId)
    if (!d) throw new Error('no draft')
    this.drafts.delete(draftId)
    const meta: GmailMessageMeta = {
      id: d.messageId, threadId: d.threadId ?? `thr-${d.messageId}`, internalDate: String(at), from: 'me', to: [d.to], cc: [],
      replyTo: null, subject: d.subject, messageId: `<${d.messageId}@x>`, inReplyTo: d.inReplyTo, references: d.references,
      snippet: d.text.slice(0, 80), labelIds: ['SENT'], headers: {},
    }
    this.mails.set(meta.id, { meta, body: d.text })
  }
}

// ── Model ────────────────────────────────────────────────────────────────────

export function emptyRaw(over: Partial<RawSpotModelOutput> = {}): RawSpotModelOutput {
  return {
    kind: 'NOT_A_REQUEST', confidence: 'high', reason: 'test', customerName: null, contactName: null, contactPhone: null,
    stops: [], pickupDate: null, deliveryDate: null, equipment: null, lengthFt: null, mode: null, weightLbs: null, pieces: null,
    commodity: null, temperatureF: null, hazmat: null, accessorials: [], targetRateDollars: null, notes: null, lowConfidence: [],
    ...over,
  } as RawSpotModelOutput
}

export function requestRaw(over: Partial<RawSpotModelOutput> = {}): RawSpotModelOutput {
  return emptyRaw({
    kind: 'QUOTE_REQUEST',
    stops: [
      { type: 'PICKUP', name: null, city: 'Chicago', state: 'IL', zip: null, dateStr: null, time: null },
      { type: 'DELIVERY', name: null, city: 'Dallas', state: 'TX', zip: null, dateStr: null, time: null },
    ],
    pickupDate: '2026-11-06',
    equipment: 'dry van',
    mode: 'FTL',
    weightLbs: 38000,
    ...over,
  } as Partial<RawSpotModelOutput>)
}

export interface ScriptedModel extends SpotModel {
  classifyCalls: Array<{ subject: string | null; body: string }>
  intentCalls: number
  answer: (call: { subject: string | null; fromEmail: string | null; body: string }) => RawSpotModelOutput | Error
  intent: () => 'ACCEPT' | 'DECLINE' | 'COUNTER' | 'QUESTION' | 'OTHER' | Error
}

export function scriptedModel(): ScriptedModel {
  const model: ScriptedModel = {
    classifyCalls: [],
    intentCalls: 0,
    answer: () => requestRaw(),
    intent: () => 'ACCEPT',
    async classify(input) {
      model.classifyCalls.push({ subject: input.subject, body: input.body })
      const out = model.answer({ subject: input.subject, fromEmail: input.fromEmail, body: input.body })
      if (out instanceof Error) throw out
      return { output: out, inputTokens: 1, outputTokens: 1 }
    },
    async replyIntent() {
      model.intentCalls += 1
      const out = model.intent()
      if (out instanceof Error) throw out
      return out
    },
  }
  return model
}

// ── CRM / OAuth / sim ────────────────────────────────────────────────────────

export interface FakeCrm extends CrmPort {
  activities: Array<Parameters<CrmPort['addSystemActivity']>[0]>
  contacts: Array<Parameters<CrmPort['upsertContact']>[0]>
  senders: Map<string, SenderMatch>
  purged: string[]
}

export function fakeCrm(): FakeCrm {
  const crm: FakeCrm = {
    activities: [], contacts: [], senders: new Map(), purged: [],
    async upsertContact(input) {
      crm.contacts.push(input)
      return { id: input.email, customerId: input.customerId ?? null }
    },
    async addSystemActivity(input) {
      crm.activities.push(input)
    },
    async lookupSender(address) {
      return crm.senders.get(address.toLowerCase()) ?? { how: 'NONE', candidates: [] }
    },
    async purgeEmailSubjects(ownerId) {
      crm.purged.push(ownerId)
      return 0
    },
  }
  return crm
}

export interface FakeOAuth extends OAuthPort {
  tokens: Map<string, { refreshToken: string; scope: string; googleEmail: string; obtainedAt: string }>
  revoked: string[]
  exchange: { refreshToken: string | null; accessToken: string; scope: string; idToken: string | null }
  identity: { email: string; emailVerified: boolean; hd: string | null }
  stateCounter: number
  client: { clientId: string; clientSecret: string; allowedDomain: string } | null
}

export function fakeOAuth(): FakeOAuth {
  const o: FakeOAuth = {
    tokens: new Map(), revoked: [], stateCounter: 0,
    client: { clientId: 'cid', clientSecret: 'csecret', allowedDomain: '' },
    exchange: { refreshToken: 'rt-secret-value', accessToken: 'at', scope: 'openid email gmail.readonly gmail.compose', idToken: 'x.y.z' },
    identity: { email: 'rep@zz-bcat.test', emailVerified: true, hd: 'zz-bcat.test' },
    async readClient() {
      return o.client
    },
    newState() {
      o.stateCounter += 1
      return `state-${o.stateCounter}`
    },
    buildAuthUrl: (x) => `https://accounts.example/auth?state=${x.state}&login_hint=${x.loginHint}`,
    async exchangeCode() {
      return o.exchange
    },
    parseIdToken: () => o.identity,
    hasRequiredScopes: (scope) => scope.includes('gmail.readonly') && scope.includes('gmail.compose'),
    redirectUriAllowed: (uri, origins) => origins.some((origin) => uri === `${origin}/tms/rates/spot/callback`),
    async revoke(token) {
      o.revoked.push(token)
    },
    async putToken(userId, rec) {
      o.tokens.set(userId, rec)
    },
    async getToken(userId) {
      return o.tokens.get(userId) ?? null
    },
    async deleteToken(userId) {
      o.tokens.delete(userId)
    },
  }
  return o
}

export interface FakeSim extends SimPorts {
  injected: Array<{ userId: string; id?: string }>
  marked: string[]
  resets: string[]
}

export function fakeSim(): FakeSim {
  const sim: FakeSim = {
    injected: [], marked: [], resets: [],
    async inject(userId, msg) {
      sim.injected.push({ userId, id: msg.id })
      return { id: msg.id ?? 'sim-1' }
    },
    async markSent(_userId, draftId) {
      sim.marked.push(draftId)
      return { messageId: 'm' }
    },
    async reset(userId) {
      sim.resets.push(userId)
      return { deleted: 0 }
    },
    async purgeTest() {
      return { deleted: 0 }
    },
  }
  return sim
}

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface TestRig {
  deps: SpotDeps
  store: MemoryStore
  port: FakePort
  model: ScriptedModel
  crm: FakeCrm
  oauth: FakeOAuth
  sim: FakeSim
  doorCalls: SpotAutoQuoteEvent[]
  clock: { now: Date }
  setDoor(fn: (e: SpotAutoQuoteEvent) => SpotAutoQuoteResult | Error): void
}

export const REP_ID = 'rep-1'
export const REP_EMAIL = 'rep@zz-bcat.test'

export function connectedRow(over: Partial<GmailConnectionRecord> = {}): GmailConnectionRecord {
  return {
    id: REP_ID, userEmail: REP_EMAIL, mode: 'GOOGLE', status: 'CONNECTED', googleEmail: REP_EMAIL,
    historyId: '50', settings: undefined, version: 1, ...over,
  } as GmailConnectionRecord
}

export function makeRig(opts: { dev?: boolean; aiAgents?: AiAgentsSettings | null } = {}): TestRig {
  const clock = { now: new Date('2026-11-04T18:00:00Z') }
  const store = memoryStore(() => clock.now)
  const port = new FakePort()
  const model = scriptedModel()
  const crm = fakeCrm()
  const oauth = fakeOAuth()
  const sim = fakeSim()
  const doorCalls: SpotAutoQuoteEvent[] = []
  let door: (e: SpotAutoQuoteEvent) => SpotAutoQuoteResult | Error = () => ({ ok: false, reasons: ['PRICE_STUB'] })
  if (opts.aiAgents) store.tmsSettings.value = { id: 'default', aiAgents: opts.aiAgents }
  const deps: SpotDeps = {
    store, crm, model, oauth, sim,
    portFor: () => port,
    async door(event) {
      doorCalls.push(event)
      const out = door(event)
      if (out instanceof Error) throw out
      return out
    },
    async providerModes() {
      return { gmail: oauth.client ? 'LIVE' : 'STUB', dat: 'STUB' }
    },
    now: () => clock.now,
    devStack: opts.dev ?? false,
    portalOrigins: ['https://ops.zz-bcat.test'],
    portalOrigin: 'https://ops.zz-bcat.test',
    ownDomains: ['zz-bcat.test'],
  }
  return { deps, store, port, model, crm, oauth, sim, doorCalls, clock, setDoor: (fn) => { door = fn } }
}

export function identityOf(userId: string, email: string, groups: string[] = ['page-quotes']): {
  sub: string
  username: string
  claims: Record<string, unknown>
} {
  return { sub: `sub-${userId}`, username: userId, claims: { email, 'cognito:groups': groups } }
}
