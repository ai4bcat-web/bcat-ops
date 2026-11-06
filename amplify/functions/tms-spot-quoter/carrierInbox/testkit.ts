/**
 * Test doubles for the carrier inbox: an in-memory store that mirrors the DynamoDB one, a
 * Gmail port, a scripted model, a recording router (`files`) that dedupes on `sourceKey` like
 * the real one, and an in-memory S3 so the REAL `simPort` can run the end-to-end path.
 * Imported only by *.test.ts.
 */
import { type CarrierInboxMailbox, type CarrierInboxMailboxState, type CarrierInboxRunDigest, type CarrierInboxState, type FileInboundOfferInput, type FileInboundOfferResult, type ResolvedCarrierInboxConfig } from '../../../../src/lib/carrierInbox/types'
import { DEFAULT_CARRIER_INBOX_CONFIG } from '../../../../src/lib/carrierInbox/settings'
import type { RawInboundModelOutput } from '../../../../src/lib/carrierInbox/normalize'
import type { AiAgentsSettings } from '../../../../src/types/tms'
import { simDevExtraction, simInject, simPort, simPurgeTest, simReset, type SimS3 } from '../../_shared/gmail/simPort'
import { ConflictError } from '../store'
import { fakeOAuth, FakePort, type FakeOAuth } from '../testkit'
import type { CarrierInboxDeps } from './deps'
import { csUserId } from './deps'
import type { CarrierInboxFiles } from './files'
import type { CarrierInboxModel } from './model'
import { RUN_DIGESTS_KEPT, emptyMailboxState, emptyState, type CarrierInboxStore } from './store'

export interface MemoryCsStore extends CarrierInboxStore {
  config: { value: ResolvedCarrierInboxConfig | null }
  state: { value: CarrierInboxState }
  /** Every mutating call, by name. */
  writes: string[]
}

export function memoryCsStore(): MemoryCsStore {
  const config: MemoryCsStore['config'] = { value: null }
  const state: MemoryCsStore['state'] = { value: emptyState() }
  const writes: string[] = []
  const box = (id: string): CarrierInboxMailboxState => (state.value.mailboxes[id] ??= emptyMailboxState())
  return {
    config, state, writes,
    async getConfigRaw() {
      return config.value
    },
    async putConfig(next, expectedVersion) {
      const current = config.value?.version ?? 0
      if (current !== expectedVersion) throw new ConflictError('stale')
      config.value = { ...next, version: expectedVersion + 1 }
      writes.push('putConfig')
      return config.value
    },
    async getState() {
      return JSON.parse(JSON.stringify(state.value)) as CarrierInboxState
    },
    async patchMailboxState(id, patch) {
      Object.assign(box(id), Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))
      writes.push(`patchMailboxState:${id}`)
    },
    async claimMailbox(id, startedAt, staleBefore) {
      const m = box(id)
      if (m.runningAt && m.runningAt >= staleBefore) return false
      m.runningAt = startedAt
      return true
    },
    async removeMailboxState(id) {
      delete state.value.mailboxes[id]
    },
    async bumpModelCalls(day, n) {
      if (n <= 0) return
      if (state.value.modelCallsDay === day) state.value.modelCallsToday += n
      else Object.assign(state.value, { modelCallsDay: day, modelCallsToday: n })
      writes.push('bumpModelCalls')
    },
    async patchVoice(patch) {
      Object.assign(state.value.voice, patch)
      writes.push('patchVoice')
    },
    async pushRunDigest(d: CarrierInboxRunDigest) {
      state.value.runs = [d, ...state.value.runs].slice(0, RUN_DIGESTS_KEPT)
    },
  }
}

export type MemoryS3 = SimS3 & { map: Map<string, string> }

export function memoryS3(): MemoryS3 {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, b) => void map.set(k, b),
    del: async (k) => void map.delete(k),
    list: async (p) => [...map.keys()].filter((k) => k.startsWith(p)),
  }
}

export interface ScriptedCsModel extends CarrierInboxModel {
  calls: Array<{ source: 'EMAIL' | 'CALL'; subject: string | null; body: string }>
  answer: (call: { subject: string | null; body: string }) => RawInboundModelOutput | Error
}

export function scriptedCsModel(): ScriptedCsModel {
  const model: ScriptedCsModel = {
    calls: [],
    answer: () => offerRaw(),
    async classify(input) {
      model.calls.push({ source: input.source, subject: input.subject, body: input.body })
      const out = model.answer({ subject: input.subject, body: input.body })
      if (out instanceof Error) throw out
      return { output: out, inputTokens: 1, outputTokens: 1 }
    },
  }
  return model
}

export function offerRaw(over: Partial<RawInboundModelOutput> = {}): RawInboundModelOutput {
  return {
    kind: 'OFFER', confidence: 'high', reason: 'test', loadRefs: ['ZZAL1001'], postingRef: null,
    originCity: null, originState: null, destCity: null, destState: null, pickupDate: null, equipment: null,
    rateDollars: 1850, ratePerMileDollars: null, availableAt: null, trucks: 1, carrierName: 'ZZ Carrier',
    mcNumber: '9900001', dotNumber: null, contactName: null, contactEmail: null, contactPhone: null,
    notes: null, lowConfidence: [],
    ...over,
  } as RawInboundModelOutput
}

export interface RecordingFiles extends CarrierInboxFiles {
  calls: FileInboundOfferInput[]
  /** Scripted failures: sourceKeys whose hand-over throws. */
  failKeys: Set<string>
  outcome: FileInboundOfferResult['outcome']
}

/** Dedupes on `sourceKey` like the router's conditional put. */
export function recordingFiles(): RecordingFiles {
  const seen = new Set<string>()
  const files: RecordingFiles = {
    calls: [], failKeys: new Set(), outcome: 'FILED',
    async fileInboundOffer(input) {
      files.calls.push(input)
      if (files.failKeys.has(input.sourceKey)) throw new Error('router throttled')
      const duplicate = seen.has(input.sourceKey)
      seen.add(input.sourceKey)
      return {
        outcome: duplicate ? 'DUPLICATE' : files.outcome, messageId: `msg:cs:${input.sourceKey}`,
        shipmentId: 'ship-1', quoteId: null, score: 0.9, how: 'LOAD_REF_SUBJECT',
      }
    },
  }
  return files
}

export const MAILBOX: CarrierInboxMailbox = {
  id: 'm1', label: 'Loads', account: 'ai4bcat@gmail.com', addresses: ['loads@zz-bcat.test'], gmailLabel: null, mode: 'GOOGLE', paused: false,
}

export interface CsRig {
  deps: CarrierInboxDeps
  store: MemoryCsStore
  port: FakePort
  model: ScriptedCsModel
  files: RecordingFiles
  oauth: FakeOAuth
  s3: MemoryS3
  audits: Array<{ entityType: string; entityId: string; action: string; changes: Record<string, unknown> }>
  clock: { now: Date }
}

export function makeCsRig(opts: { dev?: boolean; aiAgents?: AiAgentsSettings | null; mailbox?: Partial<CarrierInboxMailbox>; cfg?: Partial<ResolvedCarrierInboxConfig>; connected?: boolean } = {}): CsRig {
  const clock = { now: new Date('2026-11-04T18:00:00Z') }
  const store = memoryCsStore()
  const port = new FakePort()
  const model = scriptedCsModel()
  const files = recordingFiles()
  const oauth = fakeOAuth()
  const s3 = memoryS3()
  const audits: CsRig['audits'] = []
  const mailbox = { ...MAILBOX, ...opts.mailbox }
  store.config.value = { ...DEFAULT_CARRIER_INBOX_CONFIG, enabled: true, mailboxes: [mailbox], version: 1, ...opts.cfg }
  if (opts.connected !== false) {
    store.state.value.mailboxes[mailbox.id] = {
      ...emptyMailboxState(),
      status: mailbox.mode === 'SIMULATED' ? 'SIMULATED' : 'CONNECTED',
      historyId: '50', googleEmail: mailbox.account,
    }
  }
  const deps: CarrierInboxDeps = {
    store, model, files, oauth,
    sim: {
      inject: (userId, msg) => simInject(userId, msg, s3),
      reset: (userId) => simReset(userId, s3),
      purgeTest: (userId) => simPurgeTest(userId, s3),
    },
    simDevExtraction: (mailboxId, messageId) => simDevExtraction(csUserId(mailboxId), messageId, s3),
    portFor: (m) => (m.mode === 'SIMULATED' ? simPort(csUserId(m.id), s3, () => clock.now.getTime()) : port),
    loadAiAgents: async () => opts.aiAgents ?? null,
    loadBlacklist: async () => ({ addresses: [], keywords: [] }),
    providerModes: async () => ({ gmail: oauth.client ? 'LIVE' : 'STUB' }),
    writeAudit: async (entityType, entityId, action, _actor, changes) => void audits.push({ entityType, entityId, action, changes }),
    now: () => clock.now,
    devStack: opts.dev ?? false,
    portalOrigins: ['https://ops.zz-bcat.test'],
    ownDomains: ['zz-bcat.test'],
  }
  return { deps, store, port, model, files, oauth, s3, audits, clock }
}
