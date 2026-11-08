/**
 * SYNTHETIC fixture in the exact 44-column layout of the 2026-11-07 Aljex AR report: 296 open invoices totalling
 * exactly $357,753.44. ZZ names, PRO band 900001+, no real row. Test-only.
 *
 * Shape: 50 invoices of the factored customer, 54 of the two Danisco accounts (Aljex terms 90), 62 invoices that bill
 * a different party than the customer, 3 partially paid, every aging bucket populated. `Balance Due`, `Total
 * Exposure` and `Unbilled` carry a customer-level total repeated on every row, as the real report does.
 */
export const AR_HEADER = [
  'Pro #', 'Invoice Date', 'Inv Post Date', 'Ship Date', 'Delivery Date', 'Bill to', 'Bill to Account #', 'Address', 'Address 2', 'City', 'State', 'Zip',
  'Phone #', 'Fax #', 'Email', 'Contact', 'Customer', 'Customer Account #', 'Customer Ref #', 'Invoice Amount', 'Days',
  '0 - 30 Days', '31 - 60 Days', '61 - 90 Days', '91 - 120 Days', '120 Days or More', 'Assigned Collector', 'Actual Dispatcher', 'Salesrep', 'Office',
  'Team', 'Customer Type', 'Revenue Type', 'Old System ID', 'Load #', 'AR Note Date', 'AR Note', 'Customer Terms', 'Unbilled', 'Balance Due',
  'Total Exposure', 'Previous Payments', 'Due Date', 'Service Rep', "Reference #'s",
]

export const FIXTURE_AR_TOTAL_CENTS = 35_775_344
export const FIXTURE_AR_INVOICES = 296
export const FIXTURE_AR_AS_OF = '2026-11-07'
export const FIXTURE_AR_FACTORED_ACCOUNT = '910001'
export const FIXTURE_AR_FACTORED_COUNT = 50
export const FIXTURE_AR_DANISCO_COUNT = 54
export const FIXTURE_AR_BILL_TO_DIFFERS = 62
export const FIXTURE_AR_PARTIAL = [{ index: 7, paidCents: 110_000 }, { index: 150, paidCents: 140_000 }, { index: 260, paidCents: 95_000 }]
export const FIXTURE_AR_PAID_CENTS = 345_000
export const FIXTURE_AR_ACCOUNTS = ['910001', '910002', '910003', '910004', '910005', '910006', '100338', '100629']

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
export const arCsvOf = (rows: string[][]): string => rows.map((r) => r.map(q).join(',')).join('\n') + '\n'
const money = (cents: number): string => (cents / 100).toFixed(2)
const mdy = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}`
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface FixtureArInvoice {
  index: number
  pro: string
  invoiceDate: string
  dueDate: string
  days: number
  /** 0..4 = the aging column. */
  bucketIndex: number
  openCents: number
  paidCents: number
  customerAccount: string
  customerName: string
  billToAccount: string
  billToName: string
  termsDays: number
}

/** Bucket k holds days in [lo, hi]. */
const BUCKET_DAYS: Array<[number, number]> = [[3, 30], [33, 60], [63, 90], [93, 120], [125, 700]]

export function fixtureArInvoices(): FixtureArInvoice[] {
  const out: FixtureArInvoice[] = []
  let billToDiffers = 0
  for (let i = 0; i < FIXTURE_AR_INVOICES; i++) {
    const danisco = i >= 50 && i < 50 + FIXTURE_AR_DANISCO_COUNT
    const account = i < FIXTURE_AR_FACTORED_COUNT ? FIXTURE_AR_FACTORED_ACCOUNT : danisco ? (i % 2 ? '100338' : '100629') : `91000${2 + (i % 5)}`
    const bucketIndex = i % 5
    const [lo, hi] = BUCKET_DAYS[bucketIndex]
    const days = lo + ((i * 13) % (hi - lo + 1))
    const invoiceDate = addDays(FIXTURE_AR_AS_OF, -days)
    const termsDays = danisco ? 90 : i % 50 === 3 ? 15 : 30
    const differs = i % 4 === 1 && billToDiffers < FIXTURE_AR_BILL_TO_DIFFERS
    if (differs) billToDiffers += 1
    out.push({
      index: i,
      pro: String(900_001 + i),
      invoiceDate,
      dueDate: addDays(invoiceDate, termsDays),
      days,
      bucketIndex,
      openCents: 80_000 + ((i * 7_919) % 80_000),
      paidCents: FIXTURE_AR_PARTIAL.find((p) => p.index === i)?.paidCents ?? 0,
      customerAccount: account,
      customerName: `ZZ CUSTOMER ${account}`,
      billToAccount: differs ? '920001' : account,
      billToName: differs ? 'ZZ BILLING PARTY' : `ZZ CUSTOMER ${account}`,
      termsDays,
    })
  }
  // The last invoice absorbs the rounding so the file totals exactly $357,753.44.
  const rest = out.slice(0, -1).reduce((n, r) => n + r.openCents, 0)
  out[out.length - 1].openCents = FIXTURE_AR_TOTAL_CENTS - rest
  return out
}

export function arCsv(invoices: FixtureArInvoice[] = fixtureArInvoices()): string {
  const col = Object.fromEntries(AR_HEADER.map((h, i) => [h, i])) as Record<string, number>
  const rows = invoices.map((r) => {
    const row = AR_HEADER.map(() => '')
    const set = (h: string, v: string): void => {
      row[col[h]] = v
    }
    set('Pro #', r.pro)
    set('Invoice Date', mdy(r.invoiceDate))
    set('Bill to', r.billToName)
    set('Bill to Account #', r.billToAccount)
    set('Address', '1 ZZ STREET')
    set('City', 'ZZTOWN')
    set('State', 'WI')
    set('Zip', '53000')
    set('Customer', r.customerName)
    set('Customer Account #', r.customerAccount)
    set('Customer Ref #', `ZZREF${r.pro}`)
    set('Invoice Amount', money(r.openCents + r.paidCents))
    set('Days', String(r.days))
    set(['0 - 30 Days', '31 - 60 Days', '61 - 90 Days', '91 - 120 Days', '120 Days or More'][r.bucketIndex], money(r.openCents))
    set('Revenue Type', r.index % 2 ? 'I' : 'B')
    set('Load #', r.pro)
    set('Customer Terms', String(r.termsDays))
    // Customer-level totals repeated on every row: the importer must never read these.
    set('Unbilled', '999999.99')
    set('Balance Due', '999999.99')
    set('Total Exposure', '999999.99')
    set('Previous Payments', r.paidCents ? money(r.paidCents) : '')
    set('Due Date', mdy(r.dueDate))
    return row
  })
  return arCsvOf([AR_HEADER, ...rows])
}
