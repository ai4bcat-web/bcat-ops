/**
 * Shared builder for the Best Care Auto Transport vehicle-transport quote email.
 *
 * The SAME function produces the on-screen preview and the HTML sent via SES, so
 * what Ruben sees is exactly what the customer receives. It reproduces the attached
 * screenshot design, with copy adapted for an *outbound* quote to the customer
 * (no "customer submitted via website" / internal confidence-score wording).
 *
 * The markup is table-based with fully inlined styles for broad email-client
 * compatibility (Gmail, Outlook, Apple Mail).
 */

export interface QuoteFields {
  /** Estimated quote amount, e.g. "1088" or "$1,088". Rendered with a leading $. */
  estimatedQuote: string
  fromZip: string
  toZip: string
  /** ISO date (yyyy-mm-dd) or any human string. */
  shipDate: string
  transportType: string
  vehicleType: string
  year: string
  make: string
  model: string
  customerName: string
  customerEmail: string
  customerPhone: string
  notes?: string
}

// ── Brand tokens (from the screenshot) ──────────────────────────────────────
const INK = '#111318'        // near-black header/footer
const RED = '#e11d2a'        // Best Care red accent
const TEXT = '#1f2530'       // body text
const MUTED = '#8a94a6'      // labels / secondary
const LINE = '#e7ebf0'       // hairlines
const CARD = '#f4f6f9'       // contact card background

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** "$1,088" from "1088" / "$1088" / "1,088". Non-numeric input passes through. */
export function formatQuote(raw: string): string {
  const digits = String(raw ?? '').replace(/[^0-9.]/g, '')
  if (!digits) return esc(String(raw ?? ''))
  const n = Number(digits)
  if (!Number.isFinite(n)) return esc(String(raw ?? ''))
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0 })
}

/** Format an ISO yyyy-mm-dd as "May 4, 2026"; other strings pass through. */
function formatShipDate(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (!m) return esc(String(raw ?? ''))
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Two-column label/value row used by the Route + Vehicle sections. */
function pairRow(l1: string, v1: string, l2: string, v2: string): string {
  const cell = (label: string, value: string) => `
    <td width="50%" style="padding:0 0 4px;vertical-align:top;">
      <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">${esc(label)}</div>
      <div style="font:700 15px/1.5 Arial,Helvetica,sans-serif;color:${TEXT};padding-top:2px;">${value || '&mdash;'}</div>
    </td>`
  return `<tr>${cell(l1, v1)}${cell(l2, v2)}</tr>`
}

function sectionHeading(title: string): string {
  return `
    <div style="font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:${TEXT};padding:6px 0 10px;">${esc(title)}</div>
    <div style="height:2px;background:${RED};width:100%;margin:0 0 16px;font-size:0;line-height:0;">&nbsp;</div>`
}

// ── Google reviews CTA ──────────────────────────────────────────────────────

export interface GoogleReviews {
  ok: boolean
  rating: number | null
  total: number | null
  url: string | null
}

const STAR_GOLD = '#fbbc04'
const STAR_EMPTY = '#d3d8e0'

function renderStars(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)))
  let out = ''
  for (let i = 0; i < 5; i++) out += `<span style="color:${i < full ? STAR_GOLD : STAR_EMPTY};">&#9733;</span>`
  return out
}

/**
 * A "★ 4.9 · 127 reviews on Google" pill linking to the listing's reviews page.
 * Renders nothing without a URL; falls back to a plain "Read our Google reviews"
 * link when the live numbers aren't available.
 */
function buildReviewsBlock(reviews?: GoogleReviews | null): string {
  if (!reviews || !reviews.url) return ''
  const hasNums = reviews.ok && reviews.rating != null
  const stars = renderStars(hasNums ? (reviews.rating as number) : 5)

  const inner = hasNums
    ? `<span style="font-weight:700;color:${TEXT};">${(reviews.rating as number).toFixed(1)}</span>` +
      `<span style="color:${MUTED};">&nbsp;&middot;&nbsp;</span>` +
      `<span style="color:${TEXT};">${reviews.total != null ? `${reviews.total.toLocaleString('en-US')} reviews on Google` : 'reviews on Google'}</span>`
    : `<span style="color:${TEXT};font-weight:600;">Read our Google reviews</span>`

  return `
          <tr>
            <td align="center" style="background:${CARD};padding:18px 32px;">
              <a href="${esc(reviews.url)}" target="_blank" style="text-decoration:none;display:inline-block;background:#ffffff;border:1px solid ${LINE};border-radius:999px;padding:11px 22px;">
                <span style="font:600 14px/1 Arial,Helvetica,sans-serif;white-space:nowrap;">
                  <span style="font-size:16px;letter-spacing:1px;vertical-align:middle;">${stars}</span>
                  <span style="vertical-align:middle;">&nbsp;&nbsp;${inner}</span>
                </span>
              </a>
            </td>
          </tr>`
}

/**
 * Build the full quote email HTML.
 *
 * `opts.logoSrc` is the header logo source. On screen the page passes the imported
 * asset URL; when we add a real Best Care logo image it can be a hosted URL or a
 * `data:`/`cid:` reference. Omit it to render the red text wordmark that matches
 * the screenshot exactly (the reliable default).
 *
 * `opts.reviews` are the live Google numbers; when present a "★ 4.9 · N reviews on
 * Google" CTA is rendered above the footer.
 */
export interface QuoteEmailOptions {
  logoSrc?: string
  reviews?: GoogleReviews | null
}

export function buildQuoteEmailHtml(f: QuoteFields, opts: QuoteEmailOptions = {}): string {
  const { logoSrc, reviews } = opts
  const quote = formatQuote(f.estimatedQuote)
  const reviewsRow = buildReviewsBlock(reviews)

  const logo = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="Best Care Auto Transport" width="220" style="display:block;margin:0 auto;max-width:220px;height:auto;" />`
    : `<div style="font:800 17px/1.2 Arial,Helvetica,sans-serif;letter-spacing:0.16em;color:${RED};text-transform:uppercase;">Best Care Auto Transport</div>`

  const notesBlock = (f.notes ?? '').trim()
    ? `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:${TEXT};white-space:pre-wrap;">${esc(f.notes!.trim())}</div>`
    : `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:${MUTED};">&mdash;</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>Your Vehicle Transport Quote</title>
</head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,0.08);">

          <!-- Header -->
          <tr>
            <td align="center" style="background:${INK};padding:26px 32px 24px;">
              ${logo}
              <div style="font:700 21px/1.35 Arial,Helvetica,sans-serif;color:#ffffff;padding-top:12px;">Your Vehicle Transport Quote</div>
              <div style="font:400 13px/1.5 Arial,Helvetica,sans-serif;color:#aeb6c4;padding-top:6px;">Here&rsquo;s your personalized quote from Best Care Auto Transport</div>
            </td>
          </tr>

          <!-- Quote band -->
          <tr>
            <td align="center" style="background:${RED};padding:22px 32px;">
              <div style="font:700 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:#ffe1e3;">Estimated Quote</div>
              <div style="font:800 40px/1.1 Arial,Helvetica,sans-serif;color:#ffffff;padding-top:6px;">${quote}</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px 8px;">

              ${sectionHeading('Route Details')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                ${pairRow('From ZIP', esc(f.fromZip), 'To ZIP', esc(f.toZip))}
                <tr><td colspan="2" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
                ${pairRow('Ship Date', formatShipDate(f.shipDate), 'Transport Type', esc(f.transportType))}
              </table>

              ${sectionHeading('Vehicle Information')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                ${pairRow('Vehicle Type', esc(f.vehicleType), 'Year', esc(f.year))}
                <tr><td colspan="2" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
                ${pairRow('Make', esc(f.make), 'Model', esc(f.model))}
              </table>

              <!-- Customer contact card -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border-radius:10px;margin:0 0 22px;">
                <tr><td style="padding:20px 22px;">
                  <div style="font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:${TEXT};padding:0 0 14px;">Customer Contact</div>

                  <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">Name</div>
                  <div style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${TEXT};padding:2px 0 12px;border-bottom:1px solid ${LINE};margin-bottom:12px;">${esc(f.customerName) || '&mdash;'}</div>

                  <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">Email</div>
                  <div style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${RED};padding:2px 0 12px;border-bottom:1px solid ${LINE};margin-bottom:12px;">${esc(f.customerEmail) || '&mdash;'}</div>

                  <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">Phone</div>
                  <div style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${RED};padding:2px 0 0;">${esc(f.customerPhone) || '&mdash;'}</div>
                </td></tr>
              </table>

              ${sectionHeading('Additional Notes')}
              <div style="padding:0 0 8px;">${notesBlock}</div>

            </td>
          </tr>

          <!-- Google reviews CTA -->
          ${reviewsRow}

          <!-- Footer -->
          <tr>
            <td align="center" style="background:${INK};padding:20px 32px;">
              <div style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:#c3cad6;">This quote was prepared for you by <strong style="color:#ffffff;">Best Care Auto Transport</strong>.</div>
              <div style="font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#7f8798;padding-top:4px;">Questions? Just reply to this email &mdash; we&rsquo;re happy to help.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** Default subject line for a quote email. */
export function buildQuoteSubject(f: QuoteFields): string {
  const veh = [f.year, f.make, f.model].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ')
  return veh
    ? `Your Best Care Auto Transport quote — ${veh}`
    : 'Your Vehicle Transport Quote — Best Care Auto Transport'
}
