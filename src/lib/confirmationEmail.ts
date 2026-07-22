/**
 * Builder for the Best Care Auto Transport BOOKING CONFIRMATION email.
 *
 * Deliberately generic: the confirmation states only the essentials — estimated
 * pickup/delivery dates, the from/to ZIPs, open vs. enclosed transport, and the
 * confirmed rate — plus what happens next. Uses the same chrome as the quote email.
 *
 * The SAME function produces the on-screen preview and the HTML sent via SES.
 */
import {
  TEXT, CARD, RED,
  esc, formatMoney, formatDate, pairRow, sectionHeading,
  headerRow, amountBandRow, reviewsRow, contactFooterRow, renderEmailDocument,
  type GoogleReviews,
} from './emailChrome'

export interface ConfirmationFields {
  /** Agreed transport cost, e.g. "1088". Rendered with a leading $. */
  totalCost: string
  fromZip: string
  toZip: string
  /** ISO date (yyyy-mm-dd) or any human string. */
  pickupDate: string
  /** ISO date (yyyy-mm-dd) or any human string. */
  deliveryDate: string
  /** 'Open Transport' | 'Enclosed Transport'. */
  transportType: string
}

export interface ConfirmationEmailOptions {
  logoSrc?: string
  reviews?: GoogleReviews | null
}

/** The two commitments Ruben asked to state on every confirmation. */
const NEXT_STEPS: string[] = [
  'Your driver will contact you prior to the pickup date to arrange a delivery time.',
  'Best Care Auto Transport will invoice you following delivery.',
]

/** Numbered "what happens next" card. */
function nextStepsCard(): string {
  const rows = NEXT_STEPS.map((s, i) => `
                  <tr>
                    <td width="26" style="vertical-align:top;padding:0 10px 0 0;">
                      <div style="width:22px;height:22px;border-radius:11px;background:${RED};color:#ffffff;font:700 12px/22px Arial,Helvetica,sans-serif;text-align:center;">${i + 1}</div>
                    </td>
                    <td style="vertical-align:top;">
                      <div style="font:400 14px/1.55 Arial,Helvetica,sans-serif;color:${TEXT};padding-bottom:${i === NEXT_STEPS.length - 1 ? 0 : 14}px;">${s}</div>
                    </td>
                  </tr>`).join('')

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border-radius:10px;margin:0 0 22px;">
                <tr><td style="padding:20px 22px;">
                  <div style="font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:${TEXT};padding:0 0 14px;">What Happens Next</div>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
                  </table>
                </td></tr>
              </table>`
}

export function buildConfirmationEmailHtml(f: ConfirmationFields, opts: ConfirmationEmailOptions = {}): string {
  const { logoSrc, reviews } = opts

  const body = `
          <tr>
            <td style="padding:28px 32px 8px;">

              ${sectionHeading('Estimated Schedule')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                ${pairRow('Estimated Pickup Date', formatDate(f.pickupDate), 'Estimated Delivery Date', formatDate(f.deliveryDate))}
              </table>

              ${sectionHeading('Route Details')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                ${pairRow('From ZIP', esc(f.fromZip), 'To ZIP', esc(f.toZip))}
                <tr><td colspan="2" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
                ${pairRow('Transport Type', esc(f.transportType), '', '')}
              </table>
${nextStepsCard()}

            </td>
          </tr>`

  const rows = [
    headerRow({
      logoSrc,
      title: 'Your Transport Is Confirmed',
      subtitle: 'Thanks for booking with Best Care Auto Transport &mdash; here are your details',
    }),
    amountBandRow('Confirmed Rate', formatMoney(f.totalCost) || '&mdash;'),
    body,
    reviewsRow(reviews),
    contactFooterRow('This confirmation was prepared for you by <strong style="color:#ffffff;">Best Care Auto Transport</strong>.'),
  ].join('\n')

  return renderEmailDocument('Your Transport Is Confirmed', rows)
}

/** Default subject line for a confirmation email. */
export function buildConfirmationSubject(f: ConfirmationFields): string {
  const from = String(f.fromZip ?? '').trim()
  const to = String(f.toZip ?? '').trim()
  return from && to
    ? `Booking confirmed — ${from} → ${to} | Best Care Auto Transport`
    : 'Your Transport Is Confirmed — Best Care Auto Transport'
}
