/**
 * Keeps the factoring queue's prefilled broker MC in step with the customer.
 *
 * Send to Factor copies the customer's MC onto the queue row (`otrManualFields.BrokerMC`),
 * where a person can still correct it, and a typed value always outranks the customer record
 * when the invoice is assembled. So fixing the MC on the customer afterwards changed nothing:
 * the row kept submitting the old number (PRO 20062, 17 Nov 2026: MC edited on the profile,
 * OTR still asked about the old one).
 *
 * When a customer's MC changes, every unsubmitted row of that customer whose copy still equals
 * the OLD MC is moved to the new one and its broker-check result is cleared so it is asked again.
 * A row whose MC a person typed to something else is left alone, and so is a row already
 * with OTR.
 */

export interface QueueRowLike {
  id?: unknown
  customerId?: unknown
  status?: unknown
  otrInvoiceId?: unknown
  otrManualFields?: unknown
}

/** MC / DOT digits only, leading zeros dropped, so "MC 0965058" and "965058" compare equal. */
export const mcDigits = (v: unknown): string => String(v ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '')

const OPEN_STATUSES = new Set(['NEED_TO_FACTOR'])

/** The BrokerMC exactly as stored on the row (the condition a write has to match). */
export function rawManualBrokerMc(row: QueueRowLike): string {
  const raw = row.otrManualFields
  const map = typeof raw === 'string' ? safeParse(raw) : (raw as Record<string, unknown> | null | undefined)
  return String(map?.BrokerMC ?? '')
}

const manualBrokerMc = (row: QueueRowLike): string => mcDigits(rawManualBrokerMc(row))

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The rows that carry the customer's old MC as a prefilled copy and have not gone to OTR. */
export function rowsToRefresh(rows: readonly QueueRowLike[], customerId: string, oldMc: unknown, newMc: unknown): QueueRowLike[] {
  const before = mcDigits(oldMc)
  const after = mcDigits(newMc)
  if (!after || before === after) return []
  return rows.filter(
    (r) =>
      r.customerId === customerId &&
      OPEN_STATUSES.has(String(r.status ?? '')) &&
      !r.otrInvoiceId &&
      // No old MC on the customer means nothing was prefilled from it; a typed value stays.
      before !== '' &&
      manualBrokerMc(r) === before,
  )
}

export interface QueueMcDeps {
  scanQueue: () => Promise<QueueRowLike[]>
  /**
   * SET BrokerMC (map path) and clear the broker check, only while the stored BrokerMC still
   * equals `storedMc` and the row is unsubmitted; false when the row moved on meanwhile.
   */
  setBrokerMc: (rowId: string, storedMc: string, newMc: string) => Promise<boolean>
  now: () => string
}

export interface QueueMcResult {
  refreshed: string[]
  skipped: string[]
}

export async function refreshQueueBrokerMc(
  deps: QueueMcDeps,
  customerId: string,
  oldMc: unknown,
  newMc: unknown,
): Promise<QueueMcResult> {
  const result: QueueMcResult = { refreshed: [], skipped: [] }
  const targets = rowsToRefresh(await deps.scanQueue(), customerId, oldMc, newMc)
  for (const row of targets) {
    const id = String(row.id)
    const ok = await deps.setBrokerMc(id, rawManualBrokerMc(row), String(newMc ?? '').trim())
    ;(ok ? result.refreshed : result.skipped).push(id)
  }
  return result
}
