import { describe, it, expect } from 'vitest'
import { SCHEMA, blanksToNull } from './handler'

/** Every enum anywhere in the schema, with the type declared beside it. */
function enums(node: unknown, path = 'root'): Array<{ path: string; type: unknown; values: unknown[] }> {
  if (!node || typeof node !== 'object') return []
  const out: Array<{ path: string; type: unknown; values: unknown[] }> = []
  const o = node as Record<string, unknown>
  if (Array.isArray(o.enum)) out.push({ path, type: o.type, values: o.enum })
  for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') out.push(...enums(v, `${path}.${k}`))
  return out
}

describe('rate-con output schema', () => {
  it('never mixes an enum with a nullable type — the API rejects that and every read failed', () => {
    for (const e of enums(SCHEMA)) {
      expect(e.values, e.path).not.toContain(null)
      expect(Array.isArray(e.type) ? e.type : [e.type], e.path).not.toContain('null')
    }
  })
})

describe('nullable-field cap', () => {
  function unions(node: unknown): number {
    if (!node || typeof node !== 'object') return 0
    const o = node as Record<string, unknown>
    let n = Array.isArray(o.type) || Array.isArray(o.anyOf) ? 1 : 0
    for (const v of Object.values(o)) if (v && typeof v === 'object') n += unions(v)
    return n
  }
  it('declares no union-typed fields at all — the API caps them at 16 and this schema has 20 fields', () => {
    expect(unions(SCHEMA)).toBe(0)
  })
  it('turns the blanks the model sends back into the nulls the app expects', () => {
    expect(blanksToNull({ invoice: { brokerName: '', totalRate: 0, poNumber: 'PO-7' }, pickup: { date: '2026-10-15', time: '', timeEnd: '' } }))
      .toEqual({ invoice: { brokerName: null, totalRate: null, poNumber: 'PO-7' }, pickup: { date: '2026-10-15', time: null, timeEnd: null } })
  })
})
