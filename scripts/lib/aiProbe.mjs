/**
 * Pure helpers of devVerifyAI (Step AI harness): the fixture arithmetic, the hidden-value scanner and the percentile.
 *
 * Fixture design: five fixture "slots" carry DISTINCT base amounts (100,000 .. 1,600,000 cents, powers of two times
 * 100,000), so any subset sum identifies exactly which slots contributed to a number. A viewer's expected result is the sum
 * over the slots that viewer may see PER SOURCE (samples, shipments, open invoices, quotes), because a row can be visible
 * through a different rule in each source (the C3 shipment/sample/quote carry a direct sales-rep field naming repb; the C3
 * invoice joins that shipment, so repb reaches it through the rep field too).
 *
 *   C1  owned by repa            C2  on team ZZAI (tm is a member)        C3  owned by someone else
 *   C4  no owner and no team     C3D the C3 row whose sales rep is repb (direct-rep path)
 */

/** Nearest-rank percentile (p in 0-100); NaN when there are no values. */
export function percentile(xs, p) {
  const v = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (!v.length) return NaN
  const rank = Math.max(1, Math.ceil((p / 100) * v.length))
  return v[Math.min(v.length, rank) - 1]
}

export const SLOTS = ['C1', 'C2', 'C3', 'C4', 'C3D']
export const AMOUNTS = { C1: 100_000, C2: 200_000, C3: 400_000, C4: 800_000, C3D: 1_600_000 }
/** Cost is 80 % of revenue, profit 20 %: integers for every amount above. */
export const costOf = (revenue) => (revenue * 4) / 5
export const profitOf = (revenue) => revenue / 5
/** Open-invoice slots: one per customer (C3's invoice joins the C3D shipment). */
export const AR_SLOTS = ['C1', 'C2', 'C3', 'C4']

const ALL = { sample: SLOTS, ship: SLOTS, ar: AR_SLOTS, quote: SLOTS }
/** Which slots each persona may see, per source. `viewAll` personas see everything; the others none of the rest. */
export const VISIBLE = {
  repa: { sample: ['C1'], ship: ['C1'], ar: ['C1'], quote: ['C1'] },
  tm: { sample: ['C2'], ship: ['C2'], ar: ['C2'], quote: ['C2'] },
  repb: { sample: ['C3D'], ship: ['C3D'], ar: ['C3'], quote: ['C3D'] },
  none: { sample: [], ship: [], ar: [], quote: [] },
  all: ALL,
}

const sum = (slots) => slots.reduce((a, s) => a + AMOUNTS[s], 0)

/** The numbers a persona's reference-spec run must produce (null where the executor yields null for "no rows"). */
export function expectedSums(persona) {
  const v = VISIBLE[persona]
  if (!v) throw new Error(`unknown persona ${persona}`)
  const rev = sum(v.sample)
  const has = v.sample.length > 0
  return {
    revenue: has ? rev : null,
    cost: has ? costOf(rev) : null,
    profit: has ? profitOf(rev) : null,
    samples: v.sample.length,
    shipments: v.ship.length,
    arOpen: v.ar.length ? sum(v.ar) : null,
    arCount: v.ar.length,
    quotes: v.quote.length,
    quoteOpenValue: v.quote.length ? sum(v.quote) : null,
  }
}

/** The slots a persona must NOT see in any source (a slot visible in one source but not another is not forbidden). */
export function forbiddenSlots(persona) {
  const v = VISIBLE[persona]
  const seen = new Set([...v.sample, ...v.ship, ...v.ar, ...v.quote])
  return SLOTS.filter((s) => !seen.has(s))
}

export const money = (cents) => `$${Math.floor(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`

function walk(value, visit) {
  if (Array.isArray(value)) { for (const v of value) walk(v, visit); return }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) walk(v, visit); return }
  visit(value)
}

/**
 * Scans a serialised result for values that must not be there: customer names / ids (substring), base amounts as numbers
 * (exact) and as money text. Returns human-readable hits (never the value of a visible field).
 *   forbidden = { names: string[], ids: string[], cents: number[] }
 */
export function scanForbidden(result, forbidden) {
  const hits = []
  const cents = new Set(forbidden.cents ?? [])
  const moneyText = new Map((forbidden.cents ?? []).map((c) => [money(c), c]))
  walk(result, (leaf) => {
    if (typeof leaf === 'number' && cents.has(leaf)) hits.push(`number ${leaf}`)
    if (typeof leaf !== 'string') return
    for (const n of forbidden.names ?? []) if (n && leaf.includes(n)) hits.push(`name "${n}"`)
    for (const id of forbidden.ids ?? []) if (id && leaf.includes(id)) hits.push(`id ${id}`)
    for (const [text, c] of moneyText) if (leaf.includes(text)) hits.push(`money ${c}`)
  })
  return [...new Set(hits)]
}

/** Reads a KPI value from a widget result by its label (null when absent). */
export function kpiValue(results, widgetId, label) {
  const r = results.find((x) => x.widgetId === widgetId)
  if (!r || !r.ok) return undefined
  return (r.series.kpis ?? []).find((k) => k.label === label)?.value
}

/** The row labels of a chart/table widget, in order. */
export function rowLabels(results, widgetId) {
  const r = results.find((x) => x.widgetId === widgetId)
  return r && r.ok ? r.series.rows.map((row) => row.label) : undefined
}

/** Canonical JSON (sorted keys) so two snapshots of the same JSON compare equal whatever their key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
