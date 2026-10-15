import { describe, it, expect } from 'vitest'
import { SCHEMA } from './handler'

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
