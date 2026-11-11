/**
 * workflow-agent — Step U staging. A tender e-mail becomes an `IntakeLoad`: a partially built
 * load a person reviews before it becomes an Active shipment.
 *
 * Three promises, all pinned by `intakeStage.test.ts`:
 *   - one row per e-mail, created with `attribute_not_exists(id)` — a re-run (RETRY_RUN,
 *     SET_RUN_PARTY) can never overwrite a row a reviewer has started editing;
 *   - staging NEVER throws into the run: a failed write is logged and reported in the returned
 *     detail, and the run's outcome is whatever the pipeline decided;
 *   - only a TENDER run stages (intake follows `run.agent`, not the inbox the mail arrived in).
 */
import { matchDivisionByAddresses } from '../../../src/lib/intakeMail'
import {
  buildIntakeDraft,
  emptyIntakeFields,
  intakeMissing,
  intakeRequired,
  mergeIntakeFields,
} from '../../../src/lib/intakeLoad'
import type { TenderPrefill } from '../../../src/lib/intakeTender'
import type { IntakeCustomerCandidate, IntakeFields, IntakeMeta, IntakeParseState } from '../../../src/types/intake'
import {
  CUSTOMER_TABLE_NAME,
  INTAKE_LOAD_TABLE_NAME,
  getById,
  getSettings,
  listDivisions,
  findIntakeByReference,
  findIntakeDuplicate,
  logRepeatEmail,
  enrichIntakeLoad,
  nowIso,
  putIntakeLoadIfAbsent,
  type Row,
  type RunRow,
} from './store'

const MAX_TO_ADDRESSES = 20
const MAX_ADDRESS_LENGTH = 320
const MAX_BODY_CHARS = 20_000

/**
 * The recipient list as stored: lower-cased, trimmed, de-duplicated, order preserved, at most
 * 20 of at most 320 characters. Anything that is not a string is dropped rather than refused —
 * an address list is routing metadata, and a malformed entry must not cost the message.
 */
export function cleanToAddresses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const email = entry.trim().toLowerCase()
    if (!email || email.length > MAX_ADDRESS_LENGTH || out.includes(email)) continue
    out.push(email)
    if (out.length >= MAX_TO_ADDRESSES) break
  }
  return out
}

/** The slice of the e-mail the staged row copies. */
export interface IntakeSourceMail {
  subject: string | null
  fromEmail: string | null
  fromName: string | null
  receivedAt: string | null
  bodyText: string
  attachments: { key: string; name: string; contentType: string; size: number }[]
  toAddresses: string[]
}

/** What the parse produced, as `parseFor` hands it over. */
export interface TenderParse {
  tender: TenderPrefill
  parserTender: TenderPrefill
  fillKind: 'RATECON' | 'EMAIL' | 'NONE'
  lowConfidence: string[]
}

export type StageInput =
  | {
      kind: 'PARSED'
      parse: TenderParse
      /** The directory customer the run matched, if any; else the ≤3 candidates. */
      party: { kind: string | null; id: string | null; name: string | null; how: string | null }
      candidates: IntakeCustomerCandidate[]
      /** Per tender stop (raw order): did MATCH_STOP find a known facility. */
      stopFacilityHits: boolean[]
    }
  | {
      /** The e-mail only: the agent was gated, or the pipeline failed before it could parse. */
      kind: 'BARE'
      parseState: Extract<IntakeParseState, 'NOT_PARSED' | 'FAILED'>
      parseNote: string
    }

export interface StageResult {
  staged: boolean
  /** One line for the run trace. */
  detail: string
}

function customerOf(row: Row | null): { defaultSalesRepId?: string | null; accountOwnerIds?: string[] | null; billToParties?: unknown } | null {
  return row
    ? {
        defaultSalesRepId: typeof row.defaultSalesRepId === 'string' ? row.defaultSalesRepId : null,
        accountOwnerIds: Array.isArray(row.accountOwnerIds) ? (row.accountOwnerIds as string[]) : null,
        billToParties: row.billToParties,
      }
    : null
}

function jsonish<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw as T | null | undefined) ?? fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/**
 * The original e-mail about a tender that already has an intake row (typically one typed from a Slack forward) gives that row what it
 * lacks: its attachments (the rate confirmation PDF) when the row has none, and any field the row has no value for. A person's or the
 * first read's values are never overwritten, and a row that changed since it was read is left as it is (the e-mail is still logged).
 */
async function enrichFromRepeat(existing: Row, mail: IntakeSourceMail, incoming: IntakeFields, incomingMeta: IntakeMeta, parsed: boolean): Promise<void> {
  const have = jsonish<unknown[]>(existing.attachments, [])
  const attachments = have.length === 0 && mail.attachments.length > 0
    ? mail.attachments.map((a) => ({ name: a.name, contentType: a.contentType, size: a.size, key: a.key }))
    : null
  const current = jsonish<IntakeFields>(existing.fields, emptyIntakeFields())
  const merged = parsed ? mergeIntakeFields({ ...emptyIntakeFields(), ...current, stops: current.stops ?? [] }, incoming) : null
  const changed = merged != null && merged.filled.length > 0
  if (!attachments && !changed) return
  const meta = jsonish<IntakeMeta>(existing.meta, {})
  if (merged && changed) for (const key of merged.filled) if (incomingMeta[key]) meta[key] = incomingMeta[key]!
  await enrichIntakeLoad(existing, {
    attachments,
    fields: changed ? (merged!.fields as unknown as Row) : null,
    meta: changed ? (meta as unknown as Row) : null,
    at: nowIso(),
  })
}

export async function stageIntake(run: RunRow, mail: IntakeSourceMail, input: StageInput): Promise<StageResult> {
  if (run.agent !== 'TENDER') return { staged: false, detail: 'not a tender run' }
  try {
    const divisions = (await listDivisions()).map((row) => ({
      code: String(row.code ?? row.id),
      active: row.active === true,
      intakeEmail: typeof row.intakeEmail === 'string' ? row.intakeEmail : null,
    }))
    const routed = matchDivisionByAddresses(mail.toAddresses, divisions)

    let fields: IntakeFields
    let meta: IntakeMeta
    let customerCandidates: IntakeCustomerCandidate[] = []
    let parseState: IntakeParseState
    let parseNote: string | null
    let format: string | null
    let customerRow: Row | null = null

    if (input.kind === 'PARSED') {
      if (input.party.kind === 'CUSTOMER' && input.party.id) customerRow = await getById(CUSTOMER_TABLE_NAME, input.party.id)
      const built = buildIntakeDraft({
        tender: input.parse.tender,
        parserTender: input.parse.parserTender,
        fillKind: input.parse.fillKind,
        lowConfidence: input.parse.lowConfidence,
        party: { ...input.party, candidates: input.candidates },
        customer: customerOf(customerRow),
        divisionCode: routed?.divisionCode ?? null,
        stopFacilityHits: input.stopFacilityHits,
      })
      ;({ fields, meta, customerCandidates } = built)
      parseState = 'PARSED'
      parseNote = null
      format = input.parse.tender.format
    } else {
      fields = emptyIntakeFields()
      meta = {}
      if (routed) {
        fields.divisionCode = routed.divisionCode
        meta.divisionCode = { source: 'ADDRESS', confidence: 'high' }
      }
      parseState = input.parseState
      parseNote = input.parseNote
      format = null
    }

    // A repeat e-mail for the same tender (same reference, same sender) rolls into the row it belongs to: logged there, never a second row.
    if (fields.reference) {
      const existing = await findIntakeByReference(String(fields.reference), mail.fromEmail ?? '')
      if (existing && existing.id !== `il:${run.id}`) {
        try {
          // The original e-mail brings what the row lacks (its rate confirmation PDF, field values); a log entry alone when it brings nothing.
          try {
            await enrichFromRepeat(existing, mail, fields, meta, input.kind === 'PARSED')
          } catch (err) {
            // The row changed under us (a reviewer is editing it): leave it as it is; the e-mail is still logged on it below.
            console.warn('[workflow-agent] could not enrich intake load', existing.id, err instanceof Error ? err.message : String(err))
          }
          await logRepeatEmail(existing, { at: mail.receivedAt ?? nowIso(), subject: mail.subject ?? '', runId: run.id })
          return { staged: false, detail: `rolled into intake load ${String(existing.id)}${existing.status === 'DISMISSED' ? ' (reopened)' : ''}` }
        } catch (err) {
          // The row moved on while this ran: fall through and stage normally rather than lose the e-mail.
          console.error('[workflow-agent] repeat e-mail log failed', existing.id, err instanceof Error ? err.message : String(err))
        }
      }
    }

    const settingsRow = await getSettings()
    const required = intakeRequired(settingsRow, customerRow).gated

    // This run's own row from an earlier pass that could not read the e-mail (spending cap, failure): reading it now fills the row in
    // (a person's own entries stay) instead of leaving it unread. Anything else already staged is left exactly as it is.
    const mine = await getById(INTAKE_LOAD_TABLE_NAME, `il:${run.id}`)
    if (mine) {
      if (input.kind === 'PARSED' && mine.parseState !== 'PARSED' && mine.status === 'OPEN') {
        const current = jsonish<IntakeFields>(mine.fields, emptyIntakeFields())
        const kept = Object.fromEntries(Object.entries(current).filter(([k, v]) => k !== 'stops' && v != null && v !== '' && !(Array.isArray(v) && v.length === 0)))
        const filled = { ...fields, ...kept, stops: (current.stops ?? []).length > 0 ? current.stops : fields.stops } as IntakeFields
        await enrichIntakeLoad(mine, {
          attachments: null, fields: filled as unknown as Row, meta: { ...meta, ...jsonish<IntakeMeta>(mine.meta, {}) } as unknown as Row,
          missingFields: intakeMissing(filled, required, customerRow), at: nowIso(),
          parse: { parseState: 'PARSED', parseNote: null, format, autoFields: { ...fields, customerCandidates } as unknown as Row },
        })
        return { staged: true, detail: 'read the e-mail and filled in its intake load' }
      }
      return { staged: false, detail: 'intake load already staged' }
    }

    // The same e-mail delivered twice (two group addresses, or a group re-send) has a different Gmail id each time and so a different run.
    const twin = await findIntakeDuplicate({ subject: mail.subject, bodyText: mail.bodyText, receivedAt: mail.receivedAt }, `il:${run.id}`)
    if (twin) {
      try { await enrichFromRepeat(twin, mail, fields, meta, input.kind === 'PARSED') } catch (err) {
        console.warn('[workflow-agent] could not enrich the twin intake load', twin.id, err instanceof Error ? err.message : String(err))
      }
      return { staged: false, detail: `same e-mail as intake load ${String(twin.id)}` }
    }

    const now = nowIso()
    const created = await putIntakeLoadIfAbsent({
      id: `il:${run.id}`,
      status: 'OPEN',
      divisionCode: routed?.divisionCode ?? null,
      toAddress: routed?.address ?? null,
      toAddresses: mail.toAddresses,
      runId: run.id,
      sourceKey: run.sourceKey ?? null,
      subject: mail.subject ?? '',
      fromEmail: mail.fromEmail ?? '',
      fromName: mail.fromName ?? '',
      receivedAt: mail.receivedAt ?? now,
      bodyText: mail.bodyText.slice(0, MAX_BODY_CHARS),
      attachments: mail.attachments.map((a) => ({ name: a.name, contentType: a.contentType, size: a.size, key: a.key })),
      parseState,
      parseNote,
      format,
      fields,
      autoFields: { ...fields, customerCandidates },
      meta,
      confirmed: [],
      missingFields: intakeMissing(fields, required, customerRow),
      createdBy: 'workflow-agent',
      updatedBy: 'workflow-agent',
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    const where = routed ? `division ${routed.divisionCode}` : 'unrouted'
    return { staged: created, detail: created ? `staged an intake load (${where})` : 'intake load already staged' }
  } catch (err) {
    console.error('[workflow-agent] intake staging failed', run.id, err)
    return { staged: false, detail: `intake staging failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }
  }
}

/** Kept for callers that only have the run's candidate list. */
export function customerCandidatesOf(candidates: readonly { kind: string; id: string; name: string; how: string }[]): IntakeCustomerCandidate[] {
  return candidates.filter((c) => c.kind === 'CUSTOMER').slice(0, 3).map((c) => ({ id: c.id, name: c.name, how: c.how }))
}
