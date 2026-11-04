import { createHash } from 'node:crypto'
import type { EngineRow } from '../../../../src/types/tms'

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** `prefix-` + first 16 hex of sha256: the helper `planBackfill` uses for deterministic ids. */
export function stableId(prefix: string, key: string): string {
  return `${prefix}-${sha256Hex(key).slice(0, 16)}`
}

/** Drop undefined and null keys (a GSI key attribute must be omitted, never NULL). Empty strings are kept. */
export function compact<T extends EngineRow>(row: T): T {
  const out: EngineRow = {}
  for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null) out[k] = v
  return out as T
}

/** Like compact, but also drops '' (for sparse GSI key attributes and optional text). */
export function compactText<T extends EngineRow>(row: T): T {
  const out: EngineRow = {}
  for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null && v !== '') out[k] = v
  return out as T
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export const monthOf = (date: string): string => date.slice(0, 7)

export async function readAll(parts: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const p of parts) chunks.push(Buffer.from(p))
  return Buffer.concat(chunks).toString('utf8')
}

export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
