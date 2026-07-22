/**
 * Builder for the Best Care Auto Transport vehicle-transport QUOTE email.
 *
 * The SAME function produces the on-screen preview and the HTML sent via SES, so
 * what Ruben sees is exactly what the customer receives. It reproduces the attached
 * screenshot design, with copy adapted for an *outbound* quote to the customer
 * (no "customer submitted via website" / internal confidence-score wording).
 *
 * Shared header/footer/section chrome lives in `emailChrome.ts` so the quote and
 * booking-confirmation emails stay visually identical.
 */
import {
  TEXT, MUTED, LINE, CARD, RED,
  esc, formatMoney, formatDate, pairRow, sectionHeading,
  headerRow, amountBandRow, reviewsRow, contactFooterRow, renderEmailDocument,
  type GoogleReviews,
} from './emailChrome'

export type { GoogleReviews }
/** @deprecated use `formatMoney` from emailChrome. Kept for existing callers. */
export const formatQuote = formatMoney

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

/**
 * `opts.logoSrc` is the header logo source. On screen the page passes the imported
 * asset URL; the sent email passes the `cid:` reference the emailer Lambda attaches
 * inline. Omit it to render the red text wordmark (the reliable default).
 *
 * `opts.reviews` are the live Google numbers; when present a "★ 4.8 · N reviews on
 * Google" CTA is rendered above the footer.
 */
export interface QuoteEmailOptions {
  logoSrc?: string
  reviews?: GoogleReviews | null
}

/** Customer contact card — shared shape with the confirmation email. */
export function customerCard(name: string, email: string, phone: string): string {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border-radius:10px;margin:0 0 22px;">
                <tr><td style="padding:20px 22px;">
                  <div style="font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:${TEXT};padding:0 0 14px;">Customer Contact</div>

                  <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">Name</div>
                  <div style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${TEXT};padding:2px 0 12px;border-bottom:1px solid ${LINE};margin-bottom:12px;">${esc(name) || '&mdash;'}</div>

                  <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">Email</div>
                  <div style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${RED};padding:2px 0 12px;border-bottom:1px solid ${LINE};margin-bottom:12px;">${esc(email) || '&mdash;'}</div>

                  <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};">Phone</div>
                  <div style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${RED};padding:2px 0 0;">${esc(phone) || '&mdash;'}</div>
                </td></tr>
              </table>`
}

/** Free-text notes block, or an em-dash when empty. */
export function notesBlock(notes?: string): string {
  return (notes ?? '').trim()
    ? `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:${TEXT};white-space:pre-wrap;">${esc(notes!.trim())}</div>`
    : `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:${MUTED};">&mdash;</div>`
}

export function buildQuoteEmailHtml(f: QuoteFields, opts: QuoteEmailOptions = {}): string {
  const { logoSrc, reviews } = opts

  const body = `
          <tr>
            <td style="padding:28px 32px 8px;">

              ${sectionHeading('Route Details')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                ${pairRow('From ZIP', esc(f.fromZip), 'To ZIP', esc(f.toZip))}
                <tr><td colspan="2" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
                ${pairRow('Ship Date', formatDate(f.shipDate), 'Transport Type', esc(f.transportType))}
              </table>

              ${sectionHeading('Vehicle Information')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                ${pairRow('Vehicle Type', esc(f.vehicleType), 'Year', esc(f.year))}
                <tr><td colspan="2" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
                ${pairRow('Make', esc(f.make), 'Model', esc(f.model))}
              </table>
${customerCard(f.customerName, f.customerEmail, f.customerPhone)}

              ${sectionHeading('Additional Notes')}
              <div style="padding:0 0 8px;">${notesBlock(f.notes)}</div>

            </td>
          </tr>`

  const rows = [
    headerRow({
      logoSrc,
      title: 'Your Vehicle Transport Quote',
      subtitle: 'Here&rsquo;s your personalized quote from Best Care Auto Transport',
    }),
    amountBandRow('Estimated Quote', formatMoney(f.estimatedQuote)),
    body,
    reviewsRow(reviews),
    contactFooterRow('This quote was prepared for you by <strong style="color:#ffffff;">Best Care Auto Transport</strong>.'),
  ].join('\n')

  return renderEmailDocument('Your Vehicle Transport Quote', rows)
}

/** Default subject line for a quote email. */
export function buildQuoteSubject(f: QuoteFields): string {
  const veh = [f.year, f.make, f.model].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ')
  return veh
    ? `Your Best Care Auto Transport quote — ${veh}`
    : 'Your Vehicle Transport Quote — Best Care Auto Transport'
}
