/**
 * workflow-agent — the pipeline.
 *
 * One run is one piece of inbound work: an e-mail, a vendor payable, a driver
 * submission, a provider webhook. It walks the steps its agent declares, stamps
 * each one on the row as it goes (the trace view polls every 3 s and the whole
 * point is that it shows real progress, not a spinner), and ends in exactly one
 * outcome.
 *
 * What it is NOT allowed to do is the interesting part:
 *   - it never creates a Shipment, Order, Load, Quote, Customer or Carrier. The
 *     terminal step writes a proposal onto the run and stops. A person applies
 *     it through CREATE_SHIPMENT / SAVE_QUOTE / RECORD_BILL under their own
 *     Cognito identity, which is the only door into AR.
 *   - the two exceptions are deliberate and narrow: a PENDING ShipmentDocument
 *     (a filed carrier invoice nobody has accepted) and the blanks-only merge
 *     onto a VendorPayable that `vendor-ap-extract` already did before step K.
 *   - every status change goes through `runState`. Nothing here writes
 *     `status`/`outcome` by hand, so "COMPLETED but no outcome" cannot happen.
 */
import { createHash } from 'crypto'
import { AGENTS, AGENT_KEYS, isAgent, type WorkflowAgentKey } from '../../../src/lib/workflows/agents'
import {
  beginStep,
  failRun,
  finishRun,
  nextStep,
  redactError,
  retryable,
} from '../../../src/lib/workflows/runState'
import { matchParty, domainOf, type PartyDirectory, type PartyMatch, type PartyMatchResult } from '../../../src/lib/workflows/partyMatch'
import {
  agentEnabled,
  dailyRunCapOf,
  memoryPromptFor,
  memoryRevisionsFor,
  redactForPrompt,
} from '../../../src/lib/workflows/memory'
import { tenderFromParse, type TenderModelFill } from '../../../src/lib/workflows/tenderProposal'
import { carrierBillFrom, centsFromDollars, documentFor, shipmentRefsIn } from '../../../src/lib/workflows/apProposal'
import { quoteFromEmail, type QuoteEmailParse } from '../../../src/lib/workflows/quoteProposal'
import { postingFrom, type CapacityEmailParse } from '../../../src/lib/workflows/capacityProposal'
import { consumerFor } from '../../../src/lib/workflows/webhookConsumers'
import { parseTender, type TenderPrefill } from '../../../src/lib/intakeTender'
import type { AiAgentsSettings, PartyAiMemory, WorkflowOutcome } from '../../../src/types/tms'
import { SCHEMA as RATECON_SCHEMA, blanksToNull } from '../ratecon-parser/handler'
import {
  CAPACITY_SCHEMA,
  CLASSIFY_SCHEMA,
  MODEL_ID,
  QUOTE_SCHEMA,
  TENDER_FILL_SCHEMA,
  callModel,
  emailPrompt,
  modelUsage,
  resetModelBudget,
  type ClassifyResult,
  type FileBlock,
} from './model'
import { extractFromInvoice, fileBlocks, type Attachment } from './ap/extract'
import { mergeExtraction, type Extraction, type ExtractableRow } from './ap/merge'
import {
  SHIPMENT_DOCUMENT_TABLE_NAME,
  countRunsToday,
  getIntegration,
  getObjectText,
  getRun,
  getSettings,
  getSourceRow,
  findShipmentByNumber,
  isConditionalFailure,
  loadDirectory,
  nowIso,
  putRunIfAbsent,
  putShipmentDocument,
  queryStalled,
  scanVendorPayablesNeedingExtract,
  updateRun,
  updateVendorPayable,
  writeAudit,
  type Row,
  type RunRow,
} from './store'

/** A run that has not moved in this long is not coming back. */
export const STALL_MINUTES = 10
/** The step K cap: three attachments, read in order. */
export const MAX_ATTACHMENTS = 3
/**
 * The wall-clock budget an inline re-run gets.
 *
 * RETRY_RUN and SET_RUN_PARTY re-run the pipeline inside the caller's request.
 * The Lambda has 90 s but the AppSync resolver that is waiting is capped at 30 s,
 * and the agent cannot hand the work to another invocation — it holds no
 * `lambda:InvokeFunction` grant, deliberately. So an inline re-run is given 20 s,
 * leaving the router ten for the CAS, the audit row and the reply: either the run
 * finishes and the page shows the truth, or it ends FAILED/DEADLINE, which is
 * retryable and honest, instead of a GraphQL timeout over a run still going.
 */
export const INLINE_BUDGET_MS = 20_000

export interface RunForInput {
  sourceKind: string
  sourceId: string
  inboxRole: string
  provider: string
  sourceKey?: string
}

export interface PinnedParty {
  partyKind: string
  partyId: string
}

function sha20(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

/** The dedupe key. Deterministic in the source, so a redelivery collides. */
export function runIdFor(agent: string, sourceKey: string): string {
  return `wf:${agent}:${sha20(sourceKey)}`
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') return err.name
  return ''
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The codes a thrown step is allowed to end as. Anything unrecognised is
 * INTERNAL — a run that failed for a reason nobody named is a bug to go read,
 * not a new error code invented at the throw site.
 */
export function errorCodeOf(err: unknown): string {
  const message = messageOf(err)
  if (message === 'SOURCE_MISSING') return 'SOURCE_MISSING'
  if (message === 'S3_MISSING') return 'S3_MISSING'
  if (message === 'UNSUPPORTED_ATTACHMENT') return 'UNSUPPORTED_ATTACHMENT'
  // The inline budget is spent. Its own code, because "the operator's request ran
  // out of time" is not "the model timed out" and the fix is different.
  if (message === 'DEADLINE') return 'DEADLINE'
  // The per-run model budget is spent. Reported as a refusal because that is
  // what it is from the caller's side: the model declined to answer again.
  if (message === 'MODEL_CAP') return 'MODEL_REFUSED'
  const name = errorName(err)
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(message) || /Timeout/i.test(name)) return 'MODEL_TIMEOUT'
  if (/refus|invalid_request|overloaded|rate.?limit|JSON|schema|max_tokens/i.test(message)) return 'MODEL_REFUSED'
  return 'INTERNAL'
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Written once at creation; a patch must never try to move them. */
const IMMUTABLE_FIELDS: Record<string, true> = { id: true, createdAt: true, createdBy: true, version: true, __typename: true }

async function persist(run: RunRow, expectedVersion?: number): Promise<void> {
  // Structurally identical shapes; RunRow is the typed view of the same row.
  const asRow = run as unknown as Row
  const patch: Row = {}
  for (const [key, value] of Object.entries(asRow)) {
    if (!IMMUTABLE_FIELDS[key]) patch[key] = value
  }
  patch.updatedAt = nowIso()
  patch.updatedBy = run.updatedBy ?? 'workflow-agent'
  const saved = await updateRun(run.id, patch, expectedVersion)
  run.version = typeof saved.version === 'number' ? saved.version : run.version
  run.updatedAt = String(patch.updatedAt)
}

function stampModel(run: RunRow): void {
  const used = modelUsage()
  run.modelCalls = used.calls
  run.inputTokens = used.inputTokens
  run.outputTokens = used.outputTokens
  if (used.calls > 0) run.model = MODEL_ID
}

/*
 * The inline re-run budget, held for the length of one `execute`. Module state
 * for the same reason `resetModelBudget` is: a Lambda container runs exactly one
 * invocation at a time, so there is never a second run to confuse it with.
 */
let deadlineAt: number | null = null

function startDeadline(budgetMs: number | null): void {
  deadlineAt = budgetMs == null ? null : Date.now() + budgetMs
}

/** Throws before a step that there is no time left to finish. */
function checkDeadline(): void {
  if (deadlineAt != null && Date.now() >= deadlineAt) throw new Error('DEADLINE')
}

/**
 * The step's own timeout. A model call that would answer after the resolver has
 * already given up is not worth waiting for; the run is failed on time instead,
 * so the trace and the page agree about what happened.
 */
async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  if (deadlineAt == null) return work
  const left = deadlineAt - Date.now()
  if (left <= 0) throw new Error('DEADLINE')
  let timer: NodeJS.Timeout | undefined
  // The losing side is abandoned, not cancelled: its rejection is claimed here so
  // it cannot surface as an unhandled rejection after the run has already failed.
  work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DEADLINE')), left) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function finishWith(run: RunRow, outcome: WorkflowOutcome, errorCode?: string): Promise<RunRow> {
  Object.assign(run, finishRun(run, outcome, nowIso()))
  if (errorCode) run.errorCode = errorCode
  stampModel(run)
  await persist(run)
  return run
}

async function runStep<T>(
  run: RunRow,
  key: string,
  body: () => Promise<{ value: T; detail?: string }>,
): Promise<T> {
  checkDeadline()
  Object.assign(run, beginStep(run, key, nowIso()))
  run.status = 'IN_PROGRESS'
  await persist(run)
  const result = await withinDeadline(body())
  Object.assign(run, nextStep(run, key, result.detail ? { detail: redactError(result.detail) } : {}, nowIso()))
  await persist(run)
  return result.value
}

// ── Reading the source ───────────────────────────────────────────────────────

interface SourceData {
  subject: string | null
  fromEmail: string | null
  fromName: string | null
  receivedAt: string | null
  bodyText: string
  /**
   * The message's `Authentication-Results` verdict, forwarded verbatim by the
   * e-mail bridge. Only an INBOX message has one; every other source is an
   * internal bridge with no header to check.
   */
  authResult: string | null
  attachments: Attachment[]
  /** The VendorPayable row, when that is what we are reading. */
  payable: (ExtractableRow & { id: string }) | null
}

function asRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function attachmentsOf(value: unknown): Attachment[] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(raw)) return []
  const out: Attachment[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue
    const key = str(record.key) ?? str(record.s3Key)
    if (!key) continue
    out.push({
      key,
      name: str(record.name) ?? key.split('/').pop() ?? 'attachment',
      contentType: str(record.contentType) ?? 'application/octet-stream',
      size: typeof record.size === 'number' ? record.size : 0,
    })
  }
  return out
}

function keysToAttachments(keys: unknown): Attachment[] {
  if (!Array.isArray(keys)) return []
  return keys
    .filter((key): key is string => typeof key === 'string' && !!key)
    .map((key) => ({
      key,
      name: key.split('/').pop() ?? 'attachment',
      contentType: key.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      size: 0,
    }))
}

async function readSource(run: RunRow): Promise<SourceData> {
  const empty: SourceData = { subject: null, fromEmail: null, fromName: null, receivedAt: null, bodyText: '', authResult: null, attachments: [], payable: null }

  if (run.sourceKind === 'INBOX' || run.sourceKind === 'WEBHOOK') {
    const key = run.sourceKey
    if (!key) throw new Error('SOURCE_MISSING')
    const text = await getObjectText(key)
    if (text === null) throw new Error('S3_MISSING')
    const parsed = asRecord(JSON.parse(text))
    if (!parsed) throw new Error('SOURCE_MISSING')
    if (run.sourceKind === 'WEBHOOK') {
      // A webhook has no sender and no subject; its body IS the payload, and the
      // only thing step K does with it is route it.
      return { ...empty, subject: `${run.provider ?? 'WEBHOOK'} event`, bodyText: text.slice(0, 20_000) }
    }
    return {
      subject: str(parsed.subject),
      fromEmail: str(parsed.fromEmail),
      fromName: str(parsed.fromName),
      receivedAt: str(parsed.receivedAt),
      bodyText: typeof parsed.bodyText === 'string' ? parsed.bodyText : '',
      // Stored verbatim by the inbox door; it is the receiving server's verdict,
      // not the sender's claim, and `matchParty` is the only thing that reads it.
      authResult: str(parsed.authResult),
      attachments: attachmentsOf(parsed.attachments),
      payable: null,
    }
  }

  const row = await getSourceRow(run.sourceKind, run.sourceId)
  if (!row) throw new Error('SOURCE_MISSING')

  if (run.sourceKind === 'VENDOR_PAYABLE') {
    return {
      subject: str(row.subject),
      fromEmail: str(row.fromEmail),
      fromName: null,
      receivedAt: str(row.receivedAt),
      bodyText: typeof row.emailBody === 'string' ? row.emailBody : '',
      authResult: null,
      attachments: attachmentsOf(row.attachments),
      payable: {
        id: String(row.id),
        subject: str(row.subject),
        fromEmail: str(row.fromEmail),
        emailBody: typeof row.emailBody === 'string' ? row.emailBody : null,
        vendor: str(row.vendor),
        invoiceNumber: str(row.invoiceNumber),
        amount: typeof row.amount === 'number' ? row.amount : null,
        invoiceDate: str(row.invoiceDate),
        dueDate: str(row.dueDate),
      },
    }
  }

  if (run.sourceKind === 'DRIVER_SUBMISSION') {
    const keys = [row.combinedRateconKey, row.combinedPodKey].filter((k): k is string => typeof k === 'string' && !!k)
    return {
      subject: str(row.emailSubject),
      fromEmail: null,
      fromName: str(row.driverName),
      receivedAt: str(row.createdAt),
      bodyText: typeof row.note === 'string' ? row.note : '',
      authResult: null,
      attachments: keysToAttachments(keys),
      payable: null,
    }
  }

  // INTAKE_ITEM
  return {
    subject: str(row.subject),
    fromEmail: str(row.fromEmail),
    fromName: null,
    receivedAt: str(row.receivedAt),
    bodyText: typeof row.bodyText === 'string' ? row.bodyText : '',
    authResult: null,
    attachments: keysToAttachments(row.s3KeyPdfAttachments),
    payable: null,
  }
}

// ── Gates that must cost nothing ─────────────────────────────────────────────

function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()).map((entry) => entry.toLowerCase().trim())
}

/**
 * Addresses and keywords a person put on the GMAIL / OUTLOOK behaviour cards.
 * Checked before the first model call, because the whole reason the list exists
 * is newsletters nobody wants to pay to classify.
 */
async function blacklistHit(from: string | null, subject: string | null, body: string): Promise<string | null> {
  const haystack = `${subject ?? ''}\n${body}`.toLowerCase()
  const sender = (from ?? '').toLowerCase().trim()
  const senderDomain = domainOf(from)
  for (const provider of ['GMAIL', 'OUTLOOK']) {
    const row = await getIntegration(provider)
    if (!row) continue
    const raw = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
    const settings = asRecord(raw)
    if (!settings) continue
    for (const entry of stringsIn(settings.blacklistAddresses)) {
      if (!sender) continue
      if (sender === entry || (entry.startsWith('@') && senderDomain === entry.slice(1)) || senderDomain === entry) {
        return `address ${entry}`
      }
    }
    for (const word of stringsIn(settings.blacklistKeywords)) {
      if (haystack.includes(word)) return `keyword ${word}`
    }
  }
  return null
}

function directoryOf(snapshot: { customers: Row[]; carriers: Row[]; carrierContacts: Row[] }): PartyDirectory {
  return {
    customers: snapshot.customers.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      contacts: row.contacts,
      aliases: Array.isArray(row.aliases) ? row.aliases.filter((a): a is string => typeof a === 'string') : null,
    })),
    carriers: snapshot.carriers.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      email: str(row.email),
      dbaName: str(row.dbaName),
    })),
    carrierContacts: snapshot.carrierContacts.map((row) => ({
      id: String(row.id),
      carrierId: String(row.carrierId ?? ''),
      name: str(row.name),
      email: str(row.email),
    })),
  }
}

/**
 * The party's human-written memory block. It is validated on the way IN by
 * `validatePartyMemory` in the directory routers, so reading it back is a
 * boundary that validator already owns.
 */
function aiMemoryOf(snapshot: { customers: Row[]; carriers: Row[] }, match: PartyMatch | null): PartyAiMemory | null {
  if (!match) return null
  const rows = match.kind === 'CUSTOMER' ? snapshot.customers : snapshot.carriers
  const found = rows.find((row) => String(row.id) === match.id)
  if (!found || found.aiMemory == null) return null
  const parsed = typeof found.aiMemory === 'string' ? JSON.parse(found.aiMemory) : found.aiMemory
  return parsed as PartyAiMemory
}

interface PartyResolution {
  result: PartyMatchResult
  detail: string
}

/**
 * Who sent this, against the directory snapshot.
 *
 * Pure and deterministic: `matchParty` makes no model call and reads nothing the
 * run has not already loaded, so asking it early costs nothing. That is what makes
 * party memory real — a prompt can only carry the sender's own notes if the sender
 * is known before the prompt is built, and the spec's step vocabulary puts
 * MATCH_EMAIL_ENTITIES after PARSE_*. So the answer is computed up front and the
 * step that a person reads stays exactly where the spec puts it, recording the same
 * answer. Recomputing it there is free, and safe: `prefer` orders candidates and
 * never decides the match, so the party whose memory was read is the party recorded.
 */
function resolveParty(
  run: RunRow,
  source: SourceData,
  snapshot: { customers: Row[]; carriers: Row[]; carrierContacts: Row[] },
  pinned?: PinnedParty,
): PartyResolution {
  if (pinned) {
    const rows = pinned.partyKind === 'CUSTOMER' ? snapshot.customers : snapshot.carriers
    const row = rows.find((entry) => String(entry.id) === pinned.partyId)
    const forced: PartyMatch | null = row
      ? { kind: pinned.partyKind === 'CUSTOMER' ? 'CUSTOMER' : 'CARRIER', id: String(row.id), name: String(row.name ?? ''), how: 'NAME' }
      : null
    return { result: { match: forced, candidates: [] }, detail: forced ? `pinned to ${forced.name}` : 'pinned party not found' }
  }
  const prefer = run.agent === 'AP' || run.agent === 'CAPACITY' ? 'CARRIER' : 'CUSTOMER'
  const result = matchParty(
    {
      fromEmail: source.fromEmail,
      fromName: source.fromName,
      bodyTail: source.bodyText.slice(-400),
      authResult: source.authResult,
    },
    directoryOf(snapshot),
    prefer,
  )
  const found = result.match
    ? `${result.match.kind} ${result.match.name} by ${result.match.how}`
    : `${result.candidates.length} candidate(s)`
  // The trace has to say why a known address was not taken at face value, or the
  // exception reads as the directory being wrong rather than the mail being unsigned.
  return { result, detail: result.authDowngrade ? `${found} — exact address not trusted: ${result.authDowngrade}` : found }
}

// ── The pipeline ─────────────────────────────────────────────────────────────

interface RateconRead {
  invoice?: { brokerName?: string | null; poNumber?: string | null; originCity?: string | null; originState?: string | null; originZip?: string | null; destinationCity?: string | null; destinationState?: string | null; destinationZip?: string | null } | null
  freight?: { weightLbs?: number | null } | null
  pickup?: { date?: string | null; time?: string | null } | null
  delivery?: { date?: string | null; time?: string | null } | null
}

function fillFromRatecon(read: RateconRead): TenderModelFill {
  const invoice = read.invoice ?? {}
  const stops: NonNullable<TenderModelFill['stops']> = []
  if (invoice.originCity || invoice.originState) {
    stops.push({ type: 'pickup', city: invoice.originCity ?? null, state: invoice.originState ?? null, zip: invoice.originZip ?? null, dateStr: read.pickup?.date ?? null, time: read.pickup?.time ?? null })
  }
  if (invoice.destinationCity || invoice.destinationState) {
    stops.push({ type: 'delivery', city: invoice.destinationCity ?? null, state: invoice.destinationState ?? null, zip: invoice.destinationZip ?? null, dateStr: read.delivery?.date ?? null, time: read.delivery?.time ?? null })
  }
  return {
    customer: invoice.brokerName ?? null,
    reference: invoice.poNumber ?? null,
    pickupNumber: null,
    weightLb: read.freight?.weightLbs ?? null,
    stops,
  }
}

/**
 * The desks a classifier answer may move a run to. WEBHOOK is an agent key but
 * not a desk any e-mail belongs to, and routing to it would walk into a step
 * vocabulary that has no PARSE_* at all — a model-controlled input choosing a
 * code path that throws.
 */
const MAIL_AGENTS: readonly WorkflowAgentKey[] = ['QUOTE', 'TENDER', 'AP', 'CAPACITY']

/**
 * The two gates that must hold for the agent that actually runs: both are counted
 * against that desk, not against the inbox the mail happened to arrive in.
 * Returns the error code to end on, or null to carry on.
 */
async function spendingGate(agent: WorkflowAgentKey, orgSettings: AiAgentsSettings | null): Promise<string | null> {
  if (await countRunsToday(agent) > dailyRunCapOf(orgSettings)) return 'DAILY_CAP'
  if (!agentEnabled(orgSettings, agent)) return 'AGENT_DISABLED'
  return null
}

async function execute(run: RunRow, pinned?: PinnedParty, budgetMs: number | null = null): Promise<RunRow> {
  resetModelBudget()
  startDeadline(budgetMs)
  const startedAt = nowIso()
  run.startedAt = run.startedAt ?? startedAt
  run.errorCode = null
  run.error = null

  try {
    const isWebhook = run.agent === 'WEBHOOK'
    const receiveKey = isWebhook ? 'RECEIVE_WEBHOOK' : 'RECEIVE_EMAIL'

    const source = await runStep(run, receiveKey, async () => {
      const data = await readSource(run)
      run.subject = data.subject
      run.fromEmail = data.fromEmail
      run.fromName = data.fromName
      run.fromDomain = domainOf(data.fromEmail) || null
      run.receivedAt = data.receivedAt
      run.bodyPreview = data.bodyText.slice(0, 500)
      run.documents = data.attachments
        .slice(0, MAX_ATTACHMENTS)
        .map((a) => documentFor(a.key, a.name, a.contentType, a.size))
      return { value: data, detail: `${data.attachments.length} attachment(s)` }
    })

    const settingsRow = await getSettings()
    const rawAiAgents = settingsRow && typeof settingsRow.aiAgents === 'string'
      ? JSON.parse(settingsRow.aiAgents)
      : settingsRow?.aiAgents ?? null
    // The settings row is validated on the way IN by tmsDirectoryActions'
    // `validateAiAgents`; reading it back is a boundary the validator already owns.
    const orgSettings = asRecord(rawAiAgents) as AiAgentsSettings | null

    // Steps 3 and 4 — the daily cap and the enabled switch, before any model call.
    const gate = await spendingGate(run.agent, orgSettings)
    if (gate) return finishWith(run, 'NO_ACTION', gate)

    // Step 5 — the blacklist. Still no model call.
    if (!isWebhook) {
      const hit = await blacklistHit(source.fromEmail, source.subject, source.bodyText)
      if (hit) {
        run.error = redactError(`Blacklisted: ${hit}`)
        return finishWith(run, 'NO_ACTION', 'BLACKLISTED')
      }
    }

    if (isWebhook) {
      await runStep(run, 'ROUTE_WEBHOOK', async () => {
        // Every consumer is null in K: the row records that the event arrived and
        // what it was, which is the whole deliverable until one is written.
        const consumer = consumerFor(String(run.provider ?? ''))
        return { value: consumer, detail: consumer ? consumer.describe : 'no consumer for this provider yet' }
      })
      return finishWith(run, 'IGNORED')
    }

    // Who sent it, resolved before the first model call. See `resolveParty`: the
    // answer is free and deterministic, and having it here is the only way a parse
    // prompt can carry the sender's own notes.
    const snapshot = await loadDirectory()
    const early = resolveParty(run, source, snapshot, pinned)
    // Scoped to the match and nothing else: no match reads no party memory, a
    // CARRIER match reads carrier memory, a CUSTOMER match customer memory. An
    // UNKNOWN_PARTY run's candidates are guesses, not senders, so `aiMemoryOf`
    // reading only `match` is what keeps their notes out of the prompt.
    const partyMemory = aiMemoryOf(snapshot, early.result.match)

    // Step 6 — classify. May re-route; the inbox the mail arrived in stays on the row.
    const inboxAgent = run.agent
    await runStep(run, 'CLASSIFY_EMAIL', async () => {
      const answer = await callModel<ClassifyResult>(
        CLASSIFY_SCHEMA,
        [],
        emailPrompt(
          'Decide which desk this message belongs to. Answer only with the schema.',
          { subject: source.subject, fromEmail: source.fromEmail, body: source.bodyText },
        ),
        300,
      )
      const suggested = (answer.value.agent ?? '').toUpperCase()
      const confidence = (answer.value.confidence ?? '').toLowerCase()
      // A low-confidence re-route loses to the address the mail was sent to: the
      // inbox is a human decision and the classifier is a guess.
      if (isAgent(suggested) && MAIL_AGENTS.includes(suggested) && suggested !== run.agent && confidence !== 'low') {
        run.agent = suggested
      }
      return { value: answer.value, detail: `${suggested} (${confidence}): ${answer.value.reason ?? ''}` }
    })

    // A re-routed run spends the budget of the desk it landed on, so that desk's
    // cap and switch are the ones that decide whether it goes on.
    if (run.agent !== inboxAgent) {
      const reGate = await spendingGate(run.agent, orgSettings)
      if (reGate) return finishWith(run, 'NO_ACTION', reGate)
    }

    const descriptor = AGENTS[run.agent]
    // Organisation-authored text, so it is not fenced as untrusted content — but it
    // still goes through the same credential redaction as every other prompt input.
    const memoryHint = redactForPrompt(memoryPromptFor(orgSettings, partyMemory, run.agent))
    const files = await fileBlocks(source.attachments)

    // Step 7 — parse.
    const parsed = await parseFor(run, source, files, memoryHint)

    // Step 8 — record who sent it. Computed above; this step is where the trace a
    // person reads states it, which is where the spec's vocabulary puts it.
    const match = await runStep(run, 'MATCH_EMAIL_ENTITIES', async () => {
      // Re-resolved against the agent classification settled on. `prefer` orders
      // candidates and never decides the match, so this is the same party whose
      // memory the parse prompt carried.
      const settled = resolveParty(run, source, snapshot, pinned)
      return { value: settled.result, detail: settled.detail }
    })

    run.partyCandidates = match.candidates.slice(0, 3)
    if (match.match) {
      run.partyKind = match.match.kind
      run.partyId = match.match.id
      run.partyName = match.match.name
      run.partyMatchHow = match.match.how
    } else {
      run.partyKind = run.agent === 'AP' ? 'VENDOR' : 'UNKNOWN'
      run.partyId = null
      run.partyName = null
      run.partyMatchHow = 'NONE'
    }
    // The revisions stamped on the run are the revisions actually read.
    run.memoryRevisions = memoryRevisionsFor(orgSettings, partyMemory, run.agent)

    // A name we could not resolve but could guess at is the Errors queue's job,
    // not the model's: a person picks, and SET_RUN_PARTY re-runs from here.
    if (!match.match && match.candidates.length > 0) {
      return finishWith(run, 'UNKNOWN_PARTY')
    }

    // Steps 9 and 10 — per agent.
    if (run.agent === 'TENDER') {
      const tender = parsed as TenderPrefill
      await runStep(run, 'MATCH_STOP', async () => {
        let hits = 0
        for (const stop of tender.stops) {
          const facility = snapshot.locations.find((row) =>
            String(row.city ?? '').toUpperCase().startsWith(String(stop.city ?? '').toUpperCase()) &&
            !!stop.city &&
            String(row.state ?? '').toUpperCase() === String(stop.state ?? '').toUpperCase())
          if (!facility) continue
          hits += 1
          if (!stop.name) stop.name = String(facility.name ?? '')
        }
        return { value: hits, detail: `${hits}/${tender.stops.length} stop(s) matched a known facility` }
      })
      await runStep(run, 'PROPOSE_TENDER', async () => {
        run.proposalKind = 'TENDER'
        run.proposal = { kind: 'TENDER', tender, customerId: run.partyKind === 'CUSTOMER' ? run.partyId : null, customerName: run.partyName ?? tender.customer ?? null }
        return { value: null, detail: `${tender.stops.length} stop(s), reference ${tender.reference ?? 'none'}` }
      })
      return finishWith(run, 'PROPOSED')
    }

    if (run.agent === 'QUOTE') {
      await runStep(run, 'PROPOSE_QUOTE', async () => {
        run.proposalKind = 'QUOTE'
        run.proposal = parsed
        return { value: null, detail: descriptor.label }
      })
      return finishWith(run, 'PROPOSED')
    }

    if (run.agent === 'CAPACITY') {
      await runStep(run, 'NOTE_CAPACITY', async () => {
        run.proposalKind = 'CAPACITY'
        run.proposal = parsed
        return { value: null, detail: descriptor.label }
      })
      return finishWith(run, 'NOTED')
    }

    // AP. A carrier we know billed us for a load; anything else is a vendor bill.
    const extraction = parsed as Extraction
    if (match.match?.kind === 'CARRIER') {
      await runStep(run, 'MATCH_DOCUMENTS', async () => {
        const refs = shipmentRefsIn(`${source.subject ?? ''}\n${source.bodyText}\n${extraction.invoiceNumber ?? ''}`)
        let shipment: Row | null = null
        for (const number of [...refs.numbers, ...refs.pros]) {
          shipment = await findShipmentByNumber(number)
          if (shipment) break
        }
        if (shipment) {
          run.shipmentId = String(shipment.id)
          run.shipmentNumber = str(shipment.number)
        }
        const filed = await fileCarrierInvoice(run, source)
        return { value: filed, detail: shipment ? `shipment ${run.shipmentNumber}` : 'no shipment reference found' }
      })
      await runStep(run, 'PROPOSE_BILL', async () => {
        run.proposalKind = 'CARRIER_BILL'
        run.proposal = carrierBillFrom(
          {
            invoiceNumber: extraction.invoiceNumber ?? undefined,
            amountDollars: extraction.amountDollars ?? undefined,
            invoiceDate: extraction.invoiceDate ?? undefined,
            dueDate: extraction.dueDate ?? undefined,
            confidence: extraction.confidence,
          },
          {
            carrierId: match.match?.id,
            carrierName: match.match?.name,
            shipmentId: run.shipmentId ?? undefined,
            shipmentNumber: run.shipmentNumber ?? undefined,
          },
        )
        return { value: null, detail: `invoice ${extraction.invoiceNumber ?? 'unnumbered'}` }
      })
      return finishWith(run, 'PROPOSED')
    }

    await runStep(run, 'MATCH_DOCUMENTS', async () => ({ value: null, detail: 'vendor bill — no shipment to match' }))
    await runStep(run, 'PROPOSE_BILL', async () => {
      const note = extraction.note ? `${extraction.confidence} confidence: ${extraction.note}` : `${extraction.confidence} confidence`
      const patch = source.payable ? mergeExtraction(source.payable, extraction) : {}
      if (source.payable) {
        const when = nowIso()
        await updateVendorPayable(source.payable.id, { ...patch, extractedAt: when, extractionNote: note, updatedAt: when })
      }
      run.proposalKind = 'VENDOR_BILL'
      // Built from what was read, not from the blanks-only merge patch: the patch
      // carries whatever the payable row was still missing, in that row's own field
      // names, so a row already carrying an amount would leave the card blank.
      run.proposal = {
        kind: 'VENDOR_BILL',
        vendorPayableId: source.payable?.id ?? null,
        vendorName: extraction.vendor ?? null,
        invoiceNumber: extraction.invoiceNumber ?? null,
        amountCents: centsFromDollars(extraction.amountDollars),
        invoiceDate: extraction.invoiceDate ?? null,
        dueDate: extraction.dueDate ?? null,
        confidence: extraction.confidence,
      }
      const filled = Object.keys(patch)
      return { value: null, detail: `${note}; filled ${filled.join(', ') || 'nothing'}` }
    })
    return finishWith(run, 'PROPOSED')
  } catch (err) {
    const code = errorCodeOf(err)
    console.error('[workflow-agent] run failed', run.id, code, messageOf(err))
    Object.assign(run, failRun(run, code, redactError(messageOf(err)), nowIso()))
    stampModel(run)
    await persist(run)
    return run
  }
}

async function parseFor(run: RunRow, source: SourceData, files: FileBlock[], memoryHint: string): Promise<unknown> {
  /*
   * Attachments arrived that the agent cannot open (not a PDF or a picture, or
   * over 8 MB) and there is no body either — there is nothing to read, so the
   * run says so instead of spending a model call on an empty prompt. AP is
   * excluded: it has had its own answer for this since vendor-ap-extract (a
   * note for a person, not a failure) and that behaviour is unchanged.
   */
  if (run.agent !== 'AP' && files.length === 0 && !source.bodyText.trim() && source.attachments.length > 0) {
    throw new Error('UNSUPPORTED_ATTACHMENT')
  }

  if (run.agent === 'TENDER') {
    return runStep(run, 'PARSE_TENDER', async () => {
      // The deterministic reader first: it is free, it is tested against 166 real
      // tenders, and the model only ever fills what it left blank.
      const prefill = parseTender(source.subject, source.bodyText)
      let fill: TenderModelFill | null
      if (files.length > 0) {
        // One pass over the document with the SAME schema the rate-con dialog
        // uses, so the agent and the client can never disagree about one page.
        const answer = await callModel<RateconRead>(RATECON_SCHEMA, [files[0]], [
          'This is a freight rate confirmation or tender. Extract exactly what it states.',
          memoryHint,
        ].filter(Boolean).join('\n\n'), 2000)
        fill = fillFromRatecon(blanksToNull(answer.value))
      } else {
        const answer = await callModel<TenderModelFill>(
          TENDER_FILL_SCHEMA,
          [],
          emailPrompt(
            ['Read this freight tender. Return only what the message states; null for anything it does not.', memoryHint].filter(Boolean).join('\n\n'),
            { subject: source.subject, fromEmail: source.fromEmail, body: source.bodyText },
          ),
          1200,
        )
        fill = answer.value
      }
      const tender = tenderFromParse(prefill, fill)
      return { value: tender, detail: `${tender.stops.length} stop(s) from ${prefill.format ?? 'model'}` }
    })
  }

  if (run.agent === 'QUOTE') {
    return runStep(run, 'PARSE_QUOTE', async () => {
      const answer = await callModel<QuoteEmailParse>(
        QUOTE_SCHEMA,
        files.slice(0, 1),
        emailPrompt(
          ['Read this request for a freight quote.', memoryHint].filter(Boolean).join('\n\n'),
          { subject: source.subject, fromEmail: source.fromEmail, body: source.bodyText },
        ),
        1000,
      )
      const proposal = quoteFromEmail(answer.value, memoryHint)
      return { value: proposal, detail: `${answer.value.originCity ?? '?'} to ${answer.value.destinationCity ?? '?'}` }
    })
  }

  if (run.agent === 'CAPACITY') {
    return runStep(run, 'PARSE_CAPACITY', async () => {
      const answer = await callModel<CapacityEmailParse>(
        CAPACITY_SCHEMA,
        [],
        emailPrompt(
          ['A carrier is advertising empty trucks. Read what they have and where.', memoryHint].filter(Boolean).join('\n\n'),
          { subject: source.subject, fromEmail: source.fromEmail, body: source.bodyText },
        ),
        800,
      )
      const posting = postingFrom(answer.value)
      return { value: posting, detail: `${answer.value.equipment ?? 'unknown equipment'}` }
    })
  }

  return runStep(run, 'PARSE_INVOICE', async () => {
    if (files.length === 0 && !source.bodyText) {
      // The old extractor's exact behaviour: no readable attachment is a note for
      // a person, not a model call and not a failure.
      const blank: Extraction = { vendor: null, invoiceNumber: null, amountDollars: null, invoiceDate: null, dueDate: null, confidence: 'low', note: null }
      return { value: blank, detail: 'No readable attachment (PDF or picture) on the email' }
    }
    const row: ExtractableRow = source.payable ?? {
      id: run.sourceId,
      subject: source.subject,
      fromEmail: source.fromEmail,
      emailBody: source.bodyText,
    }
    const extraction = await extractFromInvoice(row, files, nowIso().slice(0, 10))
    return { value: extraction, detail: `${extraction.confidence} confidence${extraction.note ? `: ${extraction.note}` : ''}` }
  })
}

/**
 * The carrier's invoice, filed against the shipment as PENDING review.
 *
 * `reviewStatus` is the sparse index the review worklist reads, and PENDING on
 * it is what "the agent found this, nobody has accepted it" means in this
 * schema. `status` stays ACTIVE — that column is the supersede ladder.
 *
 * The id is a hash of the run and the object key, so a retry of a run that
 * already filed this document collides with itself. That collision is the
 * idempotency working, not a failure: without this a run that filed the document
 * and then died could never succeed again, it would just burn its five attempts.
 */
async function fileCarrierInvoice(run: RunRow, source: SourceData): Promise<string | null> {
  const attachment = source.attachments[0]
  if (!attachment || !run.shipmentId || !SHIPMENT_DOCUMENT_TABLE_NAME) return null
  const when = nowIso()
  const id = `wfdoc:${sha20(`${run.id}:${attachment.key}`)}`
  try {
    await putShipmentDocument({
      id,
      shipmentId: run.shipmentId,
      type: 'CARRIER_INVOICE',
      name: attachment.name,
      s3Key: attachment.key,
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      source: 'UPLOAD',
      audience: 'INTERNAL',
      status: 'ACTIVE',
      reviewStatus: 'PENDING',
      version: 1,
      uploadedBy: 'workflow-agent',
      uploadedAt: when,
      createdBy: 'workflow-agent',
      createdAt: when,
      updatedAt: when,
    })
  } catch (err) {
    if (!isConditionalFailure(err)) throw err
  }
  if (!run.documentIds?.includes(id)) run.documentIds = [...(run.documentIds ?? []), id]
  return id
}

// ── Entry points ─────────────────────────────────────────────────────────────

export async function runFor(input: RunForInput): Promise<RunRow> {
  const agent: WorkflowAgentKey = isAgent(input.inboxRole) ? input.inboxRole : 'TENDER'
  const sourceKey = input.sourceKey || `${input.sourceKind}:${input.sourceId}`
  const id = runIdFor(agent, sourceKey)
  const now = nowIso()
  const fresh: RunRow = {
    id,
    agent,
    inboxRole: input.inboxRole,
    status: 'PENDING',
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    provider: input.provider,
    attempts: 1,
    lastAttemptAt: now,
    steps: [],
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    createdAt: now,
    updatedAt: now,
    version: 1,
  }
  if (input.sourceKey) fresh.sourceKey = input.sourceKey

  const created = await putRunIfAbsent(fresh as unknown as Row)
  if (!created) {
    // Idempotent by primary key: the second bridge to hand this message over does
    // no work at all, and certainly no model call.
    const existing = await getRun(id)
    return (existing as unknown as RunRow | null) ?? fresh
  }
  return execute(fresh)
}

/**
 * RETRY_RUN. The caller is an AppSync resolver waiting on the answer, so the
 * budget belongs to the caller; the default is the resolver's: `INLINE_BUDGET_MS`.
 */
export async function retryRun(
  id: string,
  expectedVersion: number,
  caller: { email: string },
  budgetMs: number | null = INLINE_BUDGET_MS,
): Promise<RunRow> {
  const row = await getRun(id)
  if (!row) throw new Error(`Run not found: ${id}`)
  const run = row as unknown as RunRow
  if (!retryable(run)) throw new Error('That run cannot be retried')

  run.attempts = (run.attempts ?? 0) + 1
  run.lastAttemptAt = nowIso()
  run.status = 'PENDING'
  run.outcome = null
  run.steps = []
  run.currentStep = null
  run.errorCode = null
  run.error = null
  run.exceptionOpen = null
  run.endedAt = null
  run.durationMs = null
  run.startedAt = null
  run.updatedBy = caller.email
  // The CAS is taken once, here: everything after it is this invocation's own row.
  await persist(run, expectedVersion)
  return execute(run, undefined, budgetMs)
}

/**
 * SET_RUN_PARTY: a person named the party, so the run goes again with it pinned.
 * Inline in the same resolver as RETRY_RUN, and on the same budget.
 */
export async function rerunWithParty(
  id: string,
  pinned: PinnedParty,
  expectedVersion: number,
  caller: { email: string },
  budgetMs: number | null = INLINE_BUDGET_MS,
): Promise<RunRow> {
  const row = await getRun(id)
  if (!row) throw new Error(`Run not found: ${id}`)
  const run = row as unknown as RunRow
  if (run.outcome !== 'UNKNOWN_PARTY') throw new Error('Only a run that could not identify the party can be re-pointed')

  run.attempts = (run.attempts ?? 0) + 1
  run.lastAttemptAt = nowIso()
  run.status = 'PENDING'
  run.outcome = null
  run.steps = []
  run.currentStep = null
  run.errorCode = null
  run.error = null
  run.exceptionOpen = null
  run.endedAt = null
  run.durationMs = null
  run.startedAt = null
  run.updatedBy = caller.email
  await persist(run, expectedVersion)
  return execute(run, pinned, budgetMs)
}

/**
 * A Lambda that died mid-run leaves the row where it stood for ever, and an
 * exception nobody can see is worse than one that is wrong. Ten minutes is well
 * past the 90 s function timeout. PENDING is swept as well as IN_PROGRESS: a run
 * that died before its first step never got as far as IN_PROGRESS.
 */
export async function sweepStalled(nowIsoValue = nowIso()): Promise<{ failed: number }> {
  const cutoff = new Date(Date.parse(nowIsoValue) - STALL_MINUTES * 60_000).toISOString()
  let failed = 0
  for (const agent of AGENT_KEYS) {
    for (const row of await queryStalled(agent, cutoff)) {
      const run = row as unknown as RunRow
      const last = String(run.lastAttemptAt ?? run.updatedAt ?? '')
      if (last && last > cutoff) continue
      Object.assign(run, failRun(run, 'STALLED', 'The run stopped responding and was swept', nowIsoValue))
      await persist(run)
      await writeAudit('WorkflowRun', run.id, 'SWEEP_STALLED', { email: 'workflow-agent' }, { errorCode: 'STALLED' })
      failed += 1
    }
  }
  return { failed }
}

/** The old `vendor-ap-extract` `{ all: true }` payload, unchanged in effect. */
export async function backfillAp(): Promise<{ ok: true; results: Record<string, string> }> {
  const ids = await scanVendorPayablesNeedingExtract()
  const results: Record<string, string> = {}
  for (const id of ids) {
    const run = await runFor({ sourceKind: 'VENDOR_PAYABLE', sourceId: id, inboxRole: 'AP', provider: 'GMAIL' })
    results[id] = String(run.outcome ?? run.status)
  }
  return { ok: true, results }
}
