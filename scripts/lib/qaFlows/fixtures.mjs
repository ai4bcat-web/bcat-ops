import { randomUUID } from 'node:crypto'

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

/** A ZZ customer (archived in cleanup). */
export async function zzCustomer(ctx, label, extra = {}) {
  const a = ctx.id.admin
  const cust = await a.dir('UPSERT_CUSTOMER', {
    name: `ZZ QAF ${label} ${ctx.ts}`, creditLimitCents: 100_000_000,
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ QAF Contact', email: `zz-qaf-${ctx.ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `zz-qaf-bt-${ctx.ts}-${label}`, name: 'ZZ QAF Bill To', isDefault: false }],
    ...extra,
  })
  const id = String((cust.customer ?? cust).id)
  ctx.cleanup.push(async () => {
    const row = (await a.gql('query($id: ID!) { getCustomer(id: $id) { id updatedAt } }', { id })).getCustomer
    if (row) await a.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) })
  })
  return id
}

/** A submitted ZZ shipment (voided in cleanup). `reference` adds a PO reference. */
export async function zzShipment(ctx, customerId, { reference = null, submit = true } = {}) {
  const a = ctx.id.admin
  const day = today()
  let bundle = await a.ship('CREATE_SHIPMENT', { customerId })
  const shipmentId = bundle.shipment.id
  ctx.cleanup.push(async () => {
    const row = (await a.gql('query($id: ID!) { getShipment(id: $id) { id voidedAt updatedAt } }', { id: shipmentId })).getShipment
    if (row && !row.voidedAt) await a.ship('VOID_SHIPMENT', { shipmentId, reason: 'ZZ QAF verification fixture', expectedUpdatedAt: String(row.updatedAt) })
  })
  bundle = await a.ship('SAVE_ORDER_FORM', {
    shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
    order: {
      mode: 'FTL', equipmentType: 'Dry Van',
      references: reference ? [{ code: 'PO', label: 'Purchase order', value: reference, level: 'ORDER', visibility: 'CUSTOMER' }] : [],
    },
    stops: [
      { type: 'pickup', name: 'ZZ QAF Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
      { type: 'delivery', name: 'ZZ QAF Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T21:00:00.000Z` },
    ],
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 150000, count: 1 }],
  })
  if (submit) await a.ship('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
  bundle = await a.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  return { shipmentId, loadId: bundle.loads?.[0]?.id ?? null, bundle }
}
