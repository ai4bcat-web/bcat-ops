/**
 * A picture a driver texts to the dispatch number is, nearly always, a POD.
 *
 * Twenty of them arrived in two days and not one reached the POD stores: the calendar
 * read "no POD" on loads whose proof was sitting in a text thread. So an inbound picture
 * or PDF from a known driver is filed as a POD on the load it can only be for — the
 * driver's one open delivery of the last couple of days, or the load whose PRO they
 * typed in the text. With several loads open and no PRO named, nothing is guessed: the
 * thread gets a note and File as POD on the page picks the load.
 */
import type { Load, Stop } from '../../../src/types'
import type { DispatchMedia } from '../../../src/lib/dispatch'
import { getStops } from '../../../src/lib/stops'
import { driverIsOnLoad } from '../../../src/lib/driverJourney'
import { stopDay } from '../../../src/lib/driverSchedule'
import { normalizePro } from '../../../src/lib/podPresence'
import { chicagoDateStr } from '../../../src/lib/date'
import { stopsAfterPod } from '../../../src/lib/stopEvents'

/** How many days back a delivery still counts as "the one they just did". */
export const POD_WINDOW_DAYS = 2

export interface AutoPodStore {
  loadsForDriver(driverId: string): Promise<Load[]>
  /** A POD is already on file for this load (from the app, the office or an earlier text). */
  hasPod(load: Load, driverId: string): Promise<boolean>
  fileSubmission(input: { driverId: string; driverName: string; load: Load; pro: string; pages: DispatchMedia[]; at: string }): Promise<{ submissionId: string }>
  markDelivered(load: Load, stops: Stop[], at: string): Promise<void>
}

export type PodPick =
  | { kind: 'one'; load: Load; how: 'pro' | 'only' }
  | { kind: 'many'; loads: Load[] }
  | { kind: 'none' }

const proOf = (l: Load) => normalizePro(l.aljexId ?? null)

/** The PRO numbers typed in a text, if any. */
export function prosInText(body: string | null | undefined): string[] {
  return [...(body ?? '').matchAll(/\b(\d{4,6})\b/g)].map((m) => m[1])
}

/** Which of the driver's loads a POD texted now is for. Pure; `hasPod` has already been applied to `open`. */
export function pickPodLoad(open: readonly Load[], all: readonly Load[], body: string | null | undefined, nowIso: string): PodPick {
  const typed = new Set(prosInText(body))
  if (typed.size) {
    const named = all.filter((l) => { const p = proOf(l); return !!p && typed.has(p) })
    if (named.length === 1) return { kind: 'one', load: named[0], how: 'pro' }
  }
  const today = chicagoDateStr(nowIso)
  const floor = chicagoDateStr(new Date(Date.parse(nowIso) - POD_WINDOW_DAYS * 86_400_000).toISOString())
  const recent = open.filter((l) => {
    const deliveries = getStops(l).filter((s) => s.type === 'delivery')
    if (!deliveries.length) return false
    const day = stopDay(deliveries[deliveries.length - 1])
    return !!day && day >= floor && day <= today
  })
  if (recent.length === 1) return { kind: 'one', load: recent[0], how: 'only' }
  if (recent.length === 0) return { kind: 'none' }
  return { kind: 'many', loads: recent }
}

export const isPodMedia = (m: DispatchMedia) => m.contentType.startsWith('image/') || m.contentType === 'application/pdf'

export type AutoPodOutcome =
  | { filed: true; load: Load; pro: string; how: 'pro' | 'only'; delivered: boolean }
  | { filed: false; reason: 'no-media' | 'no-driver' | 'none' | 'many'; loads?: Load[] }

export async function autoFilePod(
  store: AutoPodStore,
  driver: { id: string; name: string } | null,
  message: { body?: string | null; media?: DispatchMedia[] | null; at: string },
): Promise<AutoPodOutcome> {
  const pages = (message.media ?? []).filter(isPodMedia)
  if (!pages.length) return { filed: false, reason: 'no-media' }
  if (!driver) return { filed: false, reason: 'no-driver' }
  const all = (await store.loadsForDriver(driver.id)).filter((l) => driverIsOnLoad(l, driver.id))
  const open: Load[] = []
  for (const l of all) if (!(await store.hasPod(l, driver.id))) open.push(l)
  const pick = pickPodLoad(open, all, message.body, message.at)
  if (pick.kind === 'none') return { filed: false, reason: 'none' }
  if (pick.kind === 'many') return { filed: false, reason: 'many', loads: pick.loads }
  const pro = (pick.load.aljexId ?? '').trim() || pick.load.id.slice(0, 8)
  await store.fileSubmission({ driverId: driver.id, driverName: driver.name, load: pick.load, pro, pages, at: message.at })
  const stops = stopsAfterPod(pick.load, driver.id, message.at)
  if (stops) await store.markDelivered(pick.load, stops, message.at)
  return { filed: true, load: pick.load, pro, how: pick.how, delivered: !!stops }
}
