/**
 * tms-spot-quoter — the suggestion snapshot stored on a request (`SpotRequest.suggestion`).
 *
 * This Lambda has no DAT client and no read on the lane-sample table, so the market answer
 * is the labelled stub (`stubRateView`, `stub:true`, "no DAT call was made") and the sample
 * list is empty: the result is a STUB-basis, floor-respecting price, never `GOOD`, never
 * auto-sendable. The rep's page replaces it with the live PRICE_FROM_MARKET + lane history
 * numbers when it prices the quote. A request that cannot be priced (non-FTL, missing lane or
 * equipment) gets `null`: "manual — no suggestion".
 */
import type { SpotRequestRecord } from '../../../src/types/tms'
import { estimateMiles, stubRateView } from '../../../src/lib/integrations/rateView'
import { destinationStop, originStop } from '../../../src/lib/spot/normalize'
import { suggestSpotRate } from '../../../src/lib/spot/suggest'
import type { SpotSuggestion } from '../../../src/lib/spot/types'
import type { SpotDeps } from './deps'
import { jsonOf, type Row } from './store'

export async function computeSuggestion(
  deps: Pick<SpotDeps, 'store' | 'now'>,
  row: Pick<SpotRequestRecord, 'extraction' | 'customerId'>,
): Promise<SpotSuggestion | null> {
  const extraction = row.extraction
  if (!extraction) return null
  const from = originStop(extraction)
  const to = destinationStop(extraction)
  if (!from?.city || !from.state || !to?.city || !to.state || !extraction.equipmentType) return null
  const [settings, customer] = await Promise.all([
    deps.store.getTmsSettings(),
    row.customerId ? deps.store.getCustomer(row.customerId) : Promise.resolve<Row | null>(null),
  ])
  const market = stubRateView({
    originCity: from.city,
    originState: from.state,
    destinationCity: to.city,
    destinationState: to.state,
    equipmentType: extraction.equipmentType,
    pickupDate: extraction.pickupDate,
    miles: estimateMiles(from.state, to.state),
  })
  return suggestSpotRate({
    extraction,
    market,
    samples: [],
    customerId: row.customerId ?? null,
    settings: settings ? { ...settings, marginTargetBpsByMode: jsonOf(settings.marginTargetBpsByMode) } as never : null,
    customer: customer as never,
    nowIso: deps.now().toISOString(),
  })
}
