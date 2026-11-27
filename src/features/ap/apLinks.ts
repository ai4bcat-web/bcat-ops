/**
 * Deep links into Accounts Payable (Ryne 2026-11-27: "mark a carrier paid directly from the carrier unpaid tab ... it should take
 * you to the appropriate AP areas"). Carrier money is only ever paid in AP, so other pages link here and AP opens the right
 * dialog once its bills have loaded, then cleans the params so a reload does not reopen it.
 *
 *   `?payBill=<billId>`      the Pay dialog for one approved bill (the Approved or Selected tab, whichever it is on)
 *   `?openBill=<billId>`     that bill's drawer, for one still in review that has to be approved before it can be paid
 *   `?recordLeg=<legId>`     the Record bill dialog for a carrier leg that has no bill yet
 *   `?from=auto-shipper-loads` shows a Back link to the page that sent you
 */
export const AP_FROM_AUTO_SHIPPER = 'auto-shipper-loads'

const PAYABLE = '/tms/invoicing/payable'

const withFrom = (q: URLSearchParams, from: string | null | undefined): string => {
  if (from) q.set('from', from)
  return `${PAYABLE}?${q.toString()}`
}

export function payBillPath(billId: string, from?: string | null): string {
  return withFrom(new URLSearchParams({ payBill: billId }), from)
}

export function openBillPath(billId: string, from?: string | null): string {
  return withFrom(new URLSearchParams({ openBill: billId }), from)
}

export function recordLegBillPath(legId: string, from?: string | null): string {
  return withFrom(new URLSearchParams({ tab: 'expected', recordLeg: legId }), from)
}

export type ApIntent =
  | { kind: 'pay'; billId: string }
  | { kind: 'open'; billId: string }
  | { kind: 'record'; legId: string }

/** The one thing a link asked AP to open, or null. Pay wins over open, open over record. */
export function readApIntent(params: URLSearchParams): ApIntent | null {
  const pay = params.get('payBill')
  if (pay) return { kind: 'pay', billId: pay }
  const open = params.get('openBill')
  if (open) return { kind: 'open', billId: open }
  const leg = params.get('recordLeg')
  if (leg) return { kind: 'record', legId: leg }
  return null
}

/** The same params with the one-time ones removed (the Back link's `from` stays). */
export function clearApIntent(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('payBill')
  next.delete('openBill')
  next.delete('recordLeg')
  return next
}
