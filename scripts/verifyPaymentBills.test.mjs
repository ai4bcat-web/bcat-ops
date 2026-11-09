import { describe, expect, it } from 'vitest';
import { checkFor, excelSerialToIso, parseNotPaid } from './verifyPaymentBills.mjs';

describe('verifyPaymentBills', () => {
  it('converts an Excel serial to the calendar date', () => {
    expect(excelSerialToIso('46316')).toBe('2026-10-21');
    expect(excelSerialToIso('')).toBe('');
  });

  it('reads the Aljex sheet columns by header, whatever their order', () => {
    const rows = [['Vendor', 'Pro #', 'Amount', 'Pay To', 'DueDate'], ['ACME', ' 14391 ', '1500', 'ACME FACTOR', '46316'], ['', '', '', '', '']];
    expect(parseNotPaid(rows)).toEqual([{ pro: '14391', carrier: 'ACME', payTo: 'ACME FACTOR', amountCents: 150000, dueDate: '2026-10-21' }]);
  });

  it('tells the verifier what to look at from the BCAT side', () => {
    expect(checkFor([])).toMatch(/NO BCAT BILL/);
    expect(checkFor([{ status: 'VOID' }])).toMatch(/VOID/);
    expect(checkFor([{ status: 'PAID' }])).toMatch(/PAID but Ryne has not paid/);
    expect(checkFor([{ status: 'PARTIAL' }])).toMatch(/PARTIAL/);
  });
});
