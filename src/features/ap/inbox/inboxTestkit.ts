import type { ApInboxItemRecord } from '@/lib/apInbox/types'

/** One queued invoice e-mail, with a suggested match that is a low-confidence one by default. */
export function inboxItem(patch: Partial<ApInboxItemRecord> = {}): ApInboxItemRecord {
  return {
    id: 'apin:m1',
    messageId: 'm1',
    receivedAt: '2026-11-03T14:00:00.000Z',
    fromEmail: 'billing@blueline.example',
    fromName: 'Blue Line Billing',
    subject: 'Invoice 5521',
    kind: 'INVOICE',
    status: 'NEEDS_REVIEW',
    reviewReason: 'LOW_CONFIDENCE',
    extraction: {
      kind: 'INVOICE', confidence: 'high', reason: 'Carrier invoice for PRO 1234',
      issuer: { name: 'Blue Line Trucking', kind: 'CARRIER', mc: '123456', dot: null },
      pros: ['1234'], otherRefs: [], invoiceNumber: 'INV-5521', invoiceDate: '2026-11-01', dueDate: '2026-12-01',
      termsDays: 30, amountCents: 150_000, remitTo: { name: 'Blue Line Trucking', text: null }, notes: null, lowConfidence: [],
    },
    match: {
      top: {
        targetKind: 'CARRIER_BILL', targetId: 'b1', billId: 'b1', carrierName: 'Blue Line Trucking', shipmentNumber: 'S-100',
        status: 'IN_REVIEW', score: 0.7, signals: [{ key: 'PRO', points: 0.6, detail: '1234' }, { key: 'AMOUNT_EXACT', points: 0.1, detail: '' }], vetoes: [],
      },
      candidates: [], score: 0.7, signals: [{ key: 'PRO', points: 0.6, detail: '1234' }, { key: 'AMOUNT_EXACT', points: 0.1, detail: '' }], vetoes: [],
    },
    attachments: [{ key: 'intake-pdfs/ap-inbox/x/1-inv.pdf', name: 'inv.pdf', contentType: 'application/pdf', size: 20_000 }],
    sourceUrl: 'https://mail.google.com/mail/u/ai4bcat%40gmail.com/#all/m1',
    version: 1,
    ...patch,
  }
}
