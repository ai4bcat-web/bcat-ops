/**
 * What the driver was in the middle of sending, remembered across a relaunch.
 *
 * A driver tapped Send on a load, the scan screen appeared for an instant, and the app
 * dropped back to the settlement. Nothing in the flow navigates — the whole path is
 * covered by ScanPage.multipage.test.tsx and it stays put. What happens is that iOS
 * discards the web view while the phone's file picker is in front of it, which on a
 * home-screen app means a relaunch at `start_url` — `/driver` — whose index route sends
 * them to the settlement. From the driver's side the app simply threw their place away.
 *
 * So the intent is written down. The pages themselves cannot survive — they are Blobs the
 * relaunch destroys, and the pick is gone with them — but which load and which document
 * can, and landing back on the right screen with the PRO already filled is the difference
 * between picking the file again and wondering what happened.
 *
 * sessionStorage, not local: this is about one interrupted task, and a PRO from last
 * Tuesday reappearing under a driver's thumb would be worse than forgetting.
 */
const KEY = 'bcat.driver.scanIntent'

/** Long enough to survive a picker and a relaunch; short enough not to haunt them. */
const FRESH_FOR_MS = 15 * 60 * 1000

export interface ScanIntent {
  kind: 'pod' | 'ratecon'
  pro?: string
  submissionId?: string
  /** The load the Ivan paperwork page handed over, so the resumed scan still links to it. */
  loadId?: string
  /** Epoch ms, so a stale intent can be ignored rather than acted on. */
  at: number
}

export function rememberScanIntent(intent: Omit<ScanIntent, 'at'>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...intent, at: Date.now() }))
  } catch {
    // A phone with storage blocked still gets to send a POD; it just will not be
    // returned to this screen if the app restarts.
  }
}

export function forgetScanIntent(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to do, and nothing worth telling a driver about.
  }
}

/** The intent if there is a recent one, otherwise null. Never throws. */
export function readScanIntent(now = Date.now()): ScanIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ScanIntent>
    if (parsed.kind !== 'pod' && parsed.kind !== 'ratecon') return null
    if (typeof parsed.at !== 'number' || now - parsed.at > FRESH_FOR_MS) return null
    return {
      kind: parsed.kind,
      pro: typeof parsed.pro === 'string' ? parsed.pro : undefined,
      submissionId: typeof parsed.submissionId === 'string' ? parsed.submissionId : undefined,
      loadId: typeof parsed.loadId === 'string' ? parsed.loadId : undefined,
      at: parsed.at,
    }
  } catch {
    return null
  }
}

/** The route that resumes it: `/driver/scan?kind=pod&pro=14538`. */
export function scanIntentPath(intent: ScanIntent): string {
  const params = new URLSearchParams({ kind: intent.kind })
  if (intent.pro) params.set('pro', intent.pro)
  if (intent.submissionId) params.set('submissionId', intent.submissionId)
  if (intent.loadId) params.set('loadId', intent.loadId)
  return `/driver/scan?${params.toString()}`
}
