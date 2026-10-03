/**
 * The driver's settlement, built from what the staff page already holds.
 *
 * Staff answer "what is the driver seeing?" by asking the driver, which is slow and
 * unreliable — a driver on a truck describing a screen. This builds the same Settlement
 * the driver app receives so it can be rendered in their own components on a desktop.
 *
 * It is a PREVIEW, not a login. The data is read through the staff session rather than the
 * driver's, so it shows the same figures the office is already looking at — which is the
 * point: if the two ever disagree, the bug is upstream of both.
 *
 * Faithfulness is the whole value, so this mirrors buildSettlement in
 * amplify/functions/driver-app-api/settlement.ts field for field: a held load shows $0
 * rather than a figure nobody is paying, the factoring fee is always listed even at zero,
 * and trips sort by date. Where the two could drift, they share the same pure helpers.
 */
import { tripPayAmount, FACTORING_FEE_LABEL, type DriverPaySettingInput } from '@/lib/driverPay'
import { PAY_HOLD_LABEL, type PayHoldReason } from '@/lib/payHold'
import { weekLabel } from '@/features/driver-pay/week'
import type { OwnerOpTrip } from '@/lib/ownerOperatorTrips'
import type { OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'
import type { Settlement, SettlementTrip, FactoringFields } from '@/features/driver-app/driverApi'

export type PreviewTrip = SettlementTrip & {
  factoring?: FactoringFields | null
  heldReason?: string | null
  heldLabel?: string | null
}

/** The eleven OTR fields the driver app shows, from the readiness the staff page resolved. */
function factoringFor(trip: OwnerOpTrip): FactoringFields | null {
  const r = trip.readiness
  if (!r) return null
  const missing = r.missingDocuments ?? []
  const value = (key: string): string | null => {
    const v = (r.payload as Record<string, unknown>)?.[key]
    return v == null ? null : String(v)
  }
  return {
    invoiceNo: value('InvoiceNo'),
    poNumber: value('PoNumber'),
    brokerMc: value('BrokerMC'),
    invoiceAmount: r.payload?.InvoiceAmount != null ? Number(r.payload.InvoiceAmount) : null,
    invoiceDate: value('InvoiceDate'),
    fromCity: value('FromCity'),
    fromState: value('FromState'),
    fromZip: value('FromZip'),
    toCity: value('ToCity'),
    toState: value('ToState'),
    toZip: value('ToZip'),
    podPresent: !missing.includes('POD'),
    rateconPresent: !missing.includes('Rate confirmation'),
    blocked: (r.missingFields?.length ?? 0) > 0 || missing.length > 0,
  }
}

/**
 * Build the Settlement the driver would be served for this week.
 *
 * `heldTrips` comes from the staff row and is the same rule the server applies: a load
 * with no POD is off the check. A held trip shows $0 here exactly as it does there, so
 * nobody previews a figure the driver is not being paid.
 */
export function previewSettlement(row: OwnerOperatorPayRow, periodStart: string): Settlement {
  const heldById = new Map<string, PayHoldReason>(
    row.heldTrips.map(({ trip, reason }) => [trip.id, reason]),
  )
  const rateModel = row.setting as unknown as DriverPaySettingInput

  const trips: PreviewTrip[] = [...row.trips]
    .sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt))
    .map((t) => {
      const held = heldById.get(t.id) ?? null
      return {
        id: t.id,
        date: t.deliveredAt.slice(0, 10),
        loadId: t.loadId || null,
        origin: t.origin || null,
        destination: t.destination || null,
        miles: t.miles ?? null,
        rate: t.freightAmount,
        // A held load shows $0, not a figure the driver would expect in the bank.
        amount: held ? 0 : tripPayAmount(t.freightAmount, rateModel),
        factoring: factoringFor(t),
        heldReason: held,
        heldLabel: held ? PAY_HOLD_LABEL[held] : null,
      }
    })

  return {
    weekStart: periodStart,
    weekLabel: weekLabel(periodStart),
    trips,
    grossPay: row.statement.gross,
    // Always listed, even at $0: a driver who never sees the line cannot know the fee
    // exists, and its absence reads as an error.
    deductions: [
      { label: FACTORING_FEE_LABEL, amount: row.statement.factoringFee },
      ...row.deductions.map((d) => ({ label: d.label, amount: d.amount })),
    ],
    credits: row.credits.map((c) => ({ label: c.label ?? c.reasonCode, amount: c.amount })),
    debits: [
      ...row.fixedDebits.map((d) => ({ label: d.label, amount: d.amount })),
      ...row.debits.map((d) => ({ label: d.label ?? d.reasonCode, amount: d.amount })),
    ],
    checkAmount: row.statement.checkAmount,
  }
}
