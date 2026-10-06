/**
 * otr-status-sync — hourly mirror of OTR's invoice board onto the factoring queue.
 *
 * Read-only against OTR: it calls GET /invoices/{id} and writes the result back
 * onto the row. It never creates an invoice and never uploads a document, so a
 * bug here cannot factor a load.
 *
 * Scope: rows that have an otrInvoiceId and are not already terminal. "Paid" is
 * OTR's end state, so once a row reaches it we stop polling — otherwise every
 * historical invoice would be re-fetched every hour forever.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { OtrClient, OtrError, OTR_STAGING_BASE } from '../_shared/otrClient'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

const FACTORING_TABLE = process.env.FACTORING_ITEM_TABLE_NAME!

/*
 * Which invoices are finished, so we stop paying to ask about them.
 *
 * This used to be the single string 'Paid', compared against otrStatus both in the scan
 * filter and in the local-status decision. v2 answers with a status NUMBER, so the string
 * never matched anything: no invoice was ever recognised as terminal, every one of them was
 * re-polled every hour forever, and none was ever marked factored. The terminal set now
 * comes from the one module that knows OTR's statuses.
 */
import { otrStatusMeta, localStatusFor } from '../../../src/lib/otrInvoiceStatus'

type Row = Record<string, unknown>

export const handler = async () => {
  const client = new OtrClient({
    baseUrl: process.env.OTR_BASE_URL || OTR_STAGING_BASE,
    subscriptionKey: process.env.OTR_SUBSCRIPTION_KEY!,
    username: process.env.OTR_USERNAME!,
    password: process.env.OTR_PASSWORD!,
  })

  // Rows awaiting an OTR decision. The filter runs server-side so a growing
  // archive of paid invoices never reaches this function.
  const pending: Row[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: FACTORING_TABLE,
        /*
         * Server-side we only ask for rows that reached OTR at all; which of those are
         * finished is decided below, because a DynamoDB filter cannot express "status is
         * one of the terminal ones" as cheaply as a comparison in memory can.
         */
        FilterExpression: 'attribute_exists(otrInvoiceId)',
        ProjectionExpression: 'id, proNumber, otrInvoiceId, otrStatus',
        ExclusiveStartKey,
      }),
    )
    pending.push(...((r.Items ?? []) as Row[]))
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)

  let changed = 0
  let failed = 0

  for (const row of pending) {
    const id = String(row.id)
    const invoiceId = String(row.otrInvoiceId)
    // Approved, Dead and Duplicate are OTR's last words on an invoice. Asking again costs
    // a paid API call to be told the same thing.
    if (otrStatusMeta(row.otrStatus as string | undefined)?.terminal) continue
    try {
      const d = await client.getInvoice(invoiceId)
      // Nothing moved — skip the write so updatedAt stays meaningful.
      if (d.status && d.status === row.otrStatus) continue

      await ddb.send(
        new UpdateCommand({
          TableName: FACTORING_TABLE,
          Key: { id },
          UpdateExpression:
            'SET otrStatus = :s, otrScheduleId = :sch, otrStatusSyncedAt = :t, #st = :local, updatedAt = :t, otrError = :null',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: {
            ':s': d.status,
            ':sch': d.scheduleId ?? null,
            ':t': new Date().toISOString(),
            // Local queue status follows OTR; only Approved closes a row out.
            ':local': localStatusFor(d.status),
            ':null': null,
          },
        }),
      )
      changed++
      console.log('[otr-status-sync] updated', { pro: row.proNumber, invoiceId, status: d.status })
    } catch (e) {
      failed++
      const msg = e instanceof OtrError ? `${e.status}: ${e.message}` : String(e)
      console.error('[otr-status-sync] failed', { pro: row.proNumber, invoiceId, error: msg })
      // Record the failure on the row so a persistently broken invoice is visible
      // in the queue rather than only in CloudWatch.
      await ddb
        .send(
          new UpdateCommand({
            TableName: FACTORING_TABLE,
            Key: { id },
            UpdateExpression: 'SET otrError = :e, otrStatusSyncedAt = :t',
            ExpressionAttributeValues: { ':e': msg, ':t': new Date().toISOString() },
          }),
        )
        .catch(() => undefined)
    }
  }

  console.log('[otr-status-sync] done', { polled: pending.length, changed, failed })
  return { polled: pending.length, changed, failed }
}
