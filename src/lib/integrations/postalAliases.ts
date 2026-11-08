/**
 * Step J — postal-code aliases.
 *
 * A brokerage keys lanes on the city a shipper calls itself, not the city the post
 * office calls it: 60106 is "Bensenville" on the BOL and "Chicago" in half the quotes.
 * The org stores the aliases it wants; `laneKeyFor` applies them so two spellings of
 * the same ZIP stop being two lanes. Existing samples are never rewritten.
 */

export interface PostalAlias {
  zip: string
  city: string
  state: string
}

/** `'60106-1234'` → `'60106'`; anything that is not a US ZIP is not a key. */
function zip5(value: string | null | undefined): string | null {
  const match = (value ?? '').trim().match(/^(\d{5})(?:-?\d{4})?$/)
  return match ? match[1] : null
}

/**
 * The aliases as a lookup, keyed by five-digit ZIP. A row with no usable ZIP, city or
 * two-letter state is dropped rather than half-applied; the last row for a ZIP wins,
 * which is what an editor appending a correction expects.
 */
export function aliasMap(
  aliases: PostalAlias[] | null | undefined,
): Record<string, { city: string; state: string }> {
  const out: Record<string, { city: string; state: string }> = {}
  for (const alias of aliases ?? []) {
    if (!alias) continue
    const zip = zip5(alias.zip)
    const city = (alias.city ?? '').trim()
    const state = (alias.state ?? '').trim()
    if (!zip || !city || !/^[A-Za-z]{2}$/.test(state)) continue
    out[zip] = { city, state }
  }
  return out
}
