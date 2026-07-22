/**
 * Shared chrome for the Best Care Auto Transport customer emails (quote +
 * booking confirmation).
 *
 * Everything that must look identical across templates lives here: brand tokens,
 * the header logo, section/field rendering, the Google-reviews CTA, the contact
 * footer, and the outer document shell. Templates supply only their own body rows.
 *
 * The markup is table-based with fully inlined styles for broad email-client
 * compatibility (Gmail, Outlook, Apple Mail).
 */

// ── Brand tokens (from the screenshot) ──────────────────────────────────────
export const INK = '#111318'   // near-black header/footer
export const RED = '#e11d2a'   // Best Care red accent
export const TEXT = '#1f2530'  // body text
export const MUTED = '#8a94a6' // labels / secondary
export const LINE = '#e7ebf0'  // hairlines
export const CARD = '#f4f6f9'  // contact card background

// ── Best Care contact (shown in the email footer) ───────────────────────────
const CONTACT_NAME = 'Ruben Vargas'
const CONTACT_PHONE = '(224) 414-2700'
const CONTACT_PHONE_TEL = '+12244142700'
const CONTACT_EMAIL = 'cars@bcatcorp.com'

export function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** "$1,088" from "1088" / "$1088" / "1,088". Non-numeric input passes through. */
export function formatMoney(raw: string): string {
  const digits = String(raw ?? '').replace(/[^0-9.]/g, '')
  if (!digits) return esc(String(raw ?? ''))
  const n = Number(digits)
  if (!Number.isFinite(n)) return esc(String(raw ?? ''))
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0 })
}

/** Format an ISO yyyy-mm-dd as "May 4, 2026"; other strings pass through. */
export function formatDate(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (!m) return esc(String(raw ?? ''))
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Two-column label/value row used by the Route + Vehicle sections. Pass an empty
 * label to leave that half blank (for sections with an odd number of fields)
 * rather than rendering a stray em-dash.
 */
export function pairRow(l1: string, v1: string, l2: string, v2: string): string {
  const cell = (label: string, value: string) => label
    ? `
    <td width="50%" style="padding:0 0 4px;vertical-align:top;">
      <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">${esc(label)}</div>
      <div style="font:700 15px/1.5 Arial,Helvetica,sans-serif;color:${TEXT};padding-top:2px;">${value || '&mdash;'}</div>
    </td>`
    : `
    <td width="50%" style="padding:0 0 4px;">&nbsp;</td>`
  return `<tr>${cell(l1, v1)}${cell(l2, v2)}</tr>`
}

export function sectionHeading(title: string): string {
  return `
    <div style="font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:${TEXT};padding:6px 0 10px;">${esc(title)}</div>
    <div style="height:2px;background:${RED};width:100%;margin:0 0 16px;font-size:0;line-height:0;">&nbsp;</div>`
}

// ── Header ──────────────────────────────────────────────────────────────────

/**
 * The header logo. On screen the page passes the imported asset URL; the sent
 * email passes a `cid:` reference the emailer Lambda attaches inline. Omit it to
 * render the red text wordmark (the reliable default).
 */
export function logoBlock(logoSrc?: string): string {
  return logoSrc
    ? `<img src="${esc(logoSrc)}" alt="Best Care Auto Transport" width="220" style="display:block;margin:0 auto;max-width:220px;height:auto;" />`
    : `<div style="font:800 17px/1.2 Arial,Helvetica,sans-serif;letter-spacing:0.16em;color:${RED};text-transform:uppercase;">Best Care Auto Transport</div>`
}

/** Black header row: logo + title + subtitle. */
export function headerRow(opts: { logoSrc?: string; title: string; subtitle: string }): string {
  return `
          <tr>
            <td align="center" style="background:${INK};padding:26px 32px 24px;">
              ${logoBlock(opts.logoSrc)}
              <div style="font:700 21px/1.35 Arial,Helvetica,sans-serif;color:#ffffff;padding-top:12px;">${esc(opts.title)}</div>
              <div style="font:400 13px/1.5 Arial,Helvetica,sans-serif;color:#aeb6c4;padding-top:6px;">${opts.subtitle}</div>
            </td>
          </tr>`
}

/** Red band with an uppercase label over a large amount. */
export function amountBandRow(label: string, amount: string): string {
  return `
          <tr>
            <td align="center" style="background:${RED};padding:22px 32px;">
              <div style="font:700 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:#ffe1e3;">${esc(label)}</div>
              <div style="font:800 40px/1.1 Arial,Helvetica,sans-serif;color:#ffffff;padding-top:6px;">${amount}</div>
            </td>
          </tr>`
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
export function reviewsRow(reviews?: GoogleReviews | null): string {
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

// ── Footer ──────────────────────────────────────────────────────────────────

/** Dark footer: rep contact block + sign-off. `closing` is the last grey line. */
export function contactFooterRow(closing: string): string {
  return `
          <tr>
            <td align="center" style="background:${INK};padding:24px 32px;">
              <div style="font:700 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.1em;text-transform:uppercase;color:#8b93a3;padding-bottom:9px;">Your Best Care Contact</div>
              <div style="font:700 15px/1.4 Arial,Helvetica,sans-serif;color:#ffffff;">${CONTACT_NAME}</div>
              <div style="font:400 13px/1.7 Arial,Helvetica,sans-serif;padding-top:4px;">
                <a href="tel:${CONTACT_PHONE_TEL}" style="color:#ff6b73;text-decoration:none;">${CONTACT_PHONE}</a>
                <span style="color:#5c6373;">&nbsp;&middot;&nbsp;</span>
                <a href="mailto:${CONTACT_EMAIL}" style="color:#ff6b73;text-decoration:none;">${CONTACT_EMAIL}</a>
              </div>
              <div style="height:1px;background:#2a2e37;max-width:190px;margin:16px auto;font-size:0;line-height:0;">&nbsp;</div>
              <div style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:#c3cad6;">${closing}</div>
              <div style="font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#7f8798;padding-top:4px;">Or just reply to this email &mdash; we&rsquo;re happy to help.</div>
            </td>
          </tr>`
}

// ── Document shell ──────────────────────────────────────────────────────────

/** Wrap the supplied `<tr>` rows in the outer email document. */
export function renderEmailDocument(title: string, rows: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,0.08);">
${rows}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
