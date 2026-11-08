/**
 * Form helpers for the two company-wide billing settings: the always-copy invoice
 * e-mails and the Aljex cutoff. Pure, so the cards stay thin and the rules are tested.
 */

export const DEFAULT_ALWAYS_COPY_EMAIL = 'invoices@bcatcorp.com'
/** Wall-clock time in America/Chicago, as a `datetime-local` input holds it. */
export const DEFAULT_ALJEX_CUTOFF_LOCAL = '2026-11-07T00:00'
export const CUTOFF_ZONE = 'America/Chicago'

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/** Splits on commas, semicolons, spaces and newlines; lowercases and dedupes, order kept. */
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = []
  const invalid: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim().toLowerCase()
    if (!v) continue
    if (!EMAIL_RE.test(v)) { if (!invalid.includes(v)) invalid.push(v); continue }
    if (!emails.includes(v)) emails.push(v)
  }
  return { emails, invalid }
}

/** The list to show: what is saved, or the house default when nothing was ever saved. */
export function alwaysCopyForForm(saved: readonly string[] | null | undefined): string {
  return (saved ?? [DEFAULT_ALWAYS_COPY_EMAIL]).join('\n')
}

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: CUTOFF_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** Chicago wall-clock fields of an instant, as epoch ms read as if they were UTC. */
function chicagoWallAsUtc(ms: number): number {
  const p: Record<string, number> = {}
  for (const part of partsFormat.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** `2026-11-07T00:00` (Chicago wall time) → ISO instant; null when malformed. */
export function chicagoLocalToIso(local: string): string | null {
  const m = LOCAL_RE.exec(local.trim())
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  const w = new Date(wall)
  if (w.getUTCMonth() !== +m[2] - 1 || w.getUTCDate() !== +m[3] || +m[4] > 23 || +m[5] > 59) return null
  // Two passes settle the offset across a DST edge.
  let guess = wall
  for (let i = 0; i < 2; i += 1) guess = wall - (chicagoWallAsUtc(guess) - guess)
  return new Date(guess).toISOString()
}

/** ISO instant → `datetime-local` value in Chicago wall time; the default when unset. */
export function isoToChicagoLocal(iso: string | null | undefined): string {
  if (!iso) return DEFAULT_ALJEX_CUTOFF_LOCAL
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return DEFAULT_ALJEX_CUTOFF_LOCAL
  return new Date(chicagoWallAsUtc(ms)).toISOString().slice(0, 16)
}
