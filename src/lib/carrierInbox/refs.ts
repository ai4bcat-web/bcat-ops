/**
 * Step AL §4.2 — deterministic candidate load / posting references from text. The router
 * resolves each one against `ProClaim` (one GetItem per ref); a reference that does not
 * resolve scores nothing, so over-collecting here is cheap and never trusted.
 */
import { normalizePro } from '../proNumber'
import { addressOf } from '../spot/prefilter'

export interface CandidateRefs {
  subject: string[]
  body: string[]
  /** From `<local>+bids.<ref>@`, `<local>+<ref>@`, `<local>.bids.<ref>@` in To/Cc. */
  plus: string[]
}

const MAX_REFS = 10

const LABELED =
  /\b(?:pro|load|ld|ref(?:erence)?|order|shipment|job|posting|post)\b\s*(?:#|no\.?|num(?:ber)?|id)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,24})/gi
/** `S000123-1`, `ZZAL1001`: letters then a long digit run (the shape shipment counters issue). */
const SHAPED = /\b[A-Z]{1,4}\d{5,}(?:-\d+)?\b/g
const HASHED = /#\s*(\d{3,}[A-Za-z0-9-]*)/g
/** "MC 123456", "USDOT# 765", "DOT-765": identity numbers are not load references. */
const IDENTITY = /\b(?:us\s*)?(?:mc|dot|usdot|mx|ff)\s*(?:#|no\.?|number)?\s*[-:#]?\s*\d[\d-]*/gi

function collect(text: string | null | undefined): string[] {
  const clean = String(text ?? '').replace(IDENTITY, ' ')
  const found: string[] = []
  const push = (token: string | undefined): void => {
    if (!token || !/\d/.test(token)) return
    const key = normalizePro(token)
    if (key && !found.includes(key)) found.push(key)
  }
  for (const m of clean.matchAll(LABELED)) push(m[1])
  for (const m of clean.matchAll(SHAPED)) push(m[0])
  for (const m of clean.matchAll(HASHED)) push(m[1])
  return found.slice(0, MAX_REFS)
}

function plusRefs(addresses: string[]): string[] {
  const found: string[] = []
  for (const raw of addresses) {
    const address = addressOf(raw)
    const local = address.slice(0, address.lastIndexOf('@') < 0 ? 0 : address.lastIndexOf('@'))
    if (!local) continue
    const m =
      /^[^+]+\+bids[.-]([a-z0-9-]{3,})$/.exec(local) ??
      /^[^+]+\+([a-z0-9-]{3,})$/.exec(local) ??
      /^.+\.bids\.([a-z0-9-]{3,})$/.exec(local)
    if (!m || !/\d/.test(m[1])) continue
    const key = normalizePro(m[1])
    if (key && !found.includes(key)) found.push(key)
  }
  return found.slice(0, MAX_REFS)
}

export function candidateRefs(subject: string | null, body: string, to: string[], cc: string[]): CandidateRefs {
  return { subject: collect(subject), body: collect(body), plus: plusRefs([...(to ?? []), ...(cc ?? [])]) }
}

/** Every normalized reference the router must resolve through ProClaim (<= 10, deduped). */
export function allRefsToResolve(x: { loadRefs: string[] }, refs: CandidateRefs): string[] {
  const out: string[] = []
  for (const ref of [...refs.plus, ...refs.subject, ...x.loadRefs, ...refs.body]) {
    if (!out.includes(ref)) out.push(ref)
    if (out.length >= MAX_REFS) break
  }
  return out
}

/** True when the text carries anything that looks like a load or posting reference. */
export function hasReferenceToken(text: string): boolean {
  return collect(text).length > 0
}
