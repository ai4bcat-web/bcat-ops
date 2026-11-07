/**
 * Step AW: "Possible duplicate" grouping for the customer list and profile.
 *
 * Aljex holds several accounts under near-identical names (every one is kept, keyed on its
 * Account #). This pure helper groups customers by a normalised name so a person can merge
 * them later. It never changes data.
 */

export interface DuplicateCandidate {
  id: string
  name: string
  aljexCode?: string | null
  mergedIntoId?: string | null
}

export interface DuplicateOther {
  id: string
  name: string
  aljexCode: string | null
}

export interface DuplicateInfo {
  /** How many OTHER accounts carry the same normalised name. */
  count: number
  others: DuplicateOther[]
}

const SUFFIX_TOKENS = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'plc',
])

/** Case, punctuation and legal-suffix insensitive: "ACME, Inc." and "Acme LLC" both give "acme". */
export function normalizeCustomerName(name: string): string {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.']/g, '') // L.L.C. -> llc, don't -> dont
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const tokens = base.split(' ').filter(Boolean)
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift()
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}

function accountKey(c: DuplicateCandidate): string {
  const code = c.aljexCode?.trim()
  return code ? `acct:${code}` : `id:${c.id}`
}

/**
 * Map of customer id -> its duplicates. Only customers that share a normalised name with a
 * customer of a DIFFERENT Aljex account appear; rows of the same account (same Account #) do
 * not count as duplicates of each other. Merged-away customers are ignored.
 */
export function buildDuplicateIndex(customers: readonly DuplicateCandidate[]): Map<string, DuplicateInfo> {
  const groups = new Map<string, DuplicateCandidate[]>()
  for (const c of customers) {
    if (c.mergedIntoId) continue
    const key = normalizeCustomerName(c.name)
    if (!key) continue
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
  }
  const index = new Map<string, DuplicateInfo>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    if (new Set(members.map(accountKey)).size < 2) continue
    for (const self of members) {
      const selfKey = accountKey(self)
      const others = members
        .filter((m) => m.id !== self.id && accountKey(m) !== selfKey)
        .map((m) => ({ id: m.id, name: m.name, aljexCode: m.aljexCode?.trim() || null }))
      if (others.length > 0) index.set(self.id, { count: others.length, others })
    }
  }
  return index
}

/** Tooltip text naming how many other accounts share the name. */
export function duplicateTooltip(info: DuplicateInfo): string {
  const n = info.count
  const codes = info.others.map((o) => o.aljexCode).filter((c): c is string => !!c)
  const tail = codes.length ? ` (Aljex account ${codes.join(', ')})` : ''
  return `${n} other account${n === 1 ? '' : 's'} share this name${tail}. Nothing is merged; review before merging.`
}
