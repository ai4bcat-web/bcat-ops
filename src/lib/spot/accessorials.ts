/**
 * Step AB §3.3 — the accessorial vocabulary. The model writes phrases "as written"; this
 * maps them to codes. Unknown phrases are kept as `ACCESSORIAL:<text≤40>`.
 * Pure; relative imports only.
 */
import type { SpotExtraction } from '../../types/tms'

export const ACCESSORIAL_CODES = [
  'LIFTGATE', 'INSIDE_DELIVERY', 'RESIDENTIAL', 'APPOINTMENT', 'LUMPER', 'DETENTION', 'LAYOVER',
  'TONU', 'STOPOFF', 'TARP', 'TEAM', 'HAZMAT', 'OVERSIZE', 'TEMP_CONTROL', 'DROP_TRAILER', 'TOLLS', 'REWEIGH',
] as const
export type AccessorialCode = (typeof ACCESSORIAL_CODES)[number]

/** Codes that exist as quote-line codes: they become unpriced draft lines. */
export const QUOTE_LINE_CODES = ['DETENTION', 'LAYOVER', 'TONU', 'STOPOFF', 'LUMPER', 'TARP', 'REWEIGH'] as const

const PATTERNS: Array<[AccessorialCode, RegExp]> = [
  ['LIFTGATE', /lift\s*-?\s*gate/],
  ['INSIDE_DELIVERY', /inside\s+(deliver|pick)|inside\s+del/],
  ['RESIDENTIAL', /residential|\bresi\b|home\s+deliver/],
  ['APPOINTMENT', /appointment|\bappt\b|delivery\s+window/],
  ['LUMPER', /lumper|unload(ing)?\s+fee/],
  ['DETENTION', /detention|wait(ing)?\s+time/],
  ['LAYOVER', /layover/],
  ['TONU', /\btonu\b|truck\s*order\s*not\s*used/],
  ['STOPOFF', /stop\s*-?\s*off|extra\s+stop|multi\s*-?\s*stop/],
  ['TARP', /\btarp/],
  ['TEAM', /\bteam\b/],
  ['HAZMAT', /haz\s*-?\s*mat|hazardous|\bun\s?\d{4}\b/],
  ['OVERSIZE', /over\s*-?\s*size|over\s*-?\s*dimension|\bover\s*dim|wide\s+load|\bODC\b/i],
  ['TEMP_CONTROL', /temp(erature)?\s*-?\s*control|set\s*-?\s*point|keep\s+frozen|keep\s+cold/],
  ['DROP_TRAILER', /drop\s*(and|&)?\s*hook|drop\s+trailer/],
  ['TOLLS', /\btolls?\b/],
  ['REWEIGH', /re-?\s*weigh/],
]

export function mapAccessorial(text: string): string {
  const raw = String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
  const lower = raw.toLowerCase()
  for (const [code, re] of PATTERNS) {
    if (re.test(lower)) return code
  }
  if ((ACCESSORIAL_CODES as readonly string[]).includes(raw.toUpperCase())) return raw.toUpperCase()
  return `ACCESSORIAL:${raw.replace(/https?:\/\/\S+/gi, '').slice(0, 40).trim()}`
}

/** Mapped, empty phrases dropped, de-duplicated, order kept. */
export function mapAccessorials(list: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  for (const item of list ?? []) {
    if (typeof item !== 'string' || !item.trim()) continue
    const code = mapAccessorial(item)
    if (code === 'ACCESSORIAL:') continue
    if (!out.includes(code)) out.push(code)
  }
  return out
}

/** Hazmat, team, oversize and temperature-controlled freight is never auto-quoted. */
export function hasSpecialHandling(e: SpotExtraction): boolean {
  if (e.hazmat === 'YES') return true
  if (e.equipmentType === 'REEFER') return true
  if (e.temperatureF && e.temperatureF.trim()) return true
  return (e.accessorials ?? []).some((a) => a === 'HAZMAT' || a === 'TEAM' || a === 'OVERSIZE' || a === 'TEMP_CONTROL')
}
