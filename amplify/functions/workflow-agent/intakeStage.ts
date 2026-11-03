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
} from '../../../src/lib/intakeLoad'
import type { TenderPrefill } from '../../../src/lib/intakeTender'
import type { IntakeCustomerCandidate, IntakeFields, IntakeMeta, IntakeParseState } from '../../../src/types/intake'
import {
  CUSTOMER_TABLE_NAME,
  getById,
  getSettings,
  listDivisions,
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

function customerOf(row: Row | null): { defaultSalesRepId?: string | null; billToParties?: unknown } | null {
  return row ? { defaultSalesRepId: typeof row.defaultSalesRepId === 'string' ? row.defaultSalesRepId : null, billToParties: row.billToParties } : null
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

    const settingsRow = await getSettings()
    const required = intakeRequired(settingsRow, customerRow).gated
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
      missingFields: intakeMissing(fields, required),
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
