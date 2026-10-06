/**
 * Is a POD on file for this load?
 *
 * The answer lives in two places that were never joined up:
 *
 *  - `PodDocument` — PODs that arrived at JobsDone by text or email, linked to a load
 *    by a human on the PODs page. Keyed by `Load.id`.
 *  - `DriverSubmissionDoc` with kind POD — what a driver scans in the PWA, and what
 *    staff upload on a driver's behalf from the load drawer or the PODs page. Keyed by
 *    its submission, which carries an optional `loadId` and a free-text
 *    `referenceNumber` the driver typed.
 *
 * Before this module only the first counted. A driver could photograph a signed POD,
 * watch it post to Slack, and the settlement would still show POD missing in amber.
 * That was survivable while the flag was decoration. It is not survivable now that a
 * POD decides whether the load gets paid, so both stores are consulted.
 *
 * Reference matching is deliberately strict. A loose match would attach a POD to the
 * wrong load and pay out against the wrong paperwork, which is worse than asking
 * someone to link it by hand: compare only normalized PRO strings of at least three
 * characters, and never fall back to a partial or fuzzy match.
 */

/**
 * Where a document actually lives, so a screen can open the thing rather than only say
 * it exists.
 *
 * Two shapes because the two stores are reached differently and cannot be unified. A
 * driver upload and a staff rate confirmation are S3 keys the browser may presign
 * itself (`driver-docs/`, `rate-confirms/`). A JobsDone POD lives under `pods/`, which
 * no browser credential can read — that prefix is deliberately absent from the storage
 * rules — so it is reached by id through the pod-actions Lambda, which presigns it.
 */
export type DocRef =
  | { kind: 's3'; key: string }
  | { kind: 'podDocument'; id: string }

/** Just enough of a submission to decide, from any source. */
export interface PodSubmissionLike {
  loadId?: string | null
  referenceNumber?: string | null
  /** True when this submission carries at least one POD page. */
  hasPodDoc: boolean
  /** True when it carries at least one rate-confirmation page. */
  hasRateconDoc?: boolean
  /** S3 key of the finished POD — the merged PDF where there is one. */
  podKey?: string | null
  /** S3 key of the finished rate confirmation. */
  rateconKey?: string | null
  /**
   * When the POD actually landed, ISO. The settlement pages show it so somebody chasing
   * paperwork can tell "sent an hour ago" from "sent three weeks ago" — a present tick
   * says nothing about whether it arrived in time to invoice.
   */
  podUploadedAt?: string | null
}

/** Just enough of a load to look it up. `aljexId` is the PRO. */
export interface PodLoadLike {
  id: string
  aljexId?: string | null
}

/** One document kind: which loads have it, by id and by PRO. */
export interface DocKeys {
  byLoadId: Set<string>
  byPro: Set<string>
  /**
   * Where to find it, when the store that answered knew. Presence and location are kept
   * apart on purpose: a load can be known to HAVE a POD from a store that cannot say
   * where it is, and that must still read as "on file" rather than as missing.
   */
  refByLoadId: Map<string, DocRef>
  refByPro: Map<string, DocRef>
}

export interface PodIndex {
  pod: DocKeys
  ratecon: DocKeys
  /**
   * When each load's POD arrived, by load id and by PRO. The EARLIEST upload wins: a POD
   * re-sent today does not make a load that was papered a fortnight ago look late.
   */
  podAt: { byLoadId: Map<string, string>; byPro: Map<string, string> }
}

/**
 * Normalize a PRO for comparison. The live table stores them padded ("14452  "), and
 * a driver may type "PRO 13364" or "pro#13364" for the same load, so strip to
 * alphanumerics and upper-case. Returns null for anything too short to be a real PRO.
 */
export function normalizePro(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (raw.toUpperCase() === 'N/A') return null
  // Drop a leading "PRO" label if the person typed one, then keep alphanumerics.
  const stripped = raw.replace(/^\s*pro\s*#?\s*/i, '')
  const key = stripped.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return key.length >= 3 ? key : null
}

/** Build the lookup once per page load, then ask it per trip. */
export function buildPodIndex(input: {
  /** Load ids with a JobsDone PodDocument already linked to them. */
  jobsdoneLoadIds: Iterable<string>
  /** Every driver submission known, from the PWA and from staff uploads. */
  submissions: PodSubmissionLike[]
  /** Load ids whose Load row already carries a rate-confirmation S3 key. */
  rateconLoadIds?: Iterable<string>
  /** load id → PodDocument id, so a JobsDone POD can be opened through the Lambda. */
  jobsdonePodIds?: Iterable<readonly [string, string]>
  /** load id → `rate-confirms/…` key off the Load row. */
  rateconKeys?: Iterable<readonly [string, string]>
}): PodIndex {
  const emptyRefs = () => ({ refByLoadId: new Map<string, DocRef>(), refByPro: new Map<string, DocRef>() })
  const pod: DocKeys = { byLoadId: new Set(input.jobsdoneLoadIds), byPro: new Set(), ...emptyRefs() }
  const ratecon: DocKeys = { byLoadId: new Set(input.rateconLoadIds ?? []), byPro: new Set(), ...emptyRefs() }

  for (const [loadId, id] of input.jobsdonePodIds ?? []) {
    if (loadId && id) pod.refByLoadId.set(loadId, { kind: 'podDocument', id })
  }
  for (const [loadId, key] of input.rateconKeys ?? []) {
    if (loadId && key) ratecon.refByLoadId.set(loadId, { kind: 's3', key })
  }
  const podAt = { byLoadId: new Map<string, string>(), byPro: new Map<string, string>() }

  /** Keep the earliest timestamp seen for a key. */
  function noteArrival(map: Map<string, string>, key: string, at: string | null | undefined): void {
    const when = (at ?? '').trim()
    if (!when) return
    const existing = map.get(key)
    if (!existing || when < existing) map.set(key, when)
  }

  for (const s of input.submissions) {
    const loadId = (s.loadId ?? '').trim()
    const pro = normalizePro(s.referenceNumber)
    for (const [has, keys, key] of [
      [s.hasPodDoc, pod, s.podKey],
      [s.hasRateconDoc, ratecon, s.rateconKey],
    ] as const) {
      if (!has) continue
      if (loadId) keys.byLoadId.add(loadId)
      if (pro) keys.byPro.add(pro)
      /*
       * A ref already placed by the Load row wins. That one is what the office uploaded
       * against this load; a driver submission matched only by a PRO the driver typed is
       * the weaker claim, and must not replace it.
       */
      const trimmed = (key ?? '').trim()
      if (trimmed) {
        if (loadId && !keys.refByLoadId.has(loadId)) keys.refByLoadId.set(loadId, { kind: 's3', key: trimmed })
        if (pro && !keys.refByPro.has(pro)) keys.refByPro.set(pro, { kind: 's3', key: trimmed })
      }
    }
    if (s.hasPodDoc) {
      if (loadId) noteArrival(podAt.byLoadId, loadId, s.podUploadedAt)
      if (pro) noteArrival(podAt.byPro, pro, s.podUploadedAt)
    }
  }

  return { pod, ratecon, podAt }
}

/** When this load's POD arrived, or null when nothing is on file (or nothing recorded it). */
export function podUploadedAt(index: PodIndex, load: PodLoadLike): string | null {
  const byId = index.podAt.byLoadId.get(load.id)
  if (byId) return byId
  const pro = normalizePro(load.aljexId)
  return (pro && index.podAt.byPro.get(pro)) || null
}

function hasDoc(keys: DocKeys, load: PodLoadLike): boolean {
  if (keys.byLoadId.has(load.id)) return true
  const pro = normalizePro(load.aljexId)
  return pro !== null && keys.byPro.has(pro)
}

function docRef(keys: DocKeys, load: PodLoadLike): DocRef | null {
  const byId = keys.refByLoadId.get(load.id)
  if (byId) return byId
  const pro = normalizePro(load.aljexId)
  return (pro && keys.refByPro.get(pro)) || null
}

/** True when some store holds a POD for this load. */
export function loadHasPod(index: PodIndex, load: PodLoadLike): boolean {
  return hasDoc(index.pod, load)
}

/** Where this load's POD is, when a store could say. Null is "on file but not locatable". */
export function loadPodRef(index: PodIndex, load: PodLoadLike): DocRef | null {
  return docRef(index.pod, load)
}

/** Where this load's rate confirmation is, when a store could say. */
export function loadRateconRef(index: PodIndex, load: PodLoadLike): DocRef | null {
  return docRef(index.ratecon, load)
}

/**
 * True when some store holds a rate confirmation for this load — the key on the Load
 * row that staff upload from the load drawer, or a RATECON a driver scanned in the PWA.
 */
export function loadHasRatecon(index: PodIndex, load: PodLoadLike): boolean {
  return hasDoc(index.ratecon, load)
}
