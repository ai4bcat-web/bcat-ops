import { describe, expect, it } from 'vitest'
import { DELIVERED_AT_UNSET_CONDITION, deliveredAtFor, deliveredAtUnsetGuard } from './deliveredAtStamp'

describe('deliveredAtFor', () => {
  it('takes the latest load stamp first', () => {
    expect(deliveredAtFor([{ deliveredAt: '2026-11-10T00:00:00Z' }, { deliveredAt: '2026-11-11T00:00:00Z' }], 'now')).toBe('2026-11-11T00:00:00Z')
  })
  it('then the last delivery stop actual, from parsed or JSON stops', () => {
    const stops = [{ type: 'pickup', departedAt: '2026-11-11T23:15:00Z' }, { type: 'delivery', arrivedAt: '2026-11-12T13:11:26Z', departedAt: '2026-11-12T13:11:30Z' }]
    expect(deliveredAtFor([{ deliveredAt: null, stops }], 'now')).toBe('2026-11-12T13:11:30Z')
    expect(deliveredAtFor([{ stops: JSON.stringify(stops) }], 'now')).toBe('2026-11-12T13:11:30Z')
  })
  it('then the fallback', () => {
    expect(deliveredAtFor([{ stops: 'not json' }], '2026-11-12T13:11:32Z')).toBe('2026-11-12T13:11:32Z')
  })
})

describe('deliveredAtUnsetGuard', () => {
  it('accepts a missing or NULL deliveredAt', () => {
    const out = deliveredAtUnsetGuard({ UpdateExpression: 'SET #deliveredAt = :deliveredAt', ExpressionAttributeNames: { '#deliveredAt': 'deliveredAt' }, ExpressionAttributeValues: { ':deliveredAt': { S: 'x' } } })
    expect(out.ConditionExpression).toBe(DELIVERED_AT_UNSET_CONDITION)
    expect(out.ConditionExpression).toContain('attribute_type(#deliveredAt, :deliveredAtNullType)')
    expect(out.ExpressionAttributeValues).toMatchObject({ ':deliveredAt': { S: 'x' }, ':deliveredAtNullType': { S: 'NULL' } })
  })
})
