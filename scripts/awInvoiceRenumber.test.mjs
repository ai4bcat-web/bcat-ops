import { describe, it, expect } from 'vitest';
import { planRenumber } from './awInvoiceRenumber.mjs';

const inv = (over) => ({ id: 'INV-000001', number: 'INV-000001', shipmentNumber: '20027', shipmentId: 's1', orderId: 'o1', status: 'ISSUED', paidCents: 0, writtenOffCents: 0, sentCount: 0, ...over });

describe('planRenumber', () => {
  it('renumbers an unsent counter invoice to its PRO, suffixing when the PRO is taken', () => {
    const plan = planRenumber({
      invoices: [inv(), inv({ id: 'INV-000002', number: 'INV-000002', shipmentNumber: '14000', shipmentId: 's2', orderId: 'o2' }), { id: '14000' }],
      orders: [{ id: 'o1', shipmentId: 's1' }, { id: 'o2', shipmentId: 's2' }],
      payments: [], commissions: [], factoring: [],
    });
    expect(plan.map((r) => [r.invoice.id, r.status, r.target])).toEqual([['INV-000001', 'READY', '20027'], ['INV-000002', 'READY', '14000-2']]);
  });

  it('refuses a sent, paid or OTR-submitted invoice and leaves PRO-numbered ones alone', () => {
    const plan = planRenumber({
      invoices: [inv({ sentCount: 1 }), { id: '20030', number: '20030' }],
      orders: [{ id: 'o1', shipmentId: 's1' }], payments: [], commissions: [], factoring: [],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].status).toBe('REFUSED');
    expect(plan[0].why).toContain('already sent to the customer');
  });
});
