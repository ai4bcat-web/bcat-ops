/**
 * SYNTHETIC fixtures in the exact column layout of the 2026-11-08 AP aging / AP expected / active shipments files.
 * ZZ names, PRO band 900000+, no real row. Test-only (imported by the layout and engine tests).
 */
export const AP_AGING_HEADER = [
  'Vendor', 'Pay to', 'Pro #', 'Aging Date', 'Due Date', 'Vend Invoice Date', 'Vend Invoice #', 'Voucher #', 'Days',
  '0 - 30 Days', '31 - 60 Days', '61 - 90 Days', '91 - 120 Days', '120 Days or More', 'Vendor Old System ID', 'Amount Paid',
  'Payment ID #', 'Revenue Type', 'Vendor ID', 'Sales Rep', 'Office', 'PJ Hold', 'Super Hold', 'Peding Claim',
  'Latest AP Note Date', 'Latest AP Note User', 'Latest AP Note', 'FUTURE USE', 'Check/Draft', 'Customer', 'Customer Account #', 'Orginal Required',
]

export const FIXTURE_AP_TOTAL_CENTS = 8_340_720
export const FIXTURE_AP_BILLS = 67
export const FIXTURE_VENDORS = 5

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
export const csvOf = (rows: string[][]): string => rows.map((r) => r.map(q).join(',')).join('\n') + '\n'
const money = (cents: number): string => (cents / 100).toFixed(2)

export interface FixtureBill {
  pro: string
  vendorId: string
  vendorName: string
  payTo: string
  cents: number
  bucket: '0 - 30 Days' | '31 - 60 Days'
  agingDate: string
  dueDate: string
  checkDraft: string
}

/** 67 bills totalling exactly $83,407.20: 54 in 0-30, 13 in 31-60, 40 with a pay-to that differs from the vendor. */
export function fixtureBills(): FixtureBill[] {
  const out: FixtureBill[] = []
  for (let i = 0; i < FIXTURE_AP_BILLS; i++) {
    const v = i % FIXTURE_VENDORS
    const old = i >= 54
    out.push({
      pro: String(900001 + i),
      vendorId: String(900000001 + v),
      vendorName: `ZZ VENDOR ${v}`,
      payTo: i < 40 ? `ZZ FACTOR ${v}` : `ZZ VENDOR ${v}`,
      cents: i === 66 ? 420_720 : 120_000,
      bucket: old ? '31 - 60 Days' : '0 - 30 Days',
      agingDate: old ? '09/25/26' : '10/20/26',
      dueDate: old ? '10/25/26' : '11/19/26',
      checkDraft: i % 2 === 0 ? 'NC' : 'ND',
    })
  }
  return out
}

export function apAgingCsv(bills: FixtureBill[] = fixtureBills()): string {
  const rows = bills.map((b, i) => {
    const r = AP_AGING_HEADER.map(() => '')
    const set = (name: string, v: string): void => {
      r[AP_AGING_HEADER.indexOf(name)] = v
    }
    set('Vendor', b.vendorName)
    set('Pay to', b.payTo)
    set('Pro #', b.pro)
    set('Aging Date', b.agingDate)
    set('Due Date', b.dueDate)
    set('Vend Invoice Date', b.agingDate)
    set('Vend Invoice #', i % 2 ? b.pro : 'LINE')
    set('Days', b.bucket === '0 - 30 Days' ? '18' : '43')
    set(b.bucket, money(b.cents))
    set('Amount Paid', money(b.cents))
    set('Payment ID #', String(800000 + i))
    set('Vendor ID', b.vendorId)
    set('PJ Hold', 'N')
    set('Check/Draft', b.checkDraft)
    set('Customer', 'ZZ CUSTOMER')
    set('Customer Account #', '900001')
    return r
  })
  return csvOf([AP_AGING_HEADER, ...rows])
}

export const AP_EXPECTED_HEADER = ['Vendor', 'Pay to', 'Pro #', 'Amount', 'Ship Date', 'Loaded Date', 'Delivered Date', 'Release Date', 'Customer Inv Date', 'Customer', 'Office', 'Salesrep', 'Assigned Dispatcher', 'Actual Dispatcher', 'Carrier ID', 'MC #', 'DOT #']

export interface FixtureExpected {
  pro: string
  cents: number
  ship: string
  carrierId?: string
}

export function apExpectedCsv(rows: FixtureExpected[]): string {
  return csvOf([
    AP_EXPECTED_HEADER,
    ...rows.map((e) => {
      const r = AP_EXPECTED_HEADER.map(() => '')
      const set = (name: string, v: string): void => {
        r[AP_EXPECTED_HEADER.indexOf(name)] = v
      }
      set('Vendor', 'ZZ VENDOR 0')
      set('Pay to', 'ZZ VENDOR 0')
      set('Pro #', e.pro)
      set('Amount', money(e.cents))
      set('Ship Date', e.ship)
      set('Delivered Date', e.ship)
      set('Customer', 'ZZ CUSTOMER')
      set('Carrier ID', e.carrierId ?? '')
      return r
    }),
  ])
}

export const ACTIVE_HEADER = ['shipment_mass_release', 'shipment_status', 'shipment_pro', 'shipment_equipment_type_code', 'shipment_customer_ref_num', 'shipment_load_description', 'revenue_type_rev_type', 'sales rep name', 'customer name', 'carrier name', 'shipment_customer_total_rates', 'shipment_carrier_total_rates', 'shipment_gross_profit', 'shipment_net_margin', 'pick_stop_1_name', 'pickup', 'pick_stop_last_name', 'consignee', 'dispatcher assgn name', 'shipment_created_at', 'shipment_miles_truck', 'shipment_miles_customer', 'pick_stop_1_ready_or_deliver_date', 'pick_stop_1_location_zip', 'pick_stop_last_location_zip', 'service rep name']

export interface FixtureActive {
  pro: string
  status?: string
  customer?: string
  carrier?: string
  customerRate?: string
  carrierRate?: string
  from?: string
  fromCity?: string
  fromZip?: string
  to?: string
  toCity?: string
  toZip?: string
}

export function activeCsv(rows: FixtureActive[]): string {
  return csvOf([
    ACTIVE_HEADER,
    ...rows.map((a) => {
      const r = ACTIVE_HEADER.map(() => '')
      const set = (name: string, v: string): void => {
        r[ACTIVE_HEADER.indexOf(name)] = v
      }
      set('shipment_status', a.status ?? 'COVERED')
      set('shipment_pro', a.pro)
      set('customer name', a.customer ?? 'ZZ CUSTOMER')
      set('carrier name', a.carrier ?? 'ZZ VENDOR 0')
      set('shipment_customer_total_rates', a.customerRate ?? '1750.0')
      set('shipment_carrier_total_rates', a.carrierRate ?? '1300.0')
      set('pick_stop_1_name', a.from ?? 'ZZ SHIPPER')
      set('pickup', a.fromCity ?? 'ZZTOWN, WI')
      set('pick_stop_last_name', a.to ?? 'ZZ CONSIGNEE')
      set('consignee', a.toCity ?? 'ZZVILLE, NY')
      set('pick_stop_1_location_zip', a.fromZip ?? '53089')
      set('pick_stop_last_location_zip', a.toZip ?? '10022')
      return r
    }),
  ])
}
