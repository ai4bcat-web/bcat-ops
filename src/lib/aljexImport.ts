/**
 * Aljex CSV import — shared parser and mapper.
 *
 * Kept in src/lib so the frontend can preview mappings and the backend Lambda
 * can run the same logic without duplicating it.
 */

export type AljexColumnTarget =
  | 'pro'
  | 'po'
  | 'pickupNumber'
  | 'customer'
  | 'customerMc'
  | 'originName'
  | 'originCity'
  | 'originState'
  | 'originZip'
  | 'destinationName'
  | 'destinationCity'
  | 'destinationState'
  | 'destinationZip'
  | 'pickupDate'
  | 'deliveryDate'
  | 'equipment'
  | 'commodity'
  | 'weight'
  | 'pieces'
  | 'miles'
  | 'customerRate'
  | 'carrierRate'
  | 'carrierName'
  | 'carrierMc'
  | 'invoiceNumber'
  | 'invoiceDate'
  | 'invoicePaidDate'
  | 'invoiceAmount'
  | 'carrierBillNumber'
  | 'carrierBillAmount'
  | 'status'

export type AljexColumnMapping = Partial<Record<AljexColumnTarget, string>>

export interface AljexRow {
  pro?: string
  po?: string
  pickupNumber?: string
  customer?: string
  customerMc?: string
  originName?: string
  originCity?: string
  originState?: string
  originZip?: string
  destinationName?: string
  destinationCity?: string
  destinationState?: string
  destinationZip?: string
  pickupDate?: string
  deliveryDate?: string
  equipment?: string
  commodity?: string
  weight?: number
  pieces?: number
  miles?: number
  customerRateCents?: number
  carrierRateCents?: number
  carrierName?: string
  carrierMc?: string
  invoiceNumber?: string
  invoiceDate?: string
  invoicePaidDate?: string
  invoiceAmountCents?: number
  carrierBillNumber?: string
  carrierBillAmountCents?: number
  status?: string
  rawStatus?: string
  note?: string
}

const HEADER_ALIASES: Record<AljexColumnTarget, string[]> = {
  pro: ['Pro #', 'PRO', 'ProNumber', 'Pro No'],
  po: ['PO #', 'TMS ID', 'TmsId', 'Order #'],
  pickupNumber: ['PU #', 'Pickup #', 'PuNumber'],
  customer: ['Customer', 'Shipper', 'Customer Name'],
  customerMc: ['Customer MC', 'Shipper MC', 'Cust MC'],
  originName: ['Origin', 'Shipper Name', 'Pickup Name'],
  originCity: ['Origin City', 'From City'],
  originState: ['Origin State', 'From State'],
  originZip: ['Origin Zip', 'From Zip'],
  destinationName: ['Destination', 'Consignee Name', 'Delivery Name'],
  destinationCity: ['Destination City', 'To City'],
  destinationState: ['Destination State', 'To State'],
  destinationZip: ['Destination Zip', 'To Zip'],
  pickupDate: ['Pickup Date', 'Ship Date', 'Pickup At'],
  deliveryDate: ['Delivery Date', 'Deliver By', 'Delivery At'],
  equipment: ['Equipment', 'Equip Type', 'Trailer Type'],
  commodity: ['Commodity', 'Description', 'Freight Desc'],
  weight: ['Weight', 'Weight Lbs', 'Total Weight'],
  pieces: ['Pieces', 'Qty', 'Pallets'],
  miles: ['Miles', 'Trip Miles', 'Distance'],
  customerRate: ['Customer Rate', 'Revenue', 'Sell Rate', 'Total Rate'],
  carrierRate: ['Carrier Rate', 'Cost', 'Buy Rate', 'Pay Rate'],
  carrierName: ['Carrier', 'Carrier Name', 'Booked Carrier'],
  carrierMc: ['Carrier MC', 'Carrier MC #'],
  invoiceNumber: ['Invoice #', 'Invoice Number', 'AR Invoice'],
  invoiceDate: ['Invoice Date', 'Invoiced At'],
  invoicePaidDate: ['Paid Date', 'Paid At', 'Payment Date'],
  invoiceAmount: ['Invoice Amount', 'AR Amount'],
  carrierBillNumber: ['Bill #', 'Carrier Bill #', 'AP Invoice'],
  carrierBillAmount: ['Bill Amount', 'AP Amount'],
  status: ['Status', 'Shipment Status', 'Load Status'],
}

/** Strip surrounding whitespace and collapse inner spaces for matching. */
export function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** Case-insensitive, punctuation-tolerant header match. */
function headerMatches(candidate: string, wanted: string): boolean {
  const a = normalizeHeader(candidate).replace(/[^a-z0-9]/g, '')
  const b = normalizeHeader(wanted).replace(/[^a-z0-9]/g, '')
  return a === b
}

/**
 * Guess the Aljex → canonical mapping from the raw CSV header row.
 * Unmatched headers are ignored. Conflicts resolve to the first alias listed.
 */
export function guessAljexMapping(headers: string[]): AljexColumnMapping {
  const mapping: AljexColumnMapping = {}
  const used = new Set<string>()
  for (const [target, aliases] of Object.entries(HEADER_ALIASES) as [AljexColumnTarget, string[]][]) {
    for (const alias of aliases) {
      const idx = headers.findIndex((h) => !used.has(h) && headerMatches(h, alias))
      if (idx >= 0) {
        mapping[target] = headers[idx]
        used.add(headers[idx])
        break
      }
    }
  }
  return mapping
}

function getCell(
  headers: string[],
  cells: string[],
  mapping: AljexColumnMapping,
  target: AljexColumnTarget,
): string | undefined {
  const header = mapping[target]
  if (!header) return undefined
  const idx = headers.indexOf(header)
  if (idx < 0 || idx >= cells.length) return undefined
  const v = cells[idx].trim()
  return v || undefined
}

function parseDollarsToCents(value: string | undefined): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n * 100)
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  return n
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  // ISO or YYYY-MM-DD
  const iso = Date.parse(trimmed)
  if (!Number.isNaN(iso)) return new Date(iso).toISOString().slice(0, 10)
  // Common US short dates
  const m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
  if (m) {
    let year = Number(m[3])
    if (year < 100) year += year < 50 ? 2000 : 1900
    const month = Number(m[1])
    const day = Number(m[2])
    const date = new Date(year, month - 1, day)
    if (!Number.isNaN(date.getTime()) && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  return trimmed
}

function normalizeStatus(raw: string | undefined): { status: string | undefined; note?: string } {
  if (!raw) return { status: undefined }
  const v = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  const map: Record<string, string> = {
    open: 'OPEN',
    new: 'OPEN',
    available: 'OPEN',
    building: 'OPEN',
    covered: 'BOOKED',
    booked: 'BOOKED',
    dispatched: 'DISPATCHED',
    assigned: 'DISPATCHED',
    loading: 'LOADING',
    'at pickup': 'LOADING',
    'picked up': 'IN_TRANSIT',
    'en route': 'IN_TRANSIT',
    'in transit': 'IN_TRANSIT',
    'arrived at delivery': 'UNLOADING',
    unloading: 'UNLOADING',
    delivered: 'DELIVERED',
    'on hold': 'ON_HOLD',
    hold: 'ON_HOLD',
    canceled: 'CANCELED',
    cancelled: 'CANCELED',
    invoiced: 'DELIVERED',
    billed: 'DELIVERED',
    paid: 'DELIVERED',
  }
  const status = map[v]
  if (!status) return { status: 'OPEN', note: `Unknown status "${raw.trim()}"; treated as OPEN` }
  return { status }
}

/** Map one CSV row into the canonical AljexRow using the supplied mapping. */
export function mapAljexRow(headers: string[], cells: string[], mapping: AljexColumnMapping): AljexRow {
  const row: AljexRow = {}

  row.pro = getCell(headers, cells, mapping, 'pro')
  row.po = getCell(headers, cells, mapping, 'po')
  row.pickupNumber = getCell(headers, cells, mapping, 'pickupNumber')
  row.customer = getCell(headers, cells, mapping, 'customer')
  row.customerMc = getCell(headers, cells, mapping, 'customerMc')

  row.originName = getCell(headers, cells, mapping, 'originName')
  row.originCity = getCell(headers, cells, mapping, 'originCity')
  row.originState = getCell(headers, cells, mapping, 'originState')
  row.originZip = getCell(headers, cells, mapping, 'originZip')

  row.destinationName = getCell(headers, cells, mapping, 'destinationName')
  row.destinationCity = getCell(headers, cells, mapping, 'destinationCity')
  row.destinationState = getCell(headers, cells, mapping, 'destinationState')
  row.destinationZip = getCell(headers, cells, mapping, 'destinationZip')

  row.pickupDate = parseDate(getCell(headers, cells, mapping, 'pickupDate'))
  row.deliveryDate = parseDate(getCell(headers, cells, mapping, 'deliveryDate'))

  row.equipment = getCell(headers, cells, mapping, 'equipment')
  row.commodity = getCell(headers, cells, mapping, 'commodity')
  row.weight = parseInteger(getCell(headers, cells, mapping, 'weight'))
  row.pieces = parseInteger(getCell(headers, cells, mapping, 'pieces'))
  row.miles = parseInteger(getCell(headers, cells, mapping, 'miles'))

  row.customerRateCents = parseDollarsToCents(getCell(headers, cells, mapping, 'customerRate'))
  row.carrierRateCents = parseDollarsToCents(getCell(headers, cells, mapping, 'carrierRate'))
  row.carrierName = getCell(headers, cells, mapping, 'carrierName')
  row.carrierMc = getCell(headers, cells, mapping, 'carrierMc')

  row.invoiceNumber = getCell(headers, cells, mapping, 'invoiceNumber')
  row.invoiceDate = parseDate(getCell(headers, cells, mapping, 'invoiceDate'))
  row.invoicePaidDate = parseDate(getCell(headers, cells, mapping, 'invoicePaidDate'))
  row.invoiceAmountCents = parseDollarsToCents(getCell(headers, cells, mapping, 'invoiceAmount'))

  row.carrierBillNumber = getCell(headers, cells, mapping, 'carrierBillNumber')
  row.carrierBillAmountCents = parseDollarsToCents(getCell(headers, cells, mapping, 'carrierBillAmount'))

  const rawStatus = getCell(headers, cells, mapping, 'status')
  if (rawStatus) {
    row.rawStatus = rawStatus
    const normalized = normalizeStatus(rawStatus)
    row.status = normalized.status
    if (normalized.note) row.note = normalized.note
  }

  return row
}

/**
 * Parse a CSV body into raw header + cell rows.
 * Handles quoted fields, commas inside quotes, doubled quotes, CRLF, and a BOM.
 * Empty quoted fields become ''.
 */
export function parseCsvRows(csvText: string): { headers: string[]; rows: string[][] } {
  const text = csvText.replace(/^\uFEFF/, '')
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"') {
      // Keep quote characters in the line so splitCsvLine can unescape them;
      // this pass only tracks quote state so newlines inside quotes don't split.
      current += ch
      if (inQuotes && next === '"') {
        current += next
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if ((ch === '\r' && next === '\n') || ch === '\n') {
      if (inQuotes) {
        current += '\n'
      } else {
        lines.push(current)
        current = ''
      }
      if (ch === '\r') i++
    } else {
      current += ch
    }
  }
  if (current || lines.length === 0) lines.push(current)

  const nonempty = lines.filter((line) => line.trim() !== '')
  if (nonempty.length === 0) return { headers: [], rows: [] }

  const headers = splitCsvLine(nonempty[0])
  const rows = nonempty.slice(1).map((line) => splitCsvLine(line, headers.length))
  return { headers, rows }
}

function splitCsvLine(line: string, expectedColumns?: number): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = line[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)

  if (expectedColumns != null) {
    while (cells.length < expectedColumns) cells.push('')
    if (cells.length > expectedColumns) cells.length = expectedColumns
  }
  return cells
}
