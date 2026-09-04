/**
 * ratecon-parser Lambda — custom AppSync mutation `parseRateConfirm`.
 *
 * Takes a rate confirmation as base64 (PDF or image) and returns the appointment
 * date-times it names, one per stop end. Mirrors trip-screenshot-parser: Sonnet,
 * streamed, JSON-schema output, hard budget inside AppSync's 30s resolver cap.
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
  required: ['pickup', 'delivery'],
  properties: {
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
              'If a field is genuinely not stated (e.g. FCFS with no time), return null for it. Never guess.',
            ].join('\n'),
          },
        ],
      }],
    })
    const final = await response.finalMessage()
    const text = final.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    return { appts: JSON.parse(text), error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ratecon-parser]', msg)
    return { appts: null, error: msg }
  }
}
