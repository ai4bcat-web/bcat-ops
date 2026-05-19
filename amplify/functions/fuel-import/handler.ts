/**
 * fuel-import Lambda
 *
 * Called by the BCAT Intake Bridge Apps Script when Gmail receives an EFS
 * Transaction Report email (label: efs-report).
 *
 * Flow:
 *  1. Verify shared webhook secret
 *  2. Extract download URL(s) from email body
 *  3. Fetch the .txt report file
 *  4. Parse with embedded EFS parser
 *  5. Batch-dedup against existing DynamoDB records
 *  6. Insert new FuelTransaction items
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE_NAME = process.env.FUEL_TX_TABLE_NAME!
const SECRET     = process.env.FUEL_IMPORT_SECRET!

// ── Card number → Equipment ID mapping (mirrors SEED_EQUIPMENT in useAppStore) ──
const CARD_MAP: Record<string, string> = {
  '00049': 'eq-mnmpi9jxwd12', // truck 009
  '00056': 'eq-mnevxuyoxpd8', // truck 299
  '00031': 'eq-mnevuhxgs5jf', // truck 530
  '00007': 'eq-mnevvq8q6tcx', // truck 685
  '00023': 'eq-mnevwst30vwt', // truck 780
}

// ── Embedded EFS parser (mirrors src/lib/parsers/efsTransactionReport.ts) ────

type ItemCategory = 'FUEL' | 'SCALE' | 'CASH_ADVANCE' | 'OTHER'

interface ParsedFuelTransaction {
  cardNumber:       string
  transactionDate:  string
  invoiceNumber:    string
  unitNumber:       string
  driverName:       string
  odometer:         number | null
  locationName:     string
  city:             string
  state:            string
  fees:             number
  fuelType:         string
  itemCategory:     ItemCategory
  pricePerUnit:     number
  quantity:         number
  amount:           number
  currency:         string
  sourceLineNumber: number
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ''))
}

const FUEL_ITEM_TYPES = new Set(['ULSD', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

function categorize(itemType: string): ItemCategory {
  const u = itemType.toUpperCase().trim()
  if (FUEL_ITEM_TYPES.has(u)) return 'FUEL'
  if (u === 'SCLE') return 'SCALE'
  if (u === 'CASH') return 'CASH_ADVANCE'
  return 'OTHER'
}

const TX_LINE_RE = /[A-Z]\s{2}USD\/Gallon\s*$/
const RIGHT_RE   = /(\S+)\s+(?:([\d,]+\.?\d*)\s+)?([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([A-Z])\s+USD\/Gallon/
const CARD_RE    = /^\s{4,8}(\d{5})\s/
const DATE_RE    = /(\d{4}-\d{2}-\d{2})/

function parseEfsReport(text: string): ParsedFuelTransaction[] {
  const lines = text.split('\n')
  const transactions: ParsedFuelTransaction[] = []

  let prevCard = '', prevDate = '', prevInvoice = '', prevUnit = '', prevDriver = ''
  let prevOdo: number | null = null
  let prevLocation = '', prevCity = '', prevState = ''

  // Grand totals for validation
  const grandTotals: Record<string, { amount: number; quantity: number }> = {}
  let grandFees = 0
  let inGrandTotals = false

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i]
    const lineNum = i + 1

    if (/Grand Totals/i.test(line)) { inGrandTotals = true; continue }

    if (inGrandTotals) {
      const fuelM  = line.match(/^\s+(\S+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
      if (fuelM && !line.includes('Total Fuel')) {
        grandTotals[fuelM[1]] = { amount: parseNum(fuelM[2]), quantity: parseNum(fuelM[3]) }
      }
      const feesM = line.match(/^\s+Fees\s+([\d,]+\.?\d*)/)
      if (feesM) grandFees = parseNum(feesM[1])
      continue
    }

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
      cardNumber      = cardM[1]
      transactionDate = dateM[1]

      const dateEnd   = line.indexOf(transactionDate) + transactionDate.length
      const fuelStart = line.indexOf(rightM[0])
      const middle    = line.slice(dateEnd, fuelStart)
      const tokens    = middle.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean)

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

      if (tokens[idx] !== undefined && /^[\d,]+\.\d+$/.test(tokens[idx])) {
        fees = parseNum(tokens[idx])
      }

      prevCard = cardNumber; prevDate = transactionDate; prevInvoice = invoiceNumber
      prevUnit = unitNumber; prevDriver = driverName; prevOdo = odometer
      prevLocation = locationName; prevCity = city; prevState = state
    } else {
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

  // Validate amounts against grand totals
  const summedByType: Record<string, { amount: number; quantity: number }> = {}
  let summedFees = 0
  for (const tx of transactions) {
    if (!summedByType[tx.fuelType]) summedByType[tx.fuelType] = { amount: 0, quantity: 0 }
    summedByType[tx.fuelType].amount   = Math.round((summedByType[tx.fuelType].amount + tx.amount) * 100) / 100
    summedByType[tx.fuelType].quantity = Math.round((summedByType[tx.fuelType].quantity + tx.quantity) * 100) / 100
    summedFees = Math.round((summedFees + tx.fees) * 100) / 100
  }

  const errors: string[] = []
  for (const [type, reported] of Object.entries(grandTotals)) {
    const parsed    = summedByType[type]
    const parsedAmt = parsed?.amount ?? 0
    const amtDiff   = Math.abs(parsedAmt - reported.amount)
    if (amtDiff > 0.02) {
      errors.push(`${type} amount mismatch: parsed $${parsedAmt.toFixed(2)} vs reported $${reported.amount.toFixed(2)}`)
    }
    if (FUEL_ITEM_TYPES.has(type.toUpperCase())) {
      const parsedQty = parsed?.quantity ?? 0
      const qtyDiff   = Math.abs(parsedQty - reported.quantity)
      if (qtyDiff > 0.02) {
        errors.push(`${type} quantity mismatch: parsed ${parsedQty.toFixed(3)} vs reported ${reported.quantity.toFixed(3)}`)
      }
    }
  }
  if (grandFees > 0 && Math.abs(summedFees - grandFees) > 0.02) {
    errors.push(`Fees mismatch: parsed $${summedFees.toFixed(2)} vs reported $${grandFees.toFixed(2)}`)
  }

  if (errors.length > 0) throw new Error(`EFS parse validation failed:\n${errors.join('\n')}`)

  return transactions
}

function dedupKey(tx: ParsedFuelTransaction): string {
  return `${tx.transactionDate}|${tx.cardNumber}|${tx.invoiceNumber}|${tx.fuelType}`
}

// ── URL extraction ────────────────────────────────────────────────────────────

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"<>)]+/g) ?? []
  return [...new Set(matches)]
}

// ── Lambda handler ────────────────────────────────────────────────────────────

interface WebhookPayload {
  secret:         string
  gmailMessageId: string
  bodyText:       string
  bodyHtml?:      string
  subject?:       string
  receivedAt?:    string
}

interface LambdaEvent {
  body?: string | null
}

function respond(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const handler = async (event: LambdaEvent) => {
  console.log('[fuel-import] invoked')

  let payload: WebhookPayload
  try {
    payload = JSON.parse(event.body ?? '{}') as WebhookPayload
  } catch {
    return respond(400, { error: 'invalid JSON body' })
  }

  if (!SECRET || payload.secret !== SECRET) {
    console.warn('[fuel-import] 401 — bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const { gmailMessageId, bodyText, bodyHtml, subject, receivedAt } = payload
  console.log('[fuel-import] processing email', { gmailMessageId, subject })

  // ── Extract and fetch report URL ──────────────────────────────────────────
  const allUrls = extractUrls((bodyText ?? '') + '\n' + (bodyHtml ?? ''))
  console.log('[fuel-import] candidate URLs:', allUrls)

  let reportText: string | null = null
  let reportFileName = 'efs-report.txt'

  for (const url of allUrls) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) continue
      const text = await res.text()
      if (text.includes('USD/Gallon')) {
        reportText = text
        // Extract filename from URL if available
        const urlFilename = url.split('/').pop()?.split('?')[0]
        if (urlFilename && urlFilename.endsWith('.txt')) reportFileName = urlFilename
        console.log('[fuel-import] found report at', url, 'filename:', reportFileName)
        break
      }
    } catch (err) {
      console.warn('[fuel-import] failed to fetch URL', url, err)
    }
  }

  if (!reportText) {
    console.error('[fuel-import] no EFS report found in email body')
    return respond(422, { error: 'no EFS report URL found in email body', gmailMessageId })
  }

  // ── Parse report ──────────────────────────────────────────────────────────
  let transactions: ParsedFuelTransaction[]
  try {
    transactions = parseEfsReport(reportText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[fuel-import] parse error:', msg)
    return respond(422, { error: `parse failed: ${msg}`, gmailMessageId })
  }
  console.log('[fuel-import] parsed', transactions.length, 'transactions')

  // ── Batch dedup: scan all existing FuelTransaction dedup keys ────────────
  const existingKeys = new Set<string>()
  let lastKey: Record<string, unknown> | undefined = undefined

  do {
    const scanResult = await dynamo.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'transactionDate, cardNumber, invoiceNumber, fuelType',
      ExclusiveStartKey: lastKey,
    }))
    for (const item of scanResult.Items ?? []) {
      const k = `${item.transactionDate}|${item.cardNumber}|${item.invoiceNumber ?? ''}|${item.fuelType}`
      existingKeys.add(k)
    }
    lastKey = scanResult.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  console.log('[fuel-import] existing dedup keys loaded:', existingKeys.size)

  // ── Insert new transactions ───────────────────────────────────────────────
  const now        = new Date().toISOString()
  const importedAt = receivedAt ?? now
  let added = 0, skipped = 0, errors = 0

  for (const tx of transactions) {
    const key = dedupKey(tx)
    if (existingKeys.has(key)) {
      skipped++
      continue
    }

    const id      = randomUUID()
    const truckId = CARD_MAP[tx.cardNumber] ?? null

    try {
      await dynamo.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          __typename:      'FuelTransaction',
          id,
          transactionDate: tx.transactionDate,
          cardNumber:      tx.cardNumber,
          invoiceNumber:   tx.invoiceNumber || null,
          unitNumber:      tx.unitNumber || null,
          truckId,
          driverName:      tx.driverName || null,
          odometer:        tx.odometer ?? null,
          locationName:    tx.locationName || null,
          city:            tx.city || null,
          state:           tx.state || null,
          fees:            tx.fees,
          fuelType:        tx.fuelType,
          itemCategory:    tx.itemCategory,
          pricePerUnit:    tx.pricePerUnit,
          quantity:        tx.quantity,
          amount:          tx.amount,
          currency:        tx.currency,
          sourceFile:      reportFileName,
          importedAt,
          createdAt:       now,
          updatedAt:       now,
          _version:        1,
          _deleted:        null,
          _lastChangedAt:  Date.now(),
        },
      }))
      existingKeys.add(key) // prevent duplicate within same report
      added++
    } catch (err) {
      console.error('[fuel-import] failed to insert', tx.invoiceNumber, tx.fuelType, err)
      errors++
    }
  }

  console.log('[fuel-import] done — added:', added, 'skipped:', skipped, 'errors:', errors)
  return respond(200, {
    status: 'ok',
    gmailMessageId,
    reportFile: reportFileName,
    parsed: transactions.length,
    added,
    skipped,
    errors,
  })
}
