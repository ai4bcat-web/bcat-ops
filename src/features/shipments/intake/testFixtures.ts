import type { IntakeFields, IntakeLoadRecord, IntakeMeta } from '@/types/intake'

export function intakeFields(over: Partial<IntakeFields> = {}): IntakeFields {
  return {
    customerId: 'c1', customerName: 'Acme Foods', billToId: null, salesRepId: 'rep1', divisionCode: 'BRK',
    reference: 'PO-100', pickupNumber: null, deliveryNumber: null, equipmentType: 'Dry van', commodity: null,
    weightLb: 20000, customerRateCents: null,
    stops: [
      { type: 'pickup', name: null, street: null, city: 'Dallas', state: 'TX', zip: null, date: '2026-11-10', time: null, instructions: null },
      { type: 'delivery', name: null, street: null, city: 'Atlanta', state: 'GA', zip: null, date: '2026-11-12', time: null, instructions: null },
    ],
    ...over,
  }
}

export function intakeRow(over: Partial<IntakeLoadRecord> = {}): IntakeLoadRecord {
  const meta: IntakeMeta = {
    customerId: { source: 'DIRECTORY', confidence: 'high' },
    salesRepId: { source: 'DEFAULT', confidence: 'high' },
    divisionCode: { source: 'ADDRESS', confidence: 'high' },
    reference: { source: 'PARSER', confidence: 'high' },
    equipmentType: { source: 'PARSER', confidence: 'high' },
    weightLb: { source: 'MODEL', confidence: 'low' },
    'stops.0.city': { source: 'PARSER', confidence: 'high' },
    'stops.0.state': { source: 'PARSER', confidence: 'high' },
    'stops.0.date': { source: 'PARSER', confidence: 'high' },
    'stops.1.city': { source: 'PARSER', confidence: 'high' },
    'stops.1.state': { source: 'PARSER', confidence: 'high' },
    'stops.1.date': { source: 'PARSER', confidence: 'high' },
  }
  const fields = intakeFields()
  return {
    id: 'il:run-1', status: 'OPEN', divisionCode: 'BRK', toAddress: 'tenders-brk@example.invalid', toAddresses: [],
    runId: 'run-1', sourceKey: null, subject: 'Tender PO-100 Dallas to Atlanta', fromEmail: 'ship@acme.example',
    fromName: 'Acme Dispatch', receivedAt: '2026-11-03T15:00:00.000Z', bodyText: 'Please cover PO-100.',
    attachments: [], parseState: 'PARSED', parseNote: null, format: 'SUBJECT',
    fields, autoFields: fields, meta, confirmed: [], missingFields: ['billTo'],
    shipmentId: null, shipmentNumber: null, reviewedBy: null, reviewedAt: null,
    lastEditedBy: null, lastEditedAt: null, dismissedBy: null, dismissedAt: null, dismissReason: null,
    createdBy: 'agent', updatedBy: 'agent', version: 1, createdAt: '2026-11-03T15:00:00.000Z', updatedAt: '2026-11-03T15:00:00.000Z',
    ...over,
  }
}
