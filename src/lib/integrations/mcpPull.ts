/**
 * "Pull all monitored carriers" and the ongoing CarriersChanges poll.
 *
 * MyCarrierPackets is the source of truth for a carrier's compliance profile; this engine
 * walks MCP's monitored list, matches each carrier to a Carrier row (MC, then DOT, then
 * normalised name), writes what MCP says, and audits exactly what it filled and overwrote.
 * It is storage-agnostic: `McpPullDeps` is the Lambda's tables, the tests' in-memory fakes.
 *
 * - Resumable: a slice stops at its budget / lookup cap / a rate limit and persists
 *   `state.cursor`; the next slice resumes there. Idempotent: a re-run writes nothing a
 *   carrier already says, apart from the sync stamp.
 * - Never invites. Lookup and write only.
 */
import { McpApiError } from './mcpAdapter'
import { addToIndex, auditChanges, buildCarrierIndex, mapProfileToCarrier, matchCarrier, mcKey, dotKey } from './mcpProfile'
import type { McpContact, McpPayment, McpProfile, MatchedBy } from './mcpProfile'
import { normalizeName as carrierKey } from '../tmsDirectory'
import { mcpCarrierStatusPatch } from './mcpCarrierStatus'

export type TaxIdOutcome = 'SET' | 'UNCHANGED' | 'DUPLICATE' | 'INVALID'

type Row = Record<string, unknown>

export const MCP_PULL_ACTOR = 'mcp-sync'
export const MIN_CHANGES_INTERVAL_MS = 4 * 60_000
const LIST_PAGE_SIZE = 250
const CHANGES_PAGE_SIZE = 250
const UNMATCHED_CAP = 200

export interface McpPullCounts {
  created: number
  updated: number
  unchanged: number
  /** MCP carriers with no Carrier row that were not created (setting off, or an ambiguous name). */
  unmatchedMcp: number
  /** Monitored by MCP but GetCarrierData had nothing. */
  noData: number
  errors: number
  conflicts: number
}

export interface McpUnmatched {
  id?: string
  name?: string
  mc?: string
  dot?: string
  reason?: string
}

export interface McpPullState {
  runId: string
  /** BACKFILL = walking the monitored list; DONE = finished; ERROR = stopped on a credential problem. */
  status: 'RUNNING' | 'PARTIAL' | 'DONE' | 'ERROR'
  startedAt: string
  startedBy: string
  lastSliceAt: string | null
  finishedAt: string | null
  cursor: { page: number; index: number } | null
  totalPages: number | null
  counts: McpPullCounts
  lastError: string | null
  /** MCP carriers that matched nothing and were not created. Capped. */
  unmatchedMcp: McpUnmatched[]
  /** Carrier rows MCP does not monitor, computed when the list is exhausted. Capped list, full count. */
  unmatchedBcat: McpUnmatched[]
  unmatchedBcatCount: number | null
  /** Where the ongoing CarriersChanges poll resumes, and when it last ran (4-minute floor). */
  changesFrom: string | null
  lastChangesAt: string | null
  changesCounts: McpPullCounts | null
}

export function emptyCounts(): McpPullCounts {
  return { created: 0, updated: 0, unchanged: 0, unmatchedMcp: 0, noData: 0, errors: 0, conflicts: 0 }
}

export function newPullState(runId: string, startedBy: string, now: string, carry?: Partial<McpPullState>): McpPullState {
  return {
    runId, status: 'RUNNING', startedAt: now, startedBy, lastSliceAt: null, finishedAt: null,
    cursor: { page: 1, index: 0 }, totalPages: null, counts: emptyCounts(), lastError: null,
    unmatchedMcp: [], unmatchedBcat: [], unmatchedBcatCount: null,
    changesFrom: carry?.changesFrom ?? null, lastChangesAt: carry?.lastChangesAt ?? null, changesCounts: carry?.changesCounts ?? null,
  }
}

export interface McpPullDeps {
  loadCarriers(): Promise<Row[]>
  /** CAS write of changed fields; CONFLICT when `updatedAt` moved. */
  writeCarrier(carrier: Row, patch: Row): Promise<'WRITTEN' | 'CONFLICT'>
  reloadCarrier(id: string): Promise<Row | null>
  createCarrier(row: Row): Promise<void>
  loadContacts(carrierId: string): Promise<Row[]>
  putContact(row: Row): Promise<void>
  updateContact(id: string, patch: Row): Promise<void>
  loadPayments(carrierId: string): Promise<Row[]>
  putPayment(row: Row): Promise<void>
  updatePayment(id: string, patch: Row): Promise<void>
  audit(entry: { entityId: string; action: string; changes: Record<string, unknown> }): Promise<void>
  listMonitored(page: number, pageSize: number): Promise<{ entries: Array<{ dotNumber?: string; docketNumber?: string }>; totalPages: number }>
  fetchProfile(ref: { mcNumber?: string; dotNumber?: string }): Promise<McpProfile | null>
  listChanges(range: { from: Date; to: Date }, page: number, pageSize: number): Promise<{ profiles: McpProfile[]; totalPages: number }>
  listCompleted(range: { from: Date; to: Date }): Promise<Array<{ dotNumber: string; docketNumber?: string }>>
  newId(): string
  sleep(ms: number): Promise<void>
  nowMs(): number
  /** Step AM. Called after MCP flipped a carrier's status, so assignments waiting on setup can advance. */
  carrierStatusChanged?(carrierId: string, status: string): Promise<void>
  /**
   * Hands MCP's W-9 tax id to the encrypted vault (`_shared/taxVault.ts`); resolves to what happened, never the value.
   * Absent = the pull has no vault and the tax id is dropped on the floor, never written to the Carrier row.
   */
  setTaxId?(carrierId: string, value: string): Promise<TaxIdOutcome>
}

export interface McpPullOptions {
  createUnmatched: boolean
  maxCarriers?: number
  deadlineMs?: number
  minIntervalMs?: number
}

// ── One carrier ──────────────────────────────────────────────────────────────

type Outcome = 'UPDATED' | 'UNCHANGED' | 'CONFLICT'

const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '')

/**
 * MCP's tax id into the vault, skipped when the row's mirror already shows the same last four.
 * A thrown error is reported as FAILED with no message: nothing near a tax id may carry its text.
 */
async function syncTaxId(deps: McpPullDeps, carrierId: string, row: Row, profile: McpProfile): Promise<TaxIdOutcome | 'FAILED' | null> {
  if (!profile.taxId || !deps.setTaxId) return null
  if (typeof row.taxIdLast4 === 'string' && row.taxIdLast4 === digits(profile.taxId).slice(-4)) return null
  try {
    return await deps.setTaxId(carrierId, profile.taxId)
  } catch {
    return 'FAILED'
  }
}

async function syncContacts(deps: McpPullDeps, carrierId: string, wanted: McpContact[], now: string, hadPrimary: boolean): Promise<{ created: number; updated: number }> {
  if (wanted.length === 0) return { created: 0, updated: 0 }
  const existing = await deps.loadContacts(carrierId)
  let created = 0
  let updated = 0
  let primaryTaken = hadPrimary || existing.some((c) => c.isPrimary === true)
  for (const c of wanted) {
    const hit = existing.find((e) => (c.email && String(e.email ?? '').toLowerCase() === c.email) || (!c.email && String(e.name ?? '').toLowerCase() === c.name.toLowerCase() && digits(e.phone) === digits(c.phone)))
    if (!hit) {
      const primary = !primaryTaken && c.types.includes('DISPATCH')
      if (primary) primaryTaken = true
      await deps.putContact({
        id: deps.newId(), __typename: 'CarrierContact', carrierId, name: c.name, types: c.types,
        ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}),
        isPrimary: primary, rateConRecipient: false, active: true,
        createdBy: MCP_PULL_ACTOR, updatedBy: MCP_PULL_ACTOR, createdAt: now, updatedAt: now,
      })
      created++
      continue
    }
    // MCP wins on what it states; types are unioned so a hand-added hat is not lost.
    const types = [...new Set([...(Array.isArray(hit.types) ? (hit.types as string[]) : []), ...c.types])]
    const patch: Row = {}
    if (c.name && hit.name !== c.name) patch.name = c.name
    if (c.phone && hit.phone !== c.phone) patch.phone = c.phone
    if (c.email && hit.email !== c.email) patch.email = c.email
    if (JSON.stringify(types) !== JSON.stringify(hit.types ?? [])) patch.types = types
    if (Object.keys(patch).length > 0) {
      await deps.updateContact(String(hit.id), { ...patch, updatedBy: MCP_PULL_ACTOR, updatedAt: now })
      updated++
    }
  }
  return { created, updated }
}

async function syncPayment(deps: McpPullDeps, carrierId: string, wanted: McpPayment | undefined, now: string): Promise<'CREATED' | 'UPDATED' | null> {
  if (!wanted) return null
  const existing = await deps.loadPayments(carrierId)
  const mine = existing.find((p) => p.source === 'MCP')
  const fields: Row = { ...wanted, status: 'ACTIVE', isPreferred: true, source: 'MCP' }
  if (mine) {
    const patch: Row = {}
    for (const [k, v] of Object.entries(fields)) if (JSON.stringify(mine[k] ?? null) !== JSON.stringify(v)) patch[k] = v
    if (Object.keys(patch).length === 0) return null
    await deps.updatePayment(String(mine.id), { ...patch, updatedBy: MCP_PULL_ACTOR, updatedAt: now })
    return 'UPDATED'
  }
  // MCP wins: its method becomes the preferred one; a hand-typed method stays on file, no longer preferred.
  for (const other of existing) {
    if (other.isPreferred === true) await deps.updatePayment(String(other.id), { isPreferred: false, updatedBy: MCP_PULL_ACTOR, updatedAt: now })
  }
  await deps.putPayment({ id: deps.newId(), __typename: 'CarrierPaymentMethod', carrierId, ...fields, createdBy: MCP_PULL_ACTOR, updatedBy: MCP_PULL_ACTOR, createdAt: now, updatedAt: now })
  return 'CREATED'
}

/** Apply one profile to one Carrier row: carrier fields (CAS), contacts, payment method, audit. */
export async function applyProfileToCarrier(
  deps: McpPullDeps,
  carrier: Row,
  profile: McpProfile,
  ctx: { runId: string; matchedBy: MatchedBy | 'CREATED'; now: string; monitored?: boolean },
  /** Changes feeds carry no contacts or payment; only a full GetCarrierData does. */
): Promise<Outcome> {
  let current: Row | null = carrier
  let outcome: Outcome = 'UNCHANGED'
  let changes: ReturnType<typeof mapProfileToCarrier>['changes'] = {}
  for (let attempt = 0; attempt < 2 && current; attempt++) {
    const mapped = mapProfileToCarrier(current, profile)
    // Step AM. MCP drives Carrier.status: packet complete + monitored => ACTIVE, a lapse => INACTIVE.
    const statusPatch = mcpCarrierStatusPatch({ ...current, ...mapped.patch }, ctx.now, { monitored: ctx.monitored === true })
    if (statusPatch.status !== undefined) {
      mapped.changes.status = { before: current.status ?? null, after: statusPatch.status, kind: 'OVERWROTE' }
    }
    mapped.patch = { ...mapped.patch, ...statusPatch }
    changes = mapped.changes
    const stamp = current.mcpSyncRunId === ctx.runId ? {} : { mcpSyncedAt: ctx.now, mcpSyncRunId: ctx.runId }
    const patch: Row = { ...mapped.patch, ...stamp }
    if (Object.keys(patch).length === 0) { outcome = 'UNCHANGED'; break }
    const written = await deps.writeCarrier(current, patch)
    if (written === 'WRITTEN') {
      outcome = Object.keys(mapped.patch).length > 0 ? 'UPDATED' : 'UNCHANGED'
      if (typeof patch.status === 'string') await deps.carrierStatusChanged?.(String(carrier.id), patch.status)
      break
    }
    outcome = 'CONFLICT'
    current = await deps.reloadCarrier(String(carrier.id))
  }
  if (outcome === 'CONFLICT') return outcome

  const id = String(carrier.id)
  const contacts = await syncContacts(deps, id, profile.contacts, ctx.now, false)
  const payment = await syncPayment(deps, id, profile.payment, ctx.now)
  const taxId = await syncTaxId(deps, id, carrier, profile)
  const touched = Object.keys(changes).length > 0 || contacts.created > 0 || contacts.updated > 0 || payment !== null || taxId === 'SET'
  if (touched) {
    await deps.audit({
      entityId: id,
      action: 'MCP_PULL',
      changes: { source: 'MYCARRIERPACKETS', runId: ctx.runId, matchedBy: ctx.matchedBy, fields: auditChanges(changes), contacts, payment, ...(taxId ? { taxId } : {}) },
    })
  }
  return touched && outcome === 'UNCHANGED' ? 'UPDATED' : outcome
}

function newCarrierRow(deps: McpPullDeps, profile: McpProfile, runId: string, now: string): Row {
  const { patch } = mapProfileToCarrier({}, profile)
  const row: Row = {
    id: deps.newId(), __typename: 'Carrier',
    ...patch,
    name: profile.legalName ?? `MC ${profile.carrier.mcNumber || profile.carrier.dotNumber}`,
    normalizedName: carrierKey(profile.legalName ?? ''),
    ...(profile.carrier.mcNumber ? { mcNumber: profile.carrier.mcNumber } : {}),
    // Step AM. PENDING until MCP says the packet is complete and the carrier is monitored; then (and only then) ACTIVE.
    status: 'PENDING', version: 1,
    mcpSyncedAt: now, mcpSyncRunId: runId,
    createdBy: MCP_PULL_ACTOR, updatedBy: MCP_PULL_ACTOR, createdAt: now, updatedAt: now,
  }
  return { ...row, ...mcpCarrierStatusPatch(row, now) }
}

// ── A slice of the backfill ───────────────────────────────────────────────────

const refLabel = (p: McpProfile): McpUnmatched => ({ name: p.legalName, mc: p.carrier.mcNumber || undefined, dot: p.carrier.dotNumber })

/**
 * Process one carrier's profile: match, apply or create. Shared by the backfill, the changes
 * poll and the single-carrier pull so all three write identically.
 */
export async function ingestProfile(
  deps: McpPullDeps,
  index: ReturnType<typeof buildCarrierIndex>,
  profile: McpProfile,
  counts: McpPullCounts,
  unmatched: McpUnmatched[],
  ctx: { runId: string; now: string; createUnmatched: boolean; /** Came from MCP's monitored list: the carrier is Active with us. */ monitored?: boolean },
  touched: Set<string>,
): Promise<void> {
  const match = matchCarrier(index, profile)
  if (!match) {
    // A changes-feed item has no name or packet; creating a carrier from it would be a stub.
    if (!ctx.createUnmatched || !profile.legalName) {
      counts.unmatchedMcp++
      if (unmatched.length < UNMATCHED_CAP) unmatched.push({ ...refLabel(profile), reason: ctx.createUnmatched ? 'no legal name' : 'creation off' })
      return
    }
    const row = newCarrierRow(deps, profile, ctx.runId, ctx.now)
    await deps.createCarrier(row)
    addToIndex(index, row)
    touched.add(String(row.id))
    const contacts = await syncContacts(deps, String(row.id), profile.contacts, ctx.now, false)
    const payment = await syncPayment(deps, String(row.id), profile.payment, ctx.now)
    const taxId = await syncTaxId(deps, String(row.id), row, profile)
    await deps.audit({ entityId: String(row.id), action: 'MCP_CREATE', changes: { source: 'MYCARRIERPACKETS', runId: ctx.runId, matchedBy: 'CREATED', fields: auditChanges(mapProfileToCarrier({}, profile).changes), contacts, payment, ...(taxId ? { taxId } : {}) } })
    counts.created++
    return
  }
  for (const row of match.rows) {
    touched.add(String(row.id))
    const outcome = await applyProfileToCarrier(deps, row, profile, { runId: ctx.runId, matchedBy: match.by, now: ctx.now, monitored: ctx.monitored === true })
    if (outcome === 'UPDATED') counts.updated++
    else if (outcome === 'CONFLICT') counts.conflicts++
    else counts.unchanged++
  }
}

/** Walk the monitored list from `state.cursor` until the budget runs out or the list ends. */
export async function runBackfillSlice(deps: McpPullDeps, state: McpPullState, options: McpPullOptions): Promise<McpPullState> {
  const next: McpPullState = { ...state, counts: { ...state.counts }, unmatchedMcp: [...state.unmatchedMcp], status: 'RUNNING', lastError: null }
  const minInterval = options.minIntervalMs ?? 250
  const maxCarriers = options.maxCarriers ?? 400
  const carriers = await deps.loadCarriers()
  const index = buildCarrierIndex(carriers)
  const touched = new Set<string>()
  let looked = 0
  let cursor = next.cursor ?? { page: 1, index: 0 }

  try {
    for (;;) {
      const { entries, totalPages } = await deps.listMonitored(cursor.page, LIST_PAGE_SIZE)
      next.totalPages = totalPages
      for (let i = cursor.index; i < entries.length; i++) {
        if (looked >= maxCarriers || (options.deadlineMs !== undefined && deps.nowMs() >= options.deadlineMs)) {
          next.cursor = { page: cursor.page, index: i }
          next.status = 'PARTIAL'
          next.lastSliceAt = new Date(deps.nowMs()).toISOString()
          return next
        }
        if (looked > 0) await deps.sleep(minInterval)
        const entry = entries[i]!
        let profile: McpProfile | null
        try {
          profile = await deps.fetchProfile({ mcNumber: entry.docketNumber, dotNumber: entry.dotNumber })
        } catch (err) {
          if (err instanceof McpApiError && (err.kind === 'RATE_LIMIT' || err.kind === 'AUTH')) throw err
          next.counts.errors++
          next.lastError = err instanceof Error ? err.message.slice(0, 300) : 'Lookup failed'
          cursor = { page: cursor.page, index: i + 1 }
          next.cursor = cursor
          looked++
          continue
        }
        looked++
        if (!profile) next.counts.noData++
        else {
          try {
            await ingestProfile(deps, index, profile, next.counts, next.unmatchedMcp, { runId: next.runId, now: new Date(deps.nowMs()).toISOString(), createUnmatched: options.createUnmatched, monitored: true }, touched)
          } catch (err) {
            next.counts.errors++
            next.lastError = err instanceof Error ? err.message.slice(0, 300) : 'Write failed'
          }
        }
        cursor = { page: cursor.page, index: i + 1 }
        next.cursor = cursor
      }
      if (cursor.page >= totalPages || entries.length === 0) break
      cursor = { page: cursor.page + 1, index: 0 }
      next.cursor = cursor
    }
  } catch (err) {
    next.status = err instanceof McpApiError && err.kind === 'AUTH' ? 'ERROR' : 'PARTIAL'
    next.lastError = err instanceof McpApiError && err.kind === 'RATE_LIMIT' ? 'MyCarrierPackets is rate limiting; the run will resume.' : err instanceof Error ? err.message.slice(0, 300) : 'Pull failed'
    next.lastSliceAt = new Date(deps.nowMs()).toISOString()
    return next
  }

  // List exhausted: every carrier whose stamp is not this run's was not seen in MCP's monitored list.
  const fresh = await deps.loadCarriers()
  const missing = fresh.filter((r) => r.mcpSyncRunId !== next.runId && !touched.has(String(r.id)))
  next.unmatchedBcatCount = missing.length
  next.unmatchedBcat = missing.slice(0, UNMATCHED_CAP).map((r) => ({ id: String(r.id), name: String(r.name ?? ''), mc: mcKey(r.mcNumber) ?? undefined, dot: dotKey(r.dotNumber) ?? undefined }))
  next.status = 'DONE'
  next.cursor = null
  next.finishedAt = new Date(deps.nowMs()).toISOString()
  next.lastSliceAt = next.finishedAt
  next.changesFrom = next.startedAt
  return next
}

// ── Ongoing: CarriersChanges + CompletedPackets ───────────────────────────────

/**
 * One poll of what changed since `state.changesFrom`, at most every 4 minutes (MCP's floor).
 * Applies insurance / authority / safety / risk changes, and pulls the full profile of every
 * carrier whose packet just completed so its W-9, payment method and contacts arrive.
 */
export async function runChangesPoll(deps: McpPullDeps, state: McpPullState, options: McpPullOptions): Promise<McpPullState> {
  const nowMs = deps.nowMs()
  if (!state.changesFrom || (state.lastChangesAt && nowMs - Date.parse(state.lastChangesAt) < MIN_CHANGES_INTERVAL_MS)) return state
  const next: McpPullState = { ...state, lastError: null }
  const counts = emptyCounts()
  const unmatched: McpUnmatched[] = []
  const range = { from: new Date(state.changesFrom), to: new Date(nowMs) }
  const index = buildCarrierIndex(await deps.loadCarriers())
  const touched = new Set<string>()
  const ctx = { runId: state.runId, now: range.to.toISOString(), createUnmatched: false }
  try {
    for (let page = 1; ; page++) {
      const { profiles, totalPages } = await deps.listChanges(range, page, CHANGES_PAGE_SIZE)
      for (const profile of profiles) await ingestProfile(deps, index, profile, counts, unmatched, ctx, touched)
      if (page >= totalPages || profiles.length === 0) break
    }
    // Completed packets: the full profile, because a changes item has no packet, W-9 or payment.
    for (const done of await deps.listCompleted(range)) {
      const profile = await deps.fetchProfile({ mcNumber: done.docketNumber, dotNumber: done.dotNumber })
      if (profile) await ingestProfile(deps, index, profile, counts, unmatched, { ...ctx, createUnmatched: options.createUnmatched }, touched)
      await deps.sleep(options.minIntervalMs ?? 250)
    }
    next.changesFrom = range.to.toISOString()
  } catch (err) {
    counts.errors++
    next.lastError = err instanceof McpApiError && err.kind === 'RATE_LIMIT' ? 'MyCarrierPackets is rate limiting; will retry.' : err instanceof Error ? err.message.slice(0, 300) : 'Changes poll failed'
  }
  next.lastChangesAt = range.to.toISOString()
  next.changesCounts = counts
  return next
}

/** One carrier, by id: the "sync this carrier" button and the per-carrier IMPORT_BATCH. */
export async function pullOneCarrier(
  deps: McpPullDeps,
  carrierId: string,
  runId: string,
): Promise<'SYNCED' | 'NO_PACKET'> {
  const carrier = await deps.reloadCarrier(carrierId)
  if (!carrier) return 'NO_PACKET'
  const ref = { mcNumber: typeof carrier.mcNumber === 'string' && carrier.mcNumber.trim() ? carrier.mcNumber : undefined, dotNumber: typeof carrier.dotNumber === 'string' && carrier.dotNumber.trim() ? carrier.dotNumber : undefined }
  if (!ref.mcNumber && !ref.dotNumber) return 'NO_PACKET'
  const profile = await deps.fetchProfile(ref)
  if (!profile) return 'NO_PACKET'
  const now = new Date(deps.nowMs()).toISOString()
  const outcome = await applyProfileToCarrier(deps, carrier, profile, { runId, matchedBy: 'MC', now })
  if (outcome === 'CONFLICT') throw new Error('The carrier changed while it was being synced; try again.')
  return 'SYNCED'
}

export interface AddCarrierResult {
  result: 'CREATED' | 'EXISTS' | 'NO_MCP_RECORD' | 'NO_NAME'
  carrierId?: string
  matchedBy?: MatchedBy
}

/**
 * "Add to carriers" from the Find & Invite page: fetch the full MCP profile and, when no
 * Carrier row matches it (MC, then DOT, then an exact name), create one pre-filled from MCP
 * through the same row + contacts + payment + `MCP_CREATE` audit the backfill uses. A row that
 * already exists is left exactly as it is: the caller shows it, it does not rewrite it.
 */
export async function addCarrierFromMcp(
  deps: McpPullDeps,
  ref: { mcNumber?: string; dotNumber?: string },
  runId: string,
): Promise<AddCarrierResult> {
  const profile = await deps.fetchProfile(ref)
  if (!profile) return { result: 'NO_MCP_RECORD' }
  const index = buildCarrierIndex(await deps.loadCarriers())
  const match = matchCarrier(index, profile)
  if (match) return { result: 'EXISTS', carrierId: String(match.rows[0]!.id), matchedBy: match.by }
  if (!profile.legalName) return { result: 'NO_NAME' }
  const counts = emptyCounts()
  const touched = new Set<string>()
  await ingestProfile(deps, index, profile, counts, [], { runId, now: new Date(deps.nowMs()).toISOString(), createUnmatched: true }, touched)
  return { result: 'CREATED', carrierId: [...touched][0] }
}
