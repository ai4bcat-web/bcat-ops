/**
 * Shared rate-con helpers for the Dispatch workstation.
 *
 * Kept here so the suggested-carrier flow and the carrier-offer flow build the same
 * PDF with the same fields.
 */
import { buildRateConPdf, rateConPdfBase64, type RateConInput } from '@/lib/carrierRateCon'
import { quickPayTiersOf, tierFor } from '@/lib/quickPay'
import type {
  CarrierContactRecord,
  CarrierRecord,
  Division,
  LoadCarrierRecord,
  RateConRequiredField,
  ShipmentBundle,
  TmsSettings,
} from '@/types/tms'

const DEFAULT_REQUIRED_FIELDS: RateConRequiredField[] = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER']

export function buildRateConInput(
  bundle: ShipmentBundle,
  loadCarrier: LoadCarrierRecord,
  carrier: CarrierRecord,
  settings: TmsSettings | null,
  divisions: Division[],
): RateConInput {
  const load = bundle.loads[0]
  const division = divisions.find((d) => d.key === load?.divisionKey) ?? null

  const charges = bundle.charges
    .filter(
      (c) =>
        c.side === 'CARRIER' &&
        (c.loadCarrierId == null || c.loadCarrierId === loadCarrier.id),
    )
    .map((c) => ({ label: c.label || c.code, amountCents: c.amountCents }))
  const totalCents = charges.reduce((sum, c) => sum + c.amountCents, 0)

  const tier =
    loadCarrier.quickPayDays != null
      ? tierFor(loadCarrier.quickPayDays, quickPayTiersOf(settings))
      : null

  return {
    division,
    carrier: {
      name: carrier.name ?? loadCarrier.carrierName ?? 'Carrier',
      mcNumber: carrier.mcNumber ?? loadCarrier.carrierMc ?? null,
      dotNumber: carrier.dotNumber ?? null,
      phone: carrier.phone ?? null,
      email: carrier.email ?? null,
    },
    loadCarrier,
    loadNumber: load?.loadNumber ?? load?.id ?? '',
    equipmentType: load?.equipmentType ?? null,
    commodity: load?.commodity ?? null,
    weightLbs: load?.weight ?? null,
    stops: (load?.stops ?? []).map((s) => {
      const visibility = (s.refs ?? []).filter(
        (r) => r.visibility === 'CARRIER' || r.visibility === 'ALL',
      )
      return {
        kind: s.type === 'pickup' ? 'PICKUP' : 'DELIVERY',
        name: s.name ?? null,
        address: s.address?.street ?? null,
        city: s.address?.city ?? s.city ?? null,
        state: s.address?.state ?? null,
        zip: s.address?.zip ?? null,
        apptAt: s.appt ?? null,
        apptEnd: s.apptEnd ?? null,
        apptType: s.apptType ?? null,
        references: visibility.map((r) => ({
          label: r.label || r.code,
          value: r.value,
        })),
        instructions: s.stopNotes ?? null,
      }
    }),
    charges,
    totalCents,
    quickPay:
      tier && loadCarrier.quickPayFeeCents != null
        ? {
            days: tier.days,
            feeBps: tier.feeBps,
            feeCents: loadCarrier.quickPayFeeCents,
            netCents: (loadCarrier.carrierRateCents ?? totalCents) - loadCarrier.quickPayFeeCents,
          }
        : null,
    paymentTermsDays:
      loadCarrier.paymentTermsDays ?? settings?.defaultCarrierTermsDays ?? null,
    terms: settings?.rateConTerms ?? '',
    requiredFields:
      (settings?.rateConRequiredFields as RateConRequiredField[] | null) ??
      DEFAULT_REQUIRED_FIELDS,
  }
}

export { buildRateConPdf, rateConPdfBase64 }

export function rateConRecipients(
  carrier: CarrierRecord,
  contacts: CarrierContactRecord[],
): string[] {
  const fromContacts = contacts
    .filter((c) => c.active !== false && c.email)
    .filter((c) => c.rateConRecipient || c.types?.includes('DISPATCH'))
    .map((c) => c.email as string)
  const fallbacks = [carrier.dispatcherEmail, carrier.email].filter((e): e is string => Boolean(e))
  return Array.from(new Set([...fromContacts, ...fallbacks]))
}
