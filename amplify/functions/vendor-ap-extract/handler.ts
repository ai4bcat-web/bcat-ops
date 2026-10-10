/**
 * vendor-ap-extract Lambda — see resource.ts.
 */
import Anthropic from '@anthropic-ai/sdk'
import { DynamoDBClient, GetItemCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mergeExtraction, type Extraction, type ExtractableRow } from './merge'

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})
const TABLE_NAME = process.env.TABLE_NAME ?? ''
const BUCKET = process.env.BUCKET_NAME ?? ''
const MAX_FILES = 3
const MAX_FILE_BYTES = 8 * 1024 * 1024

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vendor: { type: ['string', 'null'] },
    invoiceNumber: { type: ['string', 'null'] },
    amountDollars: { type: ['number', 'null'] },
    invoiceDate: { type: ['string', 'null'] },
    dueDate: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: ['string', 'null'] },
  },
  required: ['vendor', 'invoiceNumber', 'amountDollars', 'invoiceDate', 'dueDate', 'confidence', 'note'],
} as const

interface Attachment { key: string; name: string; contentType: string; size: number }

type FileBlock =
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } }

async function fileBlocks(attachments: Attachment[]): Promise<FileBlock[]> {
  const out: FileBlock[] = []
  for (const a of attachments) {
    if (out.length >= MAX_FILES) break
    const type = (a.contentType || '').toLowerCase()
    const isPdf = type.includes('pdf') || a.name.toLowerCase().endsWith('.pdf')
    const isImage = /^image\/(jpeg|jpg|png|webp)$/.test(type)
    if (!isPdf && !isImage) continue
    if (a.size > MAX_FILE_BYTES) continue
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: a.key }))
      const data = Buffer.from(await obj.Body!.transformToByteArray()).toString('base64')
      out.push(isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: (type === 'image/jpg' ? 'image/jpeg' : type) as 'image/jpeg' | 'image/png' | 'image/webp', data } })
    } catch (err) {
      console.warn('[vendor-ap-extract] could not read', a.key, String(err))
    }
  }
  return out
}

export async function extractFromInvoice(client: Anthropic, row: ExtractableRow, files: FileBlock[], today: string): Promise<Extraction> {
  const context = [
    `Email subject: ${row.subject ?? ''}`,
    row.fromEmail ? `From: ${row.fromEmail}` : '',
    row.emailBody ? `Email body (may be truncated):\n${row.emailBody.slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n')
  const response = await client.messages.stream({
    model: 'claude-sonnet-5',
    max_tokens: 800,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        ...files,
        {
          type: 'text',
          text: [
            'This is a vendor invoice (or a bill) sent to a trucking company for payment. The attached file is the invoice; the email text is context.',
            context,
            'Extract, for the accounts-payable queue:',
            '- vendor: the company that issued the invoice and is to be paid (not the trucking company being billed).',
            '- invoiceNumber: the invoice number exactly as printed.',
            '- amountDollars: the TOTAL amount due in dollars (after tax, after any credits; the balance due if shown).',
            `- invoiceDate and dueDate as YYYY-MM-DD (today is ${today}). If only payment terms are given (e.g. Net 30), compute dueDate from the invoice date.`,
            '- confidence: how sure you are overall. note: one short sentence on anything a person should check, or null.',
            'If a field is not stated, return null. Never guess an amount.',
          ].join('\n'),
        },
      ],
    }],
  })
  const final = await response.finalMessage()
  const text = final.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
  return JSON.parse(text) as Extraction
}

async function extractRow(client: Anthropic, id: string): Promise<string> {
  const got = await dynamo.send(new GetItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }) }))
  if (!got.Item) return 'missing'
  const row = unmarshall(got.Item) as ExtractableRow & { attachments?: Attachment[] | string }
  const attachments: Attachment[] = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : (row.attachments ?? [])
  const files = await fileBlocks(attachments)
  const now = new Date().toISOString()
  let extraction: Extraction
  let note: string
  if (files.length === 0 && !row.emailBody) {
    extraction = { vendor: null, invoiceNumber: null, amountDollars: null, invoiceDate: null, dueDate: null, confidence: 'low', note: null }
    note = 'No readable attachment (PDF or picture) on the email'
  } else {
    try {
      extraction = await extractFromInvoice(client, row, files, now.slice(0, 10))
      note = extraction.note ? `${extraction.confidence} confidence: ${extraction.note}` : `${extraction.confidence} confidence`
    } catch (err) {
      console.error('[vendor-ap-extract] model failed', id, String(err))
      note = `Could not read the invoice: ${err instanceof Error ? err.message : String(err)}`
      await dynamo.send(new UpdateItemCommand({ TableName: TABLE_NAME, Key: marshall({ id }), UpdateExpression: 'SET extractedAt = :t, extractionNote = :n, updatedAt = :t', ExpressionAttributeValues: marshall({ ':t': now, ':n': note }) }))
      return 'failed'
    }
  }
  const patch = mergeExtraction(row, extraction)
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = { ':t': now, ':n': note }
  const sets = ['extractedAt = :t', 'extractionNote = :n', 'updatedAt = :t']
  let i = 0
  for (const [k, v] of Object.entries(patch)) {
    names[`#f${i}`] = k
    values[`:v${i}`] = v
    sets.push(`#f${i} = :v${i}`)
    i += 1
  }
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME, Key: marshall({ id }),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(i ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
  }))
  console.log('[vendor-ap-extract] filled', { id, fields: Object.keys(patch), note })
  return 'ok'
}

export const handler = async (event: { id?: string; all?: boolean }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.error('[vendor-ap-extract] ANTHROPIC_API_KEY is not set'); return { ok: false } }
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })
  if (event.id) return { ok: true, result: await extractRow(client, event.id) }
  if (event.all) {
    // Backfill: every EMAIL row the extractor has never read.
    const ids: string[] = []
    let key: Record<string, unknown> | undefined
    do {
      const page = await dynamo.send(new ScanCommand({ TableName: TABLE_NAME, FilterExpression: 'attribute_not_exists(extractedAt) AND #s = :email', ExpressionAttributeNames: { '#s': 'source' }, ExpressionAttributeValues: marshall({ ':email': 'EMAIL' }), ProjectionExpression: 'id', ExclusiveStartKey: key as never }))
      for (const it of page.Items ?? []) ids.push(String(unmarshall(it).id))
      key = page.LastEvaluatedKey as Record<string, unknown> | undefined
    } while (key)
    const results: Record<string, string> = {}
    for (const id of ids) results[id] = await extractRow(client, id)
    return { ok: true, results }
  }
  return { ok: false, error: 'pass { id } or { all: true }' }
}
