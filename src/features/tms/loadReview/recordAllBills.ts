/**
 * "Record all bills": one RECORD_BILL per live carrier, in booking order, each its own
 * transaction on the server. Sequenced here, not in a Lambda (AT-plan D3): the first
 * refusal stops the run, names its carrier, and leaves the carriers already recorded
 * recorded. A carrier whose bill already exists is skipped, so a re-run after a failure
 * only does what is left.
 */
import type { LoadCarrierRecord } from '@/types/tms'

export type RecordOutcomeStatus = 'recorded' | 'already' | 'failed' | 'skipped'

export interface RecordOutcome {
  loadCarrierId: string
  name: string
  status: RecordOutcomeStatus
  /** The server's own sentence, for `failed`. */
  message?: string
}

type BillTarget = Pick<LoadCarrierRecord, 'id' | 'carrierName' | 'invoiceId'>

export async function recordAllBills(
  carriers: readonly BillTarget[],
  record: (loadCarrierId: string) => Promise<unknown>,
): Promise<RecordOutcome[]> {
  const outcomes: RecordOutcome[] = []
  let stopped = false
  for (const carrier of carriers) {
    const base = { loadCarrierId: carrier.id, name: carrier.carrierName ?? 'Carrier' }
    if (stopped) { outcomes.push({ ...base, status: 'skipped' }); continue }
    if (carrier.invoiceId) { outcomes.push({ ...base, status: 'already' }); continue }
    try {
      await record(carrier.id)
      outcomes.push({ ...base, status: 'recorded' })
    } catch (err) {
      stopped = true
      outcomes.push({ ...base, status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }
  return outcomes
}
