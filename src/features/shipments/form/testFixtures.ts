/** Shared by the form lib tests: a fully filled form and a stand-in for what the server stores. */
import type { Stop } from '@/types'
import type { CustomerRecord, ShipmentBundle, SpecialRequirements } from '@/types/tms'
import { toCharges, toSaveOrderFormInput } from './mapping'
import { emptyValues, syncCarrierSlots, type ShipmentFormValues } from './model'

export function filledValues(): ShipmentFormValues {
  const v = emptyValues()
  v.mode = 'FTL'
  v.ship = {
    ...v.ship,
    equipmentType: 'Dry Van', revDivision: 'BCAT', revSubdivision: 'FOOD', officeLabel: '',
    customerMiles: '640', truckMiles: '655', footage: '48', pieces: '24', weightLbs: '42000', billableWeightLbs: '42500',
    disableMileage: true, freightClass: '70', description: 'Canned goods', declaredValue: '25000.50',
    liftgate: true, inside: false,
    temp: { on: true, unit: 'C', min: '1', max: '3', preCool: '0' },
    palletExchange: { on: true, palletsIn: '10', palletsOut: '12' },
    tarps: { on: true, size: '8ft' },
    flags: {
      permits: true, fsma: true, oversized: true, hazmat: true, escorts: true, seal: true, blind: true,
      customsBonded: true, osd: true, strapsChains: true, noBroker: true, team: true, hot: true, labor: true,
      highRisk: true, massRelease: true, tonu: false,
    },
  }
  v.customer = {
    ...v.customer, id: 'cus-1', billToId: 'bt-1', contactId: 'ct-1', hours: '8-5',
    emails: ['a@example.invalid', 'b@example.invalid', 'c@example.invalid', 'd@example.invalid', 'e@example.invalid', 'f@example.invalid'],
    refNo: 'PO-77',
  }
  const mk = (over: Partial<ShipmentFormValues['stops'][number]>) => ({ ...v.stops[0], ...over })
  v.stops = [
    mk({ id: 'stp-a', type: 'pickup', name: 'ZZ Shipper', locationId: 'loc-1', address1: '1 Dock Rd', address2: 'Bay 4', city: 'Chicago', state: 'IL', zip: '60601', country: 'US', contact: 'Pat', phone: '(312) 555-0100', hours: '6a-2p', email: 'dock@example.invalid', refNo: 'PU-1', ready: '2026-11-10T08:00', appt: '2026-11-10T09:30', note: 'Call ahead', pieces: '24', weightLbs: '42000' }),
    mk({ id: 'stp-b', type: 'pickup', name: 'ZZ Second Pick', city: 'Joliet', state: 'IL', zip: '60431', refNo: 'PU-2', ready: '2026-11-10T11:00', pieces: '', weightLbs: '' }),
    mk({ id: 'stp-c', type: 'delivery', name: 'ZZ Receiver', city: 'Dallas', state: 'TX', zip: '75201', refNo: 'DE-9', appt: '2026-11-12T10:00', mustDeliver: '2026-11-12T17:00', note: 'Dock 9' }),
  ]
  v.roles = { salesRepId: 'rep-1', serviceRepId: 'rep-2', dispatcherAssignedId: '', tariff: 'T-1', quoteId: '' }
  v.more = {
    specialInstructions: 'x'.repeat(420), bolNotes: 'y'.repeat(260), rateConNotes: 'Rate con words', notes: 'Internal',
    references: [{ code: 'BOL', label: 'BOL #', value: 'B-1', level: 'ORDER', visibility: 'ALL' }],
    items: [{ id: 'frt-2', handlingUnit: 'SKID', qty: 2, description: 'Extra', weightLbs: 100 }],
  }
  v.rates = {
    customer: { rateType: 'PER_HOUR', hours: '8', lhRate: '75', lineId: '' },
    carrier: { rateType: 'FLAT', hours: '', lhRate: '', lineId: '', payPct: '', maxRate: '1500' },
    fscPercent: '12.5', fscPerMile: '', fscLineId: '', smr: '40',
    lines: [
      { id: '', carrierLineId: '', release: 'R1', paidTo: '', code: 'LUMPER', label: 'Lumper', carrierAmount: '', customerAmount: '150', note: 'receipt' },
      { id: '', carrierLineId: '', release: 'R2', paidTo: '', code: 'DETENTION', label: 'Detention', carrierAmount: '', customerAmount: '90.25', note: '' },
    ],
    passthrough: [],
  }
  v.carrier = { ...v.carrier, originCity: 'Gary', originState: 'IN', emptyMiles: '12' }
  return syncCarrierSlots(null, v)
}

export const CUSTOMER: CustomerRecord = {
  id: 'cus-1', name: 'ZZ Customer', createdAt: '', updatedAt: '', status: 'ACTIVE',
  // Factor-billed with an MC, so a filled form is factor-ready at booking (src/lib/factorReadyAtCreate).
  billingMethod: 'FACTOR', mcNumber: '123456',
  contacts: [{ id: 'ct-1', name: 'Pat', email: 'pat@example.invalid', types: ['PRIMARY'], notifications: ['DELIVERED'], active: true }],
  billToParties: [{ id: 'bt-1', name: 'ZZ Bill', isDefault: true }],
} as CustomerRecord

/** What the server would hold after SAVE_ORDER_FORM on a draft created for `values`. */
export function storedBundle(values: ShipmentFormValues, opts: { prior?: SpecialRequirements; status?: string } = {}): ShipmentBundle {
  const base = {
    shipment: { id: 'shp-1', number: 'S000001', status: opts.status ?? 'DRAFT', customerId: values.customer.id || null, customerName: values.customer.typedName, mode: values.mode, version: 3, updatedAt: 't1' },
    orders: [{ id: 'ord-1', shipmentId: 'shp-1', customerId: values.customer.id || null, mode: values.mode, updatedAt: 't1' }],
    loads: [{ id: 'ld-1', updatedAt: 't1', stops: [] as Stop[] }],
    loadCarriers: [], charges: [], financials: [], documents: [],
  } as unknown as ShipmentBundle
  const save = toSaveOrderFormInput(values, base, { draftSave: false })
  const sr: Record<string, unknown> = { ...(opts.prior ?? {}) }
  for (const [k, val] of Object.entries(save.order.specialRequirements ?? {})) {
    if (val === null || val === undefined) delete sr[k]
    else sr[k] = val
  }
  const lf = save.loadFields as Record<string, unknown>
  const charges = toCharges(values, { orderId: 'ord-1', loadId: 'ld-1' }).map((c, i) => ({
    ...c, id: c.id ?? `chg-${i}`, amountCents: c.calculatedBy === 'FLAT' ? c.rateCents * (c.count ?? 1) : 0, createdBy: 't', createdAt: '', updatedAt: '',
  }))
  const shipment = {
    ...(base.shipment as object), revDivision: values.ship.revDivision, revSubdivision: values.ship.revSubdivision,
    salesRepId: values.roles.salesRepId || null, osd: values.ship.flags.osd,
  }
  return {
    ...base,
    shipment,
    orders: [{ ...(base.orders[0] as object), ...save.order, specialRequirements: sr }],
    loads: [{ id: 'ld-1', updatedAt: 't1', stops: save.stops, miles: lf.miles, weight: lf.weight, commodity: lf.commodity, pieces: lf.pieces, cargoValueCents: lf.cargoValueCents, hot: lf.hot, tmsId: values.customer.refNo }],
    charges,
  } as unknown as ShipmentBundle
}
