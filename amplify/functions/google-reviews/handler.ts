/**
 * google-reviews Lambda — custom AppSync query handler `getGoogleReviews`.
 *
 * Returns the live Google rating + review count for the Best Care Auto Transport
 * listing, used to render the "★ 4.9 · 127 reviews on Google" CTA in the vehicle
 * quote email. Results are cached in the warm container for ~6h (reviews change
 * slowly and the Places API is billed per call).
 *
 * Config (set in the Amplify Console env — a missing value is a graceful no-op, so
 * a deploy is never blocked):
 *   GOOGLE_PLACES_API_KEY — a key with the Places API enabled.
 *   GOOGLE_PLACE_ID       — the listing's Place ID.
 */

const KEY = process.env.GOOGLE_PLACES_API_KEY ?? ''
const PLACE_ID = process.env.GOOGLE_PLACE_ID ?? ''

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

const unconfigured: Result = { configured: false, ok: false, rating: null, total: null, url: null }

export const handler = async (): Promise<Result> => {
  if (!KEY || !PLACE_ID) return unconfigured

  if (cache && Date.now() - cache.at < TTL_MS) return cache.data

  const reviewsUrl = `https://search.google.com/local/reviews?placeid=${encodeURIComponent(PLACE_ID)}`

  try {
    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(PLACE_ID)}` +
      `&fields=rating,user_ratings_total` +
      `&key=${encodeURIComponent(KEY)}`

    const res = await fetch(url)
    const json = (await res.json()) as {
      status?: string
      error_message?: string
      result?: { rating?: number; user_ratings_total?: number }
    }

    if (json.status !== 'OK') {
      console.warn('[google-reviews] Places API status', json.status, json.error_message)
      // Still hand back the link so the CTA can render without the numbers.
      return { configured: true, ok: false, rating: null, total: null, url: reviewsUrl, error: json.status ?? 'error' }
    }

    const data: Result = {
      configured: true,
      ok: true,
      rating: json.result?.rating ?? null,
      total: json.result?.user_ratings_total ?? null,
      url: reviewsUrl,
    }
    cache = { at: Date.now(), data }
    return data
  } catch (err) {
    console.error('[google-reviews] fetch failed', err)
    return { configured: true, ok: false, rating: null, total: null, url: reviewsUrl, error: 'fetch-failed' }
  }
}
