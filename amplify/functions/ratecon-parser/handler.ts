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

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pickup', 'delivery', 'invoice'],
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
        brokerName:       { type: ['string', 'null'], description: 'The broker/customer company name on the tender, null if not stated' },
        poNumber:         { type: ['string', 'null'], description: 'The PO, order, reference or load number the broker uses, null if not stated' },
        totalRate:        { type: ['number', 'null'], description: 'TOTAL rate to the carrier in dollars, including all accessorials. Null if not stated. Never a linehaul-only or per-mile figure.' },
        date:             { type: ['string', 'null'], description: 'Delivery date YYYY-MM-DD, which is the invoice date. Null if not stated.' },
        originCity:       { type: ['string', 'null'], description: 'City of the FIRST pickup' },
        originState:      { type: ['string', 'null'], description: 'Two-letter state of the first pickup, e.g. IL' },
        originZip:        { type: ['string', 'null'], description: '5-digit ZIP of the first pickup' },
        destinationCity:  { type: ['string', 'null'], description: 'City of the LAST delivery' },
        destinationState: { type: ['string', 'null'], description: 'Two-letter state of the last delivery' },
        destinationZip:   { type: ['string', 'null'], description: '5-digit ZIP of the last delivery' },
      },
    },
    pickup: {
      type: 'object', additionalProperties: false, required: ['date', 'time', 'timeEnd'],
      properties: {
        date:    { type: ['string', 'null'], description: 'Pickup appointment date YYYY-MM-DD, null if not stated' },
        time:    { type: ['string', 'null'], description: 'Pickup appointment time HH:mm 24h local, null if FCFS/not stated' },
        timeEnd: { type: ['string', 'null'], description: 'End of a pickup window HH:mm, null unless a range is stated' },
      },
    },
    delivery: {
      type: 'object', additionalProperties: false, required: ['date', 'time', 'timeEnd'],
      properties: {
        date:    { type: ['string', 'null'], description: 'Delivery appointment date YYYY-MM-DD' },
        time:    { type: ['string', 'null'], description: 'Delivery appointment time HH:mm 24h local' },
        timeEnd: { type: ['string', 'null'], description: 'End of a delivery window HH:mm' },
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
              'Do NOT extract an MC number, and do not infer one.',
              '',
              'If a field is genuinely not stated (e.g. FCFS with no time), return null for it. Never guess.',
              'A null is always better than a plausible-looking value you inferred: every one of these is checked by a person against the document, and a wrong number costs more than a blank.',
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
    return { appts: parsed, invoice: parsed.invoice ?? null, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ratecon-parser]', msg)
    return { appts: null, invoice: null, error: msg }
  }
}
