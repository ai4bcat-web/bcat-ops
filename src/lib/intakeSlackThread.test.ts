import { describe, expect, it } from 'vitest'
import {
  documentEvents,
  findThreadMessage,
  intakeLoadEvents,
  invoiceEvents,
  personName,
  shipmentEvents,
  threadMessage,
  type IntakeThreadEvent,
} from './intakeSlackThread'

const at = '2026-11-12T21:38:48.000Z'
const sec = Date.parse(at) / 1000

describe('intakeLoadEvents', () => {
  it('posts a duplicate notice when a new row already matches a built PRO', () => {
    const e = intakeLoadEvents(null, { id: 'il:1', status: 'OPEN', alreadyBuilt: JSON.stringify([{ shipmentId: 's1', number: '20027', customerName: 'Royal', value: '4828693' }]) })
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ kind: 'duplicate', key: 'duplicate', intakeId: 'il:1', data: { pros: '20027', ref: '4828693', customer: 'Royal' } })
  })

  it('a new row with no match posts nothing', () => {
    expect(intakeLoadEvents(null, { id: 'il:1', status: 'OPEN' })).toEqual([])
  })

  it('posts "created" once, when the row becomes MOVED', () => {
    const e = intakeLoadEvents({ id: 'il:1', status: 'PROMOTING' }, { id: 'il:1', status: 'MOVED', shipmentId: 's9', shipmentNumber: '20101', updatedBy: 'ruben@bcatcorp.com' })
    expect(e).toEqual([expect.objectContaining({ kind: 'created', shipmentId: 's9', data: { pro: '20101', by: 'ruben@bcatcorp.com' } })])
    expect(intakeLoadEvents({ id: 'il:1', status: 'MOVED', shipmentId: 's9' }, { id: 'il:1', status: 'MOVED', shipmentId: 's9', slackThreadTs: '1.2' })).toEqual([])
  })

  it('dismissal by a person posts; delete reads as deleted; a sweep script does not post', () => {
    const del = intakeLoadEvents({ id: 'il:1', status: 'OPEN' }, { id: 'il:1', status: 'DISMISSED', dismissedBy: 'ryne@bcatcorp.com', dismissedAt: 't', dismissReason: 'Deleted by admin: dup of 20027' })
    expect(del[0]).toMatchObject({ kind: 'dismissed', data: { by: 'ryne@bcatcorp.com', note: 'dup of 20027', deleted: 'yes' } })
    const dis = intakeLoadEvents({ id: 'il:1', status: 'OPEN' }, { id: 'il:1', status: 'DISMISSED', dismissedBy: 'jenny@bcatcorp.com', dismissedAt: 't', dismissReason: 'spam' })
    expect(dis[0]).toMatchObject({ data: { note: 'spam', deleted: null } })
    expect(intakeLoadEvents({ id: 'il:1', status: 'OPEN' }, { id: 'il:1', status: 'DISMISSED', dismissedBy: 'awIntakeSweep', dismissReason: 'old' })).toEqual([])
  })
})

describe('shipmentEvents', () => {
  const base = { id: 's1', intakeLoadId: 'il:1', number: '20101' }
  it('ignores shipments that did not come from intake', () => {
    expect(shipmentEvents({ id: 's1', status: 'OPEN' }, { id: 's1', status: 'DELIVERED' })).toEqual([])
  })
  it('booked → carrierBooked; picked up → pickedUp (+carrier offered again); delivered → delivered', () => {
    expect(shipmentEvents({ ...base, status: 'OPEN' }, { ...base, status: 'BOOKED' }).map((e) => e.kind)).toEqual(['carrierBooked'])
    expect(shipmentEvents({ ...base, status: 'DISPATCHED' }, { ...base, status: 'PICKED_UP' }).map((e) => e.kind)).toEqual(['carrierBooked', 'pickedUp'])
    expect(shipmentEvents({ ...base, status: 'IN_TRANSIT' }, { ...base, status: 'DELIVERED' }).map((e) => e.kind)).toEqual(['carrierBooked', 'delivered'])
  })
  it('a plain edit posts nothing; canceled posts nothing; voided posts nothing', () => {
    expect(shipmentEvents({ ...base, status: 'BOOKED' }, { ...base, status: 'BOOKED', pickupAppt: 'x' })).toEqual([])
    expect(shipmentEvents({ ...base, status: 'BOOKED' }, { ...base, status: 'CANCELED' })).toEqual([])
    expect(shipmentEvents({ ...base, status: 'OPEN' }, { ...base, status: 'BOOKED', voidedAt: 'x' })).toEqual([])
  })
  it('the carrier ladder starting on an open shipment counts as booked', () => {
    expect(shipmentEvents({ ...base, status: 'OPEN' }, { ...base, status: 'OPEN', carrierAssignmentStatus: 'ASSIGNED_SETUP_PENDING' }).map((e) => e.kind)).toEqual(['carrierBooked'])
  })
})

describe('documentEvents / invoiceEvents', () => {
  it('a new active POD posts; other docs and voids do not', () => {
    expect(documentEvents(null, { id: 'd1', type: 'POD', status: 'ACTIVE', shipmentId: 's1' }).map((e) => e.kind)).toEqual(['podReceived'])
    expect(documentEvents(null, { id: 'd1', type: 'BOL', shipmentId: 's1' })).toEqual([])
    expect(documentEvents({ type: 'POD', status: 'ACTIVE' }, { type: 'POD', status: 'VOID', shipmentId: 's1' })).toEqual([])
  })
  it('a new invoice is "released"; each send is its own line; void posts nothing', () => {
    const inv = { id: '20101', number: '20101', shipmentId: 's1', shipmentNumber: '20101', status: 'ISSUED', totalCents: 175000 }
    expect(invoiceEvents(null, inv).map((e) => e.kind)).toEqual(['releasedToBilling'])
    const sent = invoiceEvents(inv, { ...inv, sentAt: 't', sentCount: 1 })
    expect(sent).toEqual([expect.objectContaining({ kind: 'invoiceSent', key: 'invoiceSent:20101:1' })])
    expect(invoiceEvents({ ...inv, sentAt: 't', sentCount: 1 }, { ...inv, sentAt: 't2', sentCount: 2 })[0]).toMatchObject({ key: 'invoiceSent:20101:2', data: { resend: 'yes' } })
    expect(invoiceEvents(inv, { ...inv, markedSentAt: 't' }).map((e) => e.kind)).toEqual(['invoiceSent'])
    expect(invoiceEvents(null, { ...inv, status: 'VOID' })).toEqual([])
  })
})

describe('findThreadMessage', () => {
  const msg = (ts: string, subject: string, stamp: number, from = 'ruben@bcatcorp.com') => ({
    ts, files: [{ filetype: 'email', subject, timestamp: stamp, from: [{ address: from }] }],
  })
  it('matches the e-mail by its Date and subject', () => {
    const m = findThreadMessage([
      msg('1.1', 'Fwd: TQL PO 1', sec - 600),
      msg('2.2', 'Fwd: Landstar Load Tender 4828693 (Freight Bill Number)', sec),
    ], { subject: 'Fwd: Landstar Load Tender 4828693 (Freight Bill Number)', fromEmail: 'ruben@bcatcorp.com', receivedAt: at })
    expect(m?.ts).toBe('2.2')
  })
  it('does not match a different subject or a far-off time, nor a thread reply', () => {
    expect(findThreadMessage([msg('2.2', 'Other', sec)], { subject: 'Fwd: Landstar', receivedAt: at })).toBeNull()
    expect(findThreadMessage([msg('2.2', 'Fwd: Landstar', sec - 3600)], { subject: 'Fwd: Landstar', receivedAt: at })).toBeNull()
    expect(findThreadMessage([{ ...msg('2.3', 'Fwd: Landstar', sec), thread_ts: '2.2' }], { subject: 'Fwd: Landstar', receivedAt: at })).toBeNull()
  })
  it('prefers the copy from the same sender', () => {
    const m = findThreadMessage([msg('1.1', 'RE: Truck Request', sec, 'bcatloads@bcatcorp.com'), msg('2.2', 'RE: Truck Request', sec + 5, 'katelynn@iff.com')],
      { subject: 'RE: Truck Request', fromEmail: 'KATELYNN@iff.com', receivedAt: at })
    expect(m?.ts).toBe('2.2')
  })
})

describe('threadMessage', () => {
  const ev = (kind: IntakeThreadEvent['kind'], data: Record<string, string | null> = {}): IntakeThreadEvent => ({ kind, key: kind, intakeId: 'il:1', shipmentId: 's1', data })
  it('"Shipment created" names the PRO, the person and links the shipment', () => {
    expect(threadMessage(ev('created', { by: 'ruben@bcatcorp.com' }), { pro: '20101', shipmentUrl: 'https://ops.bcatcorp.com/tms/shipments/s1' }))
      .toBe(':white_check_mark: Shipment created: PRO *20101* by Ruben · <https://ops.bcatcorp.com/tms/shipments/s1|Open in BCAT Ops>')
  })
  it('carrier line needs a carrier name and never carries money', () => {
    expect(threadMessage(ev('carrierBooked'), { pro: '20101', shipmentUrl: null, carrierName: null })).toBeNull()
    const t = threadMessage(ev('carrierBooked'), { pro: '20101', shipmentUrl: null, carrierName: 'Fast <Freight> LLC' })
    expect(t).toBe(':truck: Carrier booked on PRO *20101*: Fast &lt;Freight&gt; LLC')
  })
  it('invoice line names the invoice number only', () => {
    const t = threadMessage(ev('invoiceSent', { invoice: '20101', pro: '20101' }), { pro: '20101', shipmentUrl: null })
    expect(t).toBe(':outbox_tray: Invoice *20101* sent for PRO *20101*')
    expect(t).not.toMatch(/\$|\d+\.\d\d/)
  })
  it('personName', () => {
    expect(personName('dennis.k@bcatcorp.com')).toBe('Dennis K')
    expect(personName(null)).toBe('Someone')
  })
})
