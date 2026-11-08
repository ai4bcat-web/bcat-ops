import { describe, expect, it } from 'vitest'
import { fromSentinels, REPLY_INTENT_SCHEMA, SPOT_REQUEST_SCHEMA } from './model'

function unions(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, x) => n + unions(x), 0)
  if (!node || typeof node !== 'object') return 0
  const o = node as Record<string, unknown>
  let n = Array.isArray(o.type) || 'anyOf' in o || 'oneOf' in o ? 1 : 0
  for (const v of Object.values(o)) n += unions(v)
  return n
}

describe('model schemas', () => {
  it('contain no union types (Anthropic rejects schemas with many)', () => {
    expect(unions(SPOT_REQUEST_SCHEMA)).toBe(0)
    expect(unions(REPLY_INTENT_SCHEMA)).toBe(0)
  })

  it('maps the unknown sentinels back to null and keeps real values', () => {
    const out = fromSentinels({
      kind: 'QUOTE_REQUEST', confidence: 'high', reason: 'r',
      customerName: '', contactName: 'Dana', contactPhone: '',
      stops: [{ type: 'PICKUP', name: '', city: 'Chicago', state: 'IL', zip: '', dateStr: '', time: '' }],
      pickupDate: '2026-11-06', deliveryDate: '', equipment: 'van', lengthFt: -1, mode: 'FTL',
      weightLbs: 38000, pieces: -1, commodity: '', temperatureF: '', hazmat: '', accessorials: ['liftgate'],
      targetRateDollars: -1, notes: '', lowConfidence: [],
    })
    expect(out).toMatchObject({
      customerName: null, contactName: 'Dana', lengthFt: null, weightLbs: 38000, pieces: null,
      targetRateDollars: null, deliveryDate: null, hazmat: null, accessorials: ['liftgate'],
    })
    expect(out.stops?.[0]).toMatchObject({ city: 'Chicago', zip: null, dateStr: null })
  })
})
