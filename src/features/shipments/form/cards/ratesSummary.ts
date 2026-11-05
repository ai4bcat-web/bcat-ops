/**
 * Step AR: the money numbers the summary rail shows (Customer / Carrier totals, Net $, Profit %)
 * and the dot colour. One pure selector over `financialPreview`, so the rail never repeats the
 * pricing math the Rates card, the shipment detail and the server use.
 */
import { resolveMargin } from '@/lib/flowDefaults'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import { financialPreview, type FinancialPreview } from '../mapping'
import type { ShipmentFormValues } from '../model'

/** green ≥ target, amber within 5 points under it, red below that. */
export type MarginTone = 'green' | 'amber' | 'red'

export interface RatesSummary {
  preview: FinancialPreview
  customerTotalCents: number
  carrierTotalCents: number
  netCents: number
  /** Percent with one decimal. */
  profitPct: number
  targetPct: number
  tone: MarginTone
  /** Nothing is priced yet: the rail shows dashes rather than a red 0.0%. */
  priced: boolean
}

const AMBER_BAND_PCT = 5

export function marginTone(profitPct: number, targetPct: number): MarginTone {
  if (profitPct >= targetPct) return 'green'
  return profitPct >= targetPct - AMBER_BAND_PCT ? 'amber' : 'red'
}

export function ratesSummary(
  values: ShipmentFormValues, customer: CustomerRecord | null, settings: TmsSettings | null,
): RatesSummary {
  const preview = financialPreview(values, customer, settings)
  const targetPct = resolveMargin(settings, customer, values.mode).targetBps / 100
  return {
    preview,
    customerTotalCents: preview.customerTotalCents,
    carrierTotalCents: preview.carrierTotalCents,
    netCents: preview.netCents,
    profitPct: preview.profitPct,
    targetPct,
    tone: marginTone(preview.profitPct, targetPct),
    priced: preview.customerTotalCents > 0,
  }
}
