/**
 * google-reviews Lambda — custom AppSync query handler `getGoogleReviews`.
 *
 * Returns the live Google rating + review count for the Best Care Auto Transport
 * listing, used to render the "★ 4.9 · 127 reviews on Google" CTA in the vehicle
 * quote email. Results are cached in the warm container for ~6h (reviews change
 * slowly and the Places API is billed per call).
 *
 * The reviews LINK is always available (built from the listing's CID), so the CTA
 * renders as a plain "Read our Google reviews" link even before the API key is set.
 * Once GOOGLE_PLACES_API_KEY is configured the live numbers are added.
 *
 * Config (set in the Amplify Console env — every value has a working default for
 * the Best Care listing, so a deploy is never blocked):
 *   GOOGLE_PLACES_API_KEY — a key with the Places API enabled. REQUIRED for numbers.
 *   GOOGLE_PLACE_ID       — optional. If set, queries Place Details directly (cheaper,
 *                           exact). If blank, the listing is resolved from the query
 *                           below via Find Place From Text.
 *   GOOGLE_PLACE_QUERY    — business name + address used to resolve the listing.
 *   GOOGLE_REVIEWS_URL    — customer-facing reviews link when no Place ID is set.
 */

const KEY = process.env.GOOGLE_PLACES_API_KEY ?? ''
const PLACE_ID = process.env.GOOGLE_PLACE_ID ?? ''
// `||` (not `??`) so an empty env var from the backend passthrough falls back to
// the default rather than blanking the value.
const PLACE_QUERY = process.env.GOOGLE_PLACE_QUERY
  || 'Best Care Auto Transport, 1193 E Higgins Rd, Elk Grove Village, IL 60007'
// CID-based maps link for the listing — works without any API resolution.
const REVIEWS_URL_FALLBACK = process.env.GOOGLE_REVIEWS_URL
  || 'https://www.google.com/maps?cid=2781568378344970342'

const TTL_MS = 6 * 60 * 60 * 1000
let cache: { at: number; data: Result } | null = null

interface Result {
  configured: boolean
  ok: boolean
  rating: number | null
  total: number | null
  url: string | null
  error?: string
}

const reviewsUrlForId = (pid: string) =>
  `https://search.google.com/local/reviews?placeid=${encodeURIComponent(pid)}`

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url)
  return (await res.json()) as Record<string, unknown>
}

export const handler = async (): Promise<Result> => {
  // The reviews link is always known; prefer the direct-reviews link when a Place
  // ID is configured, otherwise the CID maps link.
  let url = PLACE_ID ? reviewsUrlForId(PLACE_ID) : REVIEWS_URL_FALLBACK

  if (!KEY) return { configured: false, ok: false, rating: null, total: null, url }

  if (cache && Date.now() - cache.at < TTL_MS) return cache.data

  try {
    let rating: number | null = null
    let total: number | null = null

    if (PLACE_ID) {
      const json = await fetchJson(
        `https://maps.googleapis.com/maps/api/place/details/json` +
        `?place_id=${encodeURIComponent(PLACE_ID)}&fields=rating,user_ratings_total&key=${encodeURIComponent(KEY)}`
      )
      if (json.status !== 'OK') {
        console.warn('[google-reviews] Details status', json.status, json.error_message)
        return { configured: true, ok: false, rating: null, total: null, url, error: String(json.status ?? 'error') }
      }
      const r = json.result as { rating?: number; user_ratings_total?: number } | undefined
      rating = r?.rating ?? null
      total = r?.user_ratings_total ?? null
    } else {
      // Resolve the listing (place_id + numbers) from the business name/address.
      const json = await fetchJson(
        `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
        `?input=${encodeURIComponent(PLACE_QUERY)}&inputtype=textquery` +
        `&fields=place_id,rating,user_ratings_total&key=${encodeURIComponent(KEY)}`
      )
      if (json.status !== 'OK') {
        console.warn('[google-reviews] FindPlace status', json.status, json.error_message)
        return { configured: true, ok: false, rating: null, total: null, url, error: String(json.status ?? 'error') }
      }
      const cand = (json.candidates as Array<{ place_id?: string; rating?: number; user_ratings_total?: number }>)?.[0]
      rating = cand?.rating ?? null
      total = cand?.user_ratings_total ?? null
      if (cand?.place_id) url = reviewsUrlForId(cand.place_id)
    }

    const data: Result = { configured: true, ok: rating != null, rating, total, url }
    cache = { at: Date.now(), data }
    return data
  } catch (err) {
    console.error('[google-reviews] fetch failed', err)
    return { configured: true, ok: false, rating: null, total: null, url, error: 'fetch-failed' }
  }
}
