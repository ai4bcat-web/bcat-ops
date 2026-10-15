/**
 * ratecon-parser Lambda — custom AppSync mutation `parseRateConfirm`.
 *
 * Takes a rate confirmation as base64 (PDF or image) and returns two things it names: the
 * appointment date-times (one per stop end), and the fields an OTR invoice needs. Mirrors
 * trip-screenshot-parser: Sonnet, streamed, JSON-schema output, hard budget inside
 * AppSync's 30s resolver cap.
 *
 * Both come from ONE pass over the document. A second call would double the cost and the
 * latency to read the same page twice, and the two answers could then disagree about the
 * same tender.
 *
 * The broker MC is deliberately NOT extracted. It is the one field that decides who gets
 * billed, and OTR resolves the broker from it — so it is entered once per broker by a human
 * on the Customer record and never read off a document. See src/lib/otrInvoice.ts.
 */
import Anthropic from '@anthropic-ai/sdk'

interface Args {
  fileBase64: string
  /** 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' */
  mediaType?: string
  /** Anchor for ratecons that omit the year. */
  todayISO?: string
}

/*
 * Every field is a plain string or number. The API caps nullable/union fields at 16 and
 * this schema has 20, so marking them nullable failed every read ("Schemas contains too
 * many parameters with union types"). "Not stated" is the empty string or 0, and
 * blanksToNull below turns those back into the nulls the rest of the app expects.
 */
/** "" and 0 are the schema's way of saying not stated; everything downstream expects null. */
export function blanksToNull<T>(value: T): T {
  if (Array.isArray(value)) return value.map(blanksToNull) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = blanksToNull(v)
    return out as T
  }
  if (value === '' || value === 0) return null as unknown as T
  return value
}

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pickup', 'delivery', 'invoice', 'freight'],
  properties: {
    invoice: {
      type: 'object',
      additionalProperties: false,
      required: [
        'brokerName', 'poNumber', 'totalRate', 'date',
        'originCity', 'originState', 'originZip',
        'destinationCity', 'destinationState', 'destinationZip',
      ],
      properties: {
        brokerName:       { type: 'string', description: 'The broker/customer company name on the tender, or "" if not stated' },
        poNumber:         { type: 'string', description: 'The PO, order, reference or load number the broker uses, or "" if not stated' },
        totalRate:        { type: 'number', description: 'TOTAL rate to the carrier in dollars, including all accessorials. 0 if not stated. Never a linehaul-only or per-mile figure.' },
        date:             { type: 'string', description: 'Delivery date YYYY-MM-DD, which is the invoice date. Or "" if not stated (0 for a number).' },
        originCity:       { type: 'string', description: 'City of the FIRST pickup' },
        originState:      { type: 'string', description: 'Two-letter state of the first pickup, e.g. IL' },
        originZip:        { type: 'string', description: '5-digit ZIP of the first pickup' },
        destinationCity:  { type: 'string', description: 'City of the LAST delivery' },
        destinationState: { type: 'string', description: 'Two-letter state of the last delivery' },
        destinationZip:   { type: 'string', description: '5-digit ZIP of the last delivery' },
      },
    },
    freight: {
      type: 'object', additionalProperties: false, required: ['commodity', 'weightLbs', 'pieces', 'piecesUnit'],
      properties: {
        commodity:  { type: 'string', description: 'What is being hauled, as the tender names it (e.g. "Frozen foods", "Steel coils"). Or "" if not stated (0 for a number).' },
        weightLbs:  { type: 'number', description: 'Total weight in pounds. Convert from kg or tons if needed. 0 if not stated.' },
        pieces:     { type: 'number', description: 'Count of pieces/pallets/cases as stated. 0 if not stated.' },
        // No enum here: the API refuses an enum mixed with a nullable type ("Enum value 'pallets' does not match declared type"), which failed every rate-con read.
        piecesUnit: { type: 'string', description: 'The unit the count is in, lowercase: one of pallets, cases, pieces, skids, rolls, bundles, drums, totes. Or "" if not stated (0 for a number).' },
      },
    },
    pickup: {
      type: 'object', additionalProperties: false, required: ['date', 'time', 'timeEnd'],
      properties: {
        date:    { type: 'string', description: 'Pickup appointment date YYYY-MM-DD, or "" if not stated' },
        time:    { type: 'string', description: 'Pickup appointment time HH:mm 24h local, or "" if FCFS/not stated' },
        timeEnd: { type: 'string', description: 'End of a pickup window HH:mm, or "" unless a range is stated' },
      },
    },
    delivery: {
      type: 'object', additionalProperties: false, required: ['date', 'time', 'timeEnd'],
      properties: {
        date:    { type: 'string', description: 'Delivery appointment date YYYY-MM-DD' },
        time:    { type: 'string', description: 'Delivery appointment time HH:mm 24h local' },
        timeEnd: { type: 'string', description: 'End of a delivery window HH:mm' },
      },
    },
  },
} as const

export const handler = async (event: { arguments: Args }) => {
  const { fileBase64, mediaType, todayISO } = event.arguments
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { appts: null, error: 'ANTHROPIC_API_KEY secret is not set in the Amplify console yet' }
  if (!fileBase64) return { appts: null, error: 'no-file' }

  const client = new Anthropic({ apiKey, timeout: 24_000, maxRetries: 0 })
  const today = (todayISO ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
  const isPdf = (mediaType ?? '').includes('pdf')

  const fileBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: fileBase64 } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: (mediaType ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp', data: fileBase64 } }

  try {
    const response = await client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          fileBlock,
          {
            type: 'text',
            text: [
              'This is a freight rate confirmation (ratecon).',
              'Extract the PICKUP and DELIVERY appointment date and time exactly as stated.',
              `Dates as YYYY-MM-DD (today is ${today}; if the year is omitted pick the one that keeps the date near today).`,
              'Times as 24h HH:mm in the local time printed. If a window is given (e.g. 08:00-16:00), time = start and timeEnd = end.',
              '',
              'Also extract the "invoice" fields used to bill this load:',
              'totalRate is the TOTAL paid to the carrier in dollars, including fuel surcharge and accessorials — not a linehaul-only figure and never a per-mile rate.',
              'originCity/State/Zip describe the FIRST pickup; destinationCity/State/Zip the LAST delivery. Use the two-letter state code.',
              'invoice.date is the DELIVERY date.',
              'poNumber is whatever reference the broker will match the invoice on (PO #, order #, load #, reference #).',
              'Also extract "freight": the commodity, total weight in pounds, and the piece count with its unit (pallets, cases, pieces, skids, rolls, bundles, drums, totes), exactly as the tender states them.',
              'Do NOT extract an MC number, and do not infer one.',
              '',
              'If a field is genuinely not stated (e.g. FCFS with no time), return "" for a text field or 0 for a number. Never guess.',
              'A blank is always better than a plausible-looking value you inferred: every one of these is checked by a person against the document, and a wrong number costs more than a blank.',
            ].join('\n'),
          },
        ],
      }],
    })
    const final = await response.finalMessage()
    const text = final.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    const parsed = JSON.parse(text) as Record<string, unknown>
    // `appts` keeps its original shape so the appointment callers are untouched; `invoice`
    // is additive, and a caller that predates it simply ignores the extra key.
    const clean = blanksToNull(parsed) as typeof parsed
    return { appts: clean, invoice: clean.invoice ?? null, freight: clean.freight ?? null, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ratecon-parser]', msg)
    return { appts: null, invoice: null, freight: null, error: msg }
  }
}
