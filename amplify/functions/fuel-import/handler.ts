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
 *  4. Parse with EFS parser (efsParser.ts)
 *  5. Batch-dedup against existing DynamoDB records
 *  6. Insert new FuelTransaction items
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { parseEfsReport, dedupKey, type ParsedFuelTransaction } from './efsParser'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE_NAME = process.env.FUEL_TX_TABLE_NAME!
const SECRET     = process.env.FUEL_IMPORT_SECRET!

// ── Card → Equipment ID mapping (mirrors SEED_EQUIPMENT in useAppStore) ─────
const CARD_MAP: Record<string, string> = {
  '00049': 'eq-mnmpi9jxwd12', // truck 009
  '00056': 'eq-mnevxuyoxpd8', // truck 299
  '00031': 'eq-mnevuhxgs5jf', // truck 530
  '00007': 'eq-mnevvq8q6tcx', // truck 685
  '00023': 'eq-mnevwst30vwt', // truck 780
}

// ── URL extraction ────────────────────────────────────────────────────────────
//
// Fleet One CardsJob URLs have the form:
//   https://manage.fleetone.com/cards/CardsJob.action?getJobFile&fileId=<uuid>.<ts>.jobdata
//
// Crucially, the notification email contains NO whitespace between the URL and
// the following sentence ("Please do not reply…"), so a generic "stop at
// whitespace" regex captures trailing text and produces a broken URL.
// We anchor the match on .jobdata to avoid this.
//
// The generic fallback still handles other URL shapes (e.g. presigned S3 links)
// that may appear in future email templates.

export function extractUrls(text: string): string[] {
  const urls: string[] = []

  // 1. Fleet One CardsJob — anchored at .jobdata
  const fleetOneRe = /https:\/\/manage\.fleetone\.com\/cards\/CardsJob\.action\?[^\s"<>]*?\.jobdata/gi
  for (const m of text.matchAll(fleetOneRe)) urls.push(m[0])

  // 2. Generic fallback for any other https URLs in the body
  const genericRe = /https?:\/\/[^\s"<>)]+/g
  for (const m of text.matchAll(genericRe)) {
    // Skip Fleet One URLs already captured above (they would be mangled by the
    // generic regex because of the missing delimiter after .jobdata)
    if (!m[0].includes('manage.fleetone.com')) urls.push(m[0])
  }

  return [...new Set(urls)]
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
