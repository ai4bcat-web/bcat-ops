/**
 * Who a bill of lading can be e-mailed to: the people already on the shipment. Stop
 * contacts (shipper / consignee), each active carrier's dispatcher, and the driver
 * addresses the form keeps in its extras. Nothing is ticked by default — a BOL e-mail
 * is a deliberate act — and the customer's billing contacts are not offered (the
 * customer copy goes through Documents → E-mail).
 */
import type { RecipientOption } from '@/features/carriers/components/rateConRecipients'
import { emailKey, isEmailAddress } from '@/lib/emailAddress'
import type { EmailBolInput } from '@/lib/apiClient'
import { readExtras } from '../form/model'
import type { LocationRecord, ShipmentBundle } from '@/types/tms'

export type BolParty = EmailBolInput['party']

export interface BolRecipientOption extends RecipientOption {
  party: BolParty
}

function clean(value: string | null | undefined): string | null {
  const v = value?.trim()
  return v && isEmailAddress(v) ? v : null
}

type BundleStop = NonNullable<ShipmentBundle['loads'][number]['stops']>[number]

/** First valid address wins per stop: the paperwork contact, then the stop contact, then the saved location. */
function stopEmail(stop: BundleStop, locations: LocationRecord[]): string | null {
  const location = stop.locationId ? locations.find((l) => l.id === stop.locationId) ?? null : null
  return clean(stop.documentContact?.email) ?? clean(stop.contact?.email) ?? clean(location?.apptContactEmail)
}

/** Options in display order; an address offered twice keeps its first label. */
export function bolRecipientOptions(bundle: ShipmentBundle, locations: LocationRecord[]): BolRecipientOption[] {
  const out: BolRecipientOption[] = []
  const add = (email: string | null, label: string, party: BolParty) => {
    if (!email || out.some((o) => emailKey(o.email) === emailKey(email))) return
    out.push({ email, label, party })
  }

  const stops = bundle.loads.flatMap((l) => l.stops ?? [])
  const pickups = stops.filter((s) => s.type === 'pickup')
  for (const stop of stops) {
    const role = stop.type === 'pickup' ? 'Shipper contact' : 'Consignee contact'
    const nth = stop.type === 'pickup' && pickups.length > 1 ? ` ${pickups.indexOf(stop) + 1}` : ''
    const place = stop.name?.trim()
    add(stopEmail(stop, locations), place ? `${role}${nth} · ${place}` : `${role}${nth}`, 'CUSTOMER')
  }

  const extras = readExtras(bundle.orders[0])
  for (const lc of bundle.loadCarriers.filter((c) => c.status === 'ACTIVE')) {
    const who = lc.carrierName?.trim()
    add(clean(lc.dispatcherEmail), who ? `Dispatcher · ${who}` : 'Dispatcher', 'DISPATCHER')

    // Slot entries carry the driver addresses; the legacy single-carrier key backs a load with no slots.
    const own = extras?.carriers?.find((c) => c.loadCarrierId === lc.id)
      ?? (extras?.carrier?.loadCarrierId === lc.id ? extras.carrier : undefined)
    const drivers: [string | undefined, string | null | undefined][] = [
      [own?.driverEmail1, lc.driverName],
      [own?.driverEmail2, lc.driver2Name],
    ]
    drivers.forEach(([email, name], i) => {
      add(clean(email), name?.trim() ? `Driver · ${name.trim()}` : `Driver ${i + 1}`, 'DRIVER')
    })
  }
  return out
}

/**
 * The party the e-mail is recorded as: the picked option's when every pick is the same
 * kind, otherwise (mixed picks, typed addresses) CARRIER — the widest audience, which the
 * Lambda treats like the others for a plain BOL.
 */
export function bolParty(to: string[], options: BolRecipientOption[]): BolParty {
  const parties = new Set<BolParty>()
  for (const email of to) {
    const option = options.find((o) => emailKey(o.email) === emailKey(email))
    parties.add(option ? option.party : 'CARRIER')
  }
  return parties.size === 1 ? [...parties][0] : 'CARRIER'
}
