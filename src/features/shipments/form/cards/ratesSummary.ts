/**
 * Step AR: the money numbers the summary rail shows (Customer / Carrier totals, Net $, Profit %)
 * and the dot colour. One pure selector over `financialPreview`, so the rail never repeats the
 * pricing math the Rates card, the shipment detail and the server use.
 */
import { resolveMargin } from '@/lib/flowDefaults'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import { financialPreview, type FinancialPreview } from '../mapping'
import { carrierSlotsOf, type CarrierSlot, type ShipmentFormValues } from '../model'

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

/** The name a carrier row goes by: the booked snapshot, the directory carrier, the typed name, else "Carrier" / "Carrier N". */
export function carrierLabel(slot: CarrierSlot, index: number, directory: readonly { id: string; name: string }[], numbered = false): string {
  return slot.carrierName.trim()
    || directory.find((c) => c.id === slot.carrierId)?.name
    || slot.typedName.trim()
    || (index === 0 && !numbered ? 'Carrier' : `Carrier ${index + 1}`)
}

/** Each carrier's gross, in slot order, for the rail's hover breakdown. Empty with one carrier. */
export function carrierBreakdown(
  values: ShipmentFormValues, preview: FinancialPreview, directory: readonly { id: string; name: string }[],
): { slot: string; label: string; totalCents: number }[] {
  const slots = carrierSlotsOf(values)
  if (slots.length < 2) return []
  return slots.map((s, i) => ({ slot: s.slot, label: carrierLabel(s, i, directory, true), totalCents: preview.carriers.find((c) => c.slot === s.slot)?.totalCents ?? 0 }))
}

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
