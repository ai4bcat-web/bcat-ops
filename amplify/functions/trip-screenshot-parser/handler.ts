/**
 * trip-screenshot-parser Lambda — custom AppSync mutation handler `parseTripScreenshot`.
 *
 * Takes a screenshot of the Amazon Relay trips list (base64 image) and returns the
 * trips it shows as structured rows: load ID, route, miles, equipment, freight,
 * rate/mile, status and start date. The frontend downscales the image before
 * sending (AppSync request limit ~1MB) and previews the rows before importing.
 */
import Anthropic from '@anthropic-ai/sdk'

interface Args {
  imageBase64: string
  /** e.g. "image/jpeg" | "image/png" — defaults to jpeg (the client re-encodes). */
  mediaType?: string
  /** Today's date (YYYY-MM-DD) — Relay screenshots omit the year, so anchor to this. */
  todayISO?: string
}

export interface ParsedTrip {
  loadId: string | null
  origin: string | null
  destination: string | null
  miles: number | null
  equipment: string | null
  freightAmount: number
  ratePerMile: number | null
  status: string | null
  /** Trip start date (YYYY-MM-DD) — drives which pay week the trip lands in. */
  date: string | null
}

const TRIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trips'],
  properties: {
    trips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['loadId', 'origin', 'destination', 'miles', 'equipment', 'freightAmount', 'ratePerMile', 'status', 'date'],
        properties: {
          loadId:        { type: ['string', 'null'], description: 'Trip/Load ID exactly as shown, including any "T-" prefix' },
          origin:        { type: ['string', 'null'], description: 'First stop — facility name and city/state as shown' },
          destination:   { type: ['string', 'null'], description: 'Last stop — facility name and city/state as shown' },
          miles:         { type: ['number', 'null'], description: 'Distance in miles (the "NN mi" value)' },
          equipment:     { type: ['string', 'null'], description: `Equipment, e.g. "53' Container" or "53' Trailer, 53' Container"` },
          freightAmount: { type: 'number', description: 'Payout dollars for the whole row (blocks show the block total)' },
          ratePerMile:   { type: ['number', 'null'], description: 'The "$X.XX/mi" value if shown' },
          status:        { type: ['string', 'null'], description: '"Canceled" if the row is marked canceled, else "Completed"' },
          date:          { type: ['string', 'null'], description: 'Start date of the FIRST stop as YYYY-MM-DD' },
        },
      },
    },
  },
} as const

export const handler = async (event: { arguments: Args }) => {
  const { imageBase64, mediaType, todayISO } = event.arguments
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { trips: null, error: 'ANTHROPIC_API_KEY secret is not set in the Amplify console yet' }
  if (!imageBase64) return { trips: null, error: 'no-image' }

  // AppSync hangs up at 30s and the Lambda is capped there too, so give the model call a
  // budget that leaves room to return an answer. Without this the request runs to the wall
  // and the caller gets a timeout with no explanation instead of a usable message.
  const BUDGET_MS = 24_000
  const client = new Anthropic({ apiKey, timeout: BUDGET_MS, maxRetries: 0 })

  const today = (todayISO ?? new Date().toISOString().slice(0, 10)).slice(0, 10)

  try {
    // Sonnet, not Opus: this is table OCR against a hard 30s ceiling, and Opus was
    // reliably blowing through it (CloudWatch showed back-to-back `Status: timeout` at
    // exactly 30000ms). Sonnet reads a trips table just as accurately and finishes inside
    // the window.
    //
    // Streamed, not awaited whole: a non-streaming request with max_tokens this high sits
    // silently until the entire response is generated, which is what turned a slow read
    // into a dead 30s hang. Streaming keeps the connection working and lets the SDK
    // surface a timeout as an error we can report.
    const response = await client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      output_config: {
        // Structured extraction — keep latency inside AppSync's 30s resolver cap.
        effort: 'low',
        format: { type: 'json_schema', schema: TRIP_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: (mediaType ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: [
                'This is a screenshot of an Amazon Relay trips list (one trip per row).',
                'Extract EVERY trip row visible, top to bottom. For each row:',
                '- loadId: the ID in the first column exactly as printed, keeping any "T-" prefix.',
                '- origin/destination: the first and last stop (facility code + city/state as shown, e.g. "GYR1 Goodyear, AZ 85338"). Expand nothing; trim trailing "…" truncation.',
                '- miles: the "NN mi" number. equipment: the equipment column text.',
                '- freightAmount: the dollar amount for the row (e.g. "$188.46" → 188.46).',
                '- ratePerMile: the "$X.XX/mi" number if printed, else null.',
                '- status: "Canceled" when the row shows a canceled marker, otherwise "Completed".',
                `- date: the FIRST stop's start date as YYYY-MM-DD. The screenshot omits the year — today is ${today}; pick the year that puts the date on or before today (if using this year would land more than a few days in the future, it is from last year).`,
                'Do not invent rows, do not skip canceled rows, and do not total anything.',
              ].join('\n'),
            },
          ],
        },
      ],
    }).finalMessage()

    if (response.stop_reason === 'refusal') {
      return { trips: null, error: 'The model declined to read this image — try a tighter crop of just the trips table' }
    }

    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const parsed = JSON.parse(text) as { trips: ParsedTrip[] }
    return { trips: parsed.trips ?? [], error: null }
  } catch (err) {
    console.error('[trip-screenshot-parser]', err)
    const msg = err instanceof Error ? err.message : String(err)
    // A timeout is the one failure a user can actually act on, so say what to do about it
    // rather than surfacing the SDK's wording.
    if (/timeout|aborted|ETIMEDOUT/i.test(msg)) {
      return {
        trips: null,
        error: 'Reading the screenshot took too long. Crop to just the trips table (or split a very long list into two screenshots) and try again.',
      }
    }
    return { trips: null, error: msg }
  }
}
