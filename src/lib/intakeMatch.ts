/**
 * Has this intake item already been built?
 *
 * An intake item is a tender that landed in Slack. Someone reads it, builds the load by
 * hand, replies "PRO# 14589 - Added in BCAT Ops", and — almost never — goes back to the
 * app to move the item out of NEW. Measured on the live table: 309 items sit in NEW or
 * NEED_TO_BUILD while the load they describe already exists, 200 of them matched on a
 * number the subject labels outright. The queue says there is a day's work outstanding
 * when most of it is done.
 *
 * So the queue stops trusting its own status field and asks the loads instead. The subject
 * carries a number — "Tender TMS ID 212666394", "Rate Confirmation for Route # 4010756658",
 * "Signatures Complete: Pro # 1103128" — and a load carries the same number as its TMS id,
 * its pickup (PO) number, or its PRO.
 *
 * CONFIDENCE MATTERS. A bare 5-to-12-digit number in a forwarded email body can collide
 * with an unrelated load's id by chance, and a wrong match would tell somebody a tender was
 * handled when it was not. So a number the text LABELS is trusted, and an unlabelled one is
 * reported separately as a weaker suggestion for a human to confirm.
 *
 * Pure: text and loads in, a verdict out.
 */
import type { Load } from '@/types'

export type MatchConfidence = 'LABELLED' | 'LOOSE'

export interface IntakeMatch {
  load: Load
  /** The PRO to quote back into Slack. Trimmed — the table stores them padded. */
  pro: string
  /** Which field of the load the number was found in. */
  matchedOn: 'tmsId' | 'pickupNumber' | 'aljexId'
  /** The number that matched, as written in the intake text. */
  matchedValue: string
  confidence: MatchConfidence
}

/**
 * Numbers the text names. The labels are the ones that actually appear in these subjects;
 * anything else is treated as unlabelled rather than guessed at.
 */
const LABELLED = /(?:TMS\s*ID|Route\s*#|PO\s*#?|PRO\s*#?|Order\s*#?|Load\s*#?|BOL\s*#?)\s*:?\s*(\d{5,12})/gi
const ANY_NUMBER = /\b\d{5,12}\b/g

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

export function candidateNumbers(text: string): { labelled: string[]; loose: string[] } {
  const body = text ?? ''
  const labelled = uniq([...body.matchAll(LABELLED)].map((m) => m[1]))
  const loose = uniq([...body.matchAll(ANY_NUMBER)].map((m) => m[0])).filter((n) => !labelled.includes(n))
  return { labelled, loose }
}

/** Index of every identifier a load answers to. First load wins a duplicate. */
export interface LoadIndex {
  byTms: Map<string, Load>
  byPickup: Map<string, Load>
  byPro: Map<string, Load>
}

export function buildLoadIndex(loads: Load[]): LoadIndex {
  const byTms = new Map<string, Load>()
  const byPickup = new Map<string, Load>()
  const byPro = new Map<string, Load>()
  for (const load of loads) {
    const put = (map: Map<string, Load>, raw: unknown) => {
      const key = String(raw ?? '').trim()
      if (key && !map.has(key)) map.set(key, load)
    }
    put(byTms, load.tmsId)
    put(byPickup, load.pickupNumber)
    put(byPro, load.aljexId)
  }
  return { byTms, byPickup, byPro }
}

/**
 * The load this intake item describes, or null.
 *
 * Fields are tried in the order that makes a false positive least likely: the TMS id is
 * the broker's own reference and appears verbatim in the tender, the PO number next, and
 * the PRO last — a PRO is only five digits here, so it is the easiest to hit by accident.
 */
export function matchIntakeToLoad(text: string, index: LoadIndex): IntakeMatch | null {
  const { labelled, loose } = candidateNumbers(text)

  for (const [numbers, confidence] of [[labelled, 'LABELLED'], [loose, 'LOOSE']] as const) {
    for (const value of numbers) {
      for (const [map, field] of [
        [index.byTms, 'tmsId'],
        [index.byPickup, 'pickupNumber'],
        [index.byPro, 'aljexId'],
      ] as const) {
        const load = map.get(value)
        if (load) {
          return {
            load,
            pro: String(load.aljexId ?? '').trim() || String(load.tmsId ?? '').trim() || load.id,
            matchedOn: field,
            matchedValue: value,
            confidence,
          }
        }
      }
    }
  }
  return null
}

/** What a person would type into the thread. Matches the wording already in use there. */
export function slackBuiltReply(pro: string): string {
  return `PRO# ${pro} - Added in BCAT Ops`
}
