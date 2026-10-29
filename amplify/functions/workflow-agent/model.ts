/**
 * workflow-agent — the one place an Anthropic call is made.
 *
 * Two invariants live here rather than being spread over the pipeline:
 *
 *  1. **No tools, ever.** Every call is a `json_schema`-constrained extraction.
 *     There is no code path from a model answer to a privileged action: the
 *     answer becomes a proposal on a WorkflowRun and a person applies it.
 *  2. **Externally received mail is untrusted data.** Anything that came from
 *     outside the company goes through `wrapUntrusted`, and every prompt carries
 *     `UNTRUSTED_NOTICE` ahead of it. A sentence in an invoice asking to be
 *     approved is a sentence to extract, not an instruction to follow.
 *
 * The call counter is module-level and reset per invocation. Three model calls
 * is the budget for one run (classify, parse, one spare); past it the pipeline
 * throws `MODEL_CAP` rather than quietly spending more.
 *
 * Schema note, learned the hard way on this stack (see ratecon-parser): the API
 * caps union/nullable fields and refuses an `enum` combined with a nullable
 * type. Only the `['string','null']` / `['number','null']` form proven in
 * vendor-ap-extract is used below, and every `enum` field is a plain `string`.
 */
import Anthropic from '@anthropic-ai/sdk'
import { UNTRUSTED_NOTICE, wrapUntrusted } from '../../../src/lib/workflows/untrusted'

export const MODEL_ID = 'claude-sonnet-5'
export const MAX_MODEL_CALLS = 3
/** Body text handed to the model, per the step K caps. */
export const MAX_PROMPT_CHARS = 8000

export type FileBlock =
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } }

export interface ModelAnswer<T> {
  value: T
  inputTokens: number
  outputTokens: number
}

interface Usage {
  calls: number
  inputTokens: number
  outputTokens: number
}

let usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
let client: Anthropic | null = null

export function resetModelBudget(): void {
  usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
}

export function modelUsage(): Usage {
  return { ...usage }
}

function anthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  // One client per container: the SDK pools connections and the key cannot change
  // under a running Lambda.
  if (!client) client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })
  return client
}

/**
 * The single call site. `blocks` are attachment blocks (already capped by the
 * caller), `text` is the instruction — which must already carry its untrusted
 * content wrapped; the notice is prepended here so no prompt can omit it.
 */
export async function callModel<T>(
  schema: Record<string, unknown>,
  blocks: FileBlock[],
  text: string,
  maxTokens: number,
): Promise<ModelAnswer<T>> {
  if (usage.calls >= MAX_MODEL_CALLS) throw new Error('MODEL_CAP')
  usage.calls += 1

  const response = await anthropic().messages.stream({
    model: MODEL_ID,
    max_tokens: maxTokens,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{
      role: 'user',
      content: [
        ...blocks,
        { type: 'text', text: `${UNTRUSTED_NOTICE}\n\n${text}` },
      ],
    }],
  })
  const final = await response.finalMessage()
  // The SDK's content block union narrows on `type`, so no cast is needed.
  const body = final.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  const inputTokens = Number(final.usage?.input_tokens ?? 0)
  const outputTokens = Number(final.usage?.output_tokens ?? 0)
  usage.inputTokens += inputTokens
  usage.outputTokens += outputTokens
  return { value: JSON.parse(body) as T, inputTokens, outputTokens }
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agent', 'confidence', 'reason'],
  properties: {
    agent: { type: 'string', description: 'One of QUOTE, TENDER, AP, CAPACITY. QUOTE is a request for a price, TENDER is freight offered to be hauled, AP is a bill addressed to us, CAPACITY is a carrier advertising trucks.' },
    confidence: { type: 'string', description: 'One of high, medium, low.' },
    reason: { type: 'string', description: 'One short sentence naming what in the message decided it.' },
  },
} as const

export const TENDER_FILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['customer', 'reference', 'pickupNumber', 'weightLb', 'stops'],
  properties: {
    customer: { type: ['string', 'null'], description: 'The broker or shipper offering the load.' },
    reference: { type: ['string', 'null'], description: 'The reference the broker will match on — TMS ID, load #, order #.' },
    pickupNumber: { type: ['string', 'null'], description: 'Shipment / SO / PU number at the pickup.' },
    weightLb: { type: ['number', 'null'], description: 'Total weight in pounds.' },
    stops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'name', 'city', 'state', 'zip', 'dateStr', 'time'],
        properties: {
          type: { type: 'string', description: 'pickup or delivery' },
          name: { type: ['string', 'null'], description: 'Facility name.' },
          city: { type: ['string', 'null'] },
          state: { type: ['string', 'null'], description: 'Two-letter state code.' },
          zip: { type: ['string', 'null'] },
          dateStr: { type: ['string', 'null'], description: 'YYYY-MM-DD.' },
          time: { type: ['string', 'null'], description: 'HH:mm 24h, only when a real appointment is stated.' },
        },
      },
    },
  },
} as const

export const QUOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['customer', 'originCity', 'originState', 'originZip', 'destinationCity', 'destinationState', 'destinationZip', 'pickupDate', 'deliveryDate', 'equipment', 'commodity', 'weightLb', 'targetRateDollars', 'notes', 'confidence'],
  properties: {
    customer: { type: ['string', 'null'], description: 'The company asking for the price.' },
    originCity: { type: ['string', 'null'] },
    originState: { type: ['string', 'null'], description: 'Two-letter state code.' },
    originZip: { type: ['string', 'null'] },
    destinationCity: { type: ['string', 'null'] },
    destinationState: { type: ['string', 'null'], description: 'Two-letter state code.' },
    destinationZip: { type: ['string', 'null'] },
    pickupDate: { type: ['string', 'null'], description: 'YYYY-MM-DD.' },
    deliveryDate: { type: ['string', 'null'], description: 'YYYY-MM-DD.' },
    equipment: { type: ['string', 'null'], description: 'Equipment asked for, as written (van, reefer, flatbed, stepdeck, power only).' },
    commodity: { type: ['string', 'null'] },
    weightLb: { type: ['number', 'null'], description: 'Total weight in pounds.' },
    targetRateDollars: { type: ['number', 'null'], description: 'Only when the customer named a number themselves. Never your own estimate.' },
    notes: { type: ['string', 'null'], description: 'One short sentence a person should see, or null.' },
    confidence: { type: 'string', description: 'One of high, medium, low.' },
  },
} as const

export const CAPACITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['carrier', 'equipment', 'originCity', 'originState', 'destinationCity', 'destinationState', 'availableDate', 'trucks', 'notes', 'confidence'],
  properties: {
    carrier: { type: ['string', 'null'], description: 'The carrier offering the trucks.' },
    equipment: { type: ['string', 'null'], description: 'Equipment on offer, as written.' },
    originCity: { type: ['string', 'null'] },
    originState: { type: ['string', 'null'], description: 'Two-letter state code.' },
    destinationCity: { type: ['string', 'null'], description: 'Where the truck wants to go, if stated.' },
    destinationState: { type: ['string', 'null'], description: 'Two-letter state code.' },
    availableDate: { type: ['string', 'null'], description: 'YYYY-MM-DD the truck is empty.' },
    trucks: { type: ['number', 'null'], description: 'How many trucks are on offer.' },
    notes: { type: ['string', 'null'] },
    confidence: { type: 'string', description: 'One of high, medium, low.' },
  },
} as const

export interface ClassifyResult {
  agent: string
  confidence: string
  reason: string
}

/** The e-mail, as the model is allowed to see it: fenced, redacted, capped. */
export function emailPrompt(instruction: string, parts: { subject?: string | null; fromEmail?: string | null; body?: string | null }): string {
  const content = [
    parts.subject ? `Subject: ${parts.subject}` : '',
    parts.fromEmail ? `From: ${parts.fromEmail}` : '',
    parts.body ? `Body:\n${parts.body}` : '',
  ].filter(Boolean).join('\n')
  return `${instruction}\n\n${wrapUntrusted('EMAIL', content, MAX_PROMPT_CHARS)}`
}
