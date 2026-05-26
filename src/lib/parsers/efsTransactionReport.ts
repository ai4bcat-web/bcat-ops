/**
 * Parser for EFS Transaction Reports (fixed-width text format).
 *
 * Transaction lines are identified by the "USD/Gallon" suffix.
 * Continuation lines (blank Card # area) inherit the prior row's header fields
 * so that multi-product stops (e.g. DEFD + ULSD on same invoice) are captured.
 *
 * Handles any item type (ULSD, DEFD, SCLE, CASH, etc.). Non-fuel items like
 * SCLE (scale fees) may have no per-unit price — treated as pricePerUnit = 0.
 */

export type ItemCategory = 'FUEL' | 'SCALE' | 'CASH_ADVANCE' | 'OTHER'

export interface ParsedFuelTransaction {
  cardNumber:      string
  transactionDate: string
  invoiceNumber:   string
  unitNumber:      string
  driverName:      string
  odometer:        number | null
  locationName:    string
  city:            string
  state:           string
  fees:            number
  fuelType:        string        // raw item type from report (ULSD, DEFD, SCLE, CASH, …)
  itemCategory:    ItemCategory
  pricePerUnit:    number        // 0 for flat-rate items (SCLE, CASH, etc.)
  quantity:        number
  amount:          number
  currency:        string
  sourceLineNumber: number
}

export interface ParsedTotals {
  byFuelType:  Record<string, { amount: number; quantity: number }>
  fees:        number
  totalFuel:   number
  totalAmount: number
}

export interface ParsedReport {
  transactions: ParsedFuelTransaction[]
  grandTotals:  ParsedTotals
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ''))
}

// Fuel definition: ULSD, FUEL (generic diesel code), DEF/DEFD, and bio-diesel blends.
// Confirmed permanent — all three (ULSD + FUEL + DEFD) count as fuel everywhere in the app.
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

function categorize(itemType: string): ItemCategory {
  const u = itemType.toUpperCase().trim()
  if (FUEL_ITEM_TYPES.has(u)) return 'FUEL'
  if (u === 'SCLE') return 'SCALE'
  if (u === 'CASH') return 'CASH_ADVANCE'
  if (u === 'CDSL') return 'OTHER'  // cardlock/discount diesel — excluded from fuel totals
  console.warn(`[EFS parser] Unknown item type encountered: ${u} — stored as OTHER`)
  return 'OTHER'
}

// Transaction line: ends with a single letter (N/C debit indicator), 2–4 spaces, "USD/Gallon"
// The URL-download format uses 2 spaces; the DAILY FUEL REPORT TEXT format uses 3 spaces.
const TX_LINE_RE = /[A-Z]\s{2,4}USD\/Gallon\s*$/

// Right-side fields.  Price is OPTIONAL for flat-rate items (e.g. SCLE scale fees).
//   Fuel format:  itemType price  qty  amount  DB  USD/Gallon
//   Flat format:  itemType        qty  amount  DB  USD/Gallon
// The optional group (?:(price)\s+)? backtracks gracefully when price is absent.
const RIGHT_RE = /(\S+)\s+(?:([\d,]+\.?\d*)\s+)?([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([A-Z])\s+USD\/Gallon/

// Card number at the very start of the line (2–8 leading spaces, then 5 digits).
// URL-download format uses 6 spaces; DAILY FUEL REPORT TEXT format uses 2 spaces.
const CARD_RE = /^\s{2,8}(\d{5})\s/

// ISO date (YYYY-MM-DD) or US date (M/D/YYYY) anywhere in the line
const DATE_RE = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/

function normalizeDate(s: string): string {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return s
}

// Total Records in the report header line
const TOTAL_RECORDS_RE = /Total Records:\s*(\d+)/i

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseEfsTransactionReport(text: string): ParsedReport {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const transactions: ParsedFuelTransaction[] = []

  // Context inherited by continuation rows (multi-product stops)
  let prevCard     = ''
  let prevDate     = ''
  let prevInvoice  = ''
  let prevUnit     = ''
  let prevDriver   = ''
  let prevOdo: number | null = null
  let prevLocation = ''
  let prevCity     = ''
  let prevState    = ''

  const grandTotals: ParsedTotals = { byFuelType: {}, fees: 0, totalFuel: 0, totalAmount: 0 }
  let inGrandTotals = false

  // Group-section accumulators — used when the report has no Grand Totals section
  const groupSumByFuelType: Record<string, { amount: number; quantity: number }> = {}
  let groupSumFees = 0
  let inGroupSection = false

  // Total Records stated in the report header (used for count validation)
  let totalRecords: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i]
    const lineNum = i + 1

    // Parse "Total Records: N" from header
    if (!inGrandTotals && !inGroupSection && totalRecords === null) {
      const trM = line.match(TOTAL_RECORDS_RE)
      if (trM) totalRecords = parseInt(trM[1], 10)
    }

    // ── Grand totals section ──────────────────────────────────────────────────
    if (/Grand Totals/i.test(line)) { inGrandTotals = true; inGroupSection = false; continue }

    if (inGrandTotals) {
      // "  ULSD   3,757.82   681.01"  or  "  SCLE   19.75   2"
      const fuelM = line.match(/^\s+(\S+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
      if (fuelM && !line.includes('Total Fuel')) {
        grandTotals.byFuelType[fuelM[1]] = { amount: parseNum(fuelM[2]), quantity: parseNum(fuelM[3]) }
      }
      const feesM = line.match(/^\s+Fees\s+([\d,]+\.?\d*)/)
      if (feesM) grandTotals.fees = parseNum(feesM[1])

      const totalsM = line.match(/^\s+Totals\s+([\d,]+\.?\d*)/)
      if (totalsM && !line.includes('Total Fuel')) grandTotals.totalAmount = parseNum(totalsM[1])

      const tfM = line.match(/^\s+Total Fuel\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
      if (tfM) grandTotals.totalFuel = parseNum(tfM[1])
      continue
    }

    // ── Group section subtotals ───────────────────────────────────────────────
    if (/^\s+Group:/i.test(line)) { inGroupSection = true; continue }

    if (inGroupSection) {
      if (!TX_LINE_RE.test(line)) {
        // Non-transaction line inside group section — accumulate subtotals
        const fuelM = line.match(/^\s+(\S+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
        if (fuelM) {
          const type = fuelM[1]
          if (type !== 'Fees' && type !== 'Totals' && !line.includes('Total Fuel')) {
            if (!groupSumByFuelType[type]) groupSumByFuelType[type] = { amount: 0, quantity: 0 }
            groupSumByFuelType[type].amount   = round2(groupSumByFuelType[type].amount   + parseNum(fuelM[2]))
            groupSumByFuelType[type].quantity = round2(groupSumByFuelType[type].quantity + parseNum(fuelM[3]))
          }
        }
        const feesM = line.match(/^\s+Fees\s+([\d,]+\.?\d*)/)
        if (feesM) groupSumFees = round2(groupSumFees + parseNum(feesM[1]))
        continue
      }
      // TX_LINE_RE match inside group section: only exit group mode for a real
      // transaction (has card# + date). A match without both is a malformed
      // summary line — skip it rather than treating it as a continuation row.
      if (!line.match(CARD_RE) || !line.match(DATE_RE)) continue
      inGroupSection = false
    }

    // ── Transaction lines ─────────────────────────────────────────────────────
    if (!TX_LINE_RE.test(line)) continue

    const rightM = line.match(RIGHT_RE)
    if (!rightM) continue

    const fuelType     = rightM[1]
    const pricePerUnit = rightM[2] !== undefined ? parseNum(rightM[2]) : 0
    const quantity     = parseNum(rightM[3])
    const amount       = parseNum(rightM[4])
    const itemCategory = categorize(fuelType)

    const cardM = line.match(CARD_RE)
    const dateM = line.match(DATE_RE)

    let cardNumber: string, transactionDate: string, invoiceNumber: string
    let unitNumber: string, driverName: string, odometer: number | null
    let locationName: string, city: string, state: string
    let fees = 0

    if (cardM && dateM) {
      // ── Primary row ───────────────────────────────────────────────────────
      cardNumber      = cardM[1]
      const rawDate   = dateM[1]
      transactionDate = normalizeDate(rawDate)

      // Slice between the date and the start of the right-side match
      const dateEnd   = line.indexOf(rawDate) + rawDate.length
      const fuelStart = line.indexOf(rightM[0])
      const middle    = line.slice(dateEnd, fuelStart)
      const tokens    = middle.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean)

      // Layout: invoice, unit, [driver?], odometer, location, city, state[, fee?]
      // If token at driver position is pure digits → driver was blank
      invoiceNumber = tokens[0] ?? ''
      unitNumber    = tokens[1] ?? ''

      let idx = 2
      if (tokens[idx] !== undefined && /^\d+$/.test(tokens[idx])) {
        driverName = ''
        odometer   = parseInt(tokens[idx], 10)
        idx++
      } else {
        driverName = tokens[idx] ?? ''
        idx++
        odometer   = tokens[idx] ? parseInt(tokens[idx].replace(/,/g, ''), 10) : null
        idx++
      }

      locationName = tokens[idx] ?? ''; idx++
      city         = tokens[idx] ?? ''; idx++
      state        = tokens[idx] ?? ''; idx++

      // Optional fee field (e.g. "2.00" from LOVES transaction fee)
      if (tokens[idx] !== undefined && /^[\d,]+\.\d+$/.test(tokens[idx])) {
        fees = parseNum(tokens[idx])
      }

      // Save context for any continuation rows that follow
      prevCard = cardNumber; prevDate = transactionDate; prevInvoice = invoiceNumber
      prevUnit = unitNumber; prevDriver = driverName; prevOdo = odometer
      prevLocation = locationName; prevCity = city; prevState = state
    } else {
      // ── Continuation row — inherits header from the previous primary row ───
      cardNumber = prevCard; transactionDate = prevDate; invoiceNumber = prevInvoice
      unitNumber = prevUnit; driverName = prevDriver; odometer = prevOdo
      locationName = prevLocation; city = prevCity; state = prevState
      fees = 0
    }

    transactions.push({
      cardNumber, transactionDate, invoiceNumber, unitNumber, driverName, odometer,
      locationName, city, state, fees,
      fuelType, itemCategory, pricePerUnit, quantity, amount,
      currency: 'USD', sourceLineNumber: lineNum,
    })
  }

  // ── Grand-total validation ────────────────────────────────────────────────
  // If no Grand Totals section was present (DAILY FUEL REPORT TEXT format),
  // fall back to the accumulated per-group subtotals.
  if (Object.keys(grandTotals.byFuelType).length === 0 && Object.keys(groupSumByFuelType).length > 0) {
    Object.assign(grandTotals.byFuelType, groupSumByFuelType)
    if (grandTotals.fees === 0 && groupSumFees > 0) grandTotals.fees = groupSumFees
  }

  const summedByType: Record<string, { amount: number; quantity: number }> = {}
  let summedFees = 0

  for (const tx of transactions) {
    if (!summedByType[tx.fuelType]) summedByType[tx.fuelType] = { amount: 0, quantity: 0 }
    summedByType[tx.fuelType].amount   = round2(summedByType[tx.fuelType].amount + tx.amount)
    summedByType[tx.fuelType].quantity = round2(summedByType[tx.fuelType].quantity + tx.quantity)
    summedFees = round2(summedFees + tx.fees)
  }

  const errors: string[] = []

  // Count validation from "Total Records: N" header
  if (totalRecords !== null && transactions.length !== totalRecords) {
    errors.push(`Transaction count mismatch: parsed ${transactions.length}, header says ${totalRecords}`)
  }

  for (const [type, reported] of Object.entries(grandTotals.byFuelType)) {
    const parsed    = summedByType[type]
    const parsedAmt = parsed?.amount ?? 0
    const parsedQty = parsed?.quantity ?? 0

    const amtDiff = Math.abs(parsedAmt - reported.amount)
    if (amtDiff > 0.02) {
      errors.push(
        `${type} amount mismatch: parsed $${parsedAmt.toFixed(2)}, report says $${reported.amount.toFixed(2)} (diff $${amtDiff.toFixed(2)})`,
      )
    }

    // Only validate gallon quantities for fuel types (gal doesn't apply to SCLE, CASH, etc.)
    if (FUEL_ITEM_TYPES.has(type.toUpperCase())) {
      const qtyDiff = Math.abs(parsedQty - reported.quantity)
      if (qtyDiff > 0.02) {
        errors.push(
          `${type} quantity mismatch: parsed ${parsedQty.toFixed(3)} gal, report says ${reported.quantity.toFixed(3)} gal (diff ${qtyDiff.toFixed(3)})`,
        )
      }
    }
  }

  const feesDiff = Math.abs(summedFees - grandTotals.fees)
  if (grandTotals.fees > 0 && feesDiff > 0.02) {
    errors.push(
      `Fees mismatch: parsed $${summedFees.toFixed(2)}, report says $${grandTotals.fees.toFixed(2)} (diff $${feesDiff.toFixed(2)})`,
    )
  }

  if (errors.length > 0) {
    throw new Error(`EFS report validation failed:\n${errors.join('\n')}`)
  }

  return { transactions, grandTotals }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Dedup key for a transaction (used to skip already-imported records) */
export function fuelTxDedupKey(
  tx: Pick<ParsedFuelTransaction, 'transactionDate' | 'cardNumber' | 'invoiceNumber' | 'fuelType'>,
): string {
  return `${tx.transactionDate}|${tx.cardNumber}|${tx.invoiceNumber}|${tx.fuelType}`
}
