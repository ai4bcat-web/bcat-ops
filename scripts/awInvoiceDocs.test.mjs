import { describe, expect, it } from 'vitest';
import { applyOne, buildReport, documentRowFor, invoiceDocsGate, planInvoiceDocs } from './awInvoiceDocs.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { DEV_SUFFIX } from './lib/prodGate.mjs';

const inv = (o = {}) => ({ id: 'i1', number: 'INV-000001', status: 'ISSUED', shipmentId: 's1', orderId: 'o1', pdfKey: 'invoices/c1/INV-000001-v1.pdf', pdfSizeBytes: 1234, issuedAt: '2026-11-01T12:00:00.000Z', ...o });

describe('planInvoiceDocs', () => {
  it('lists only live invoices with a PDF that have no inv:<id> row', () => {
    const p = planInvoiceDocs(
      [inv(), inv({ id: 'i2' }), inv({ id: 'i3', status: 'VOID' }), inv({ id: 'i4', pdfKey: null }), inv({ id: 'i5', shipmentId: null })],
      [{ id: 'inv:i2' }, { id: 'doc-9' }],
    );
    expect(p.missing.map((i) => i.id)).toEqual(['i1']);
    expect(p).toMatchObject({ total: 5, alreadyFiled: 1, void: 1, noPdf: 1, noShipment: 1 });
  });
});

describe('documentRowFor', () => {
  it('is the row ATTACH_INVOICE_DOC writes: id inv:<id>, INVOICE, customer audience, generated', () => {
    const row = documentRowFor(inv());
    expect(row).toMatchObject({ id: 'inv:i1', type: 'INVOICE', audience: 'CUSTOMER', source: 'GENERATED', sourceRef: 'i1', status: 'ACTIVE', name: 'Invoice INV-000001.pdf', s3Key: 'invoices/c1/INV-000001-v1.pdf', shipmentId: 's1', orderId: 'o1' });
  });
});

describe('applyOne', () => {
  it('puts the row only if it is not already there', async () => {
    const calls = [];
    const doc = { send: async (c) => { calls.push(c.input); return {}; } };
    const r = await applyOne({ doc, suffix: DEV_SUFFIX, invoice: inv() });
    expect(r).toEqual({ written: 1, lost: 0 });
    expect(calls[0].ConditionExpression).toBe('attribute_not_exists(id)');
    expect(calls[0].TableName).toBe(`ShipmentDocument-${DEV_SUFFIX}`);
  });
  it('counts a row that appeared meanwhile as lost, not an error', async () => {
    const doc = { send: async () => { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; } };
    expect(await applyOne({ doc, suffix: DEV_SUFFIX, invoice: inv() })).toEqual({ written: 0, lost: 1 });
  });
  it('is registered for backup and gated', () => {
    expect(PROD_WRITE_SETS.awInvoiceDocs.models).toEqual(['ShipmentDocument']);
    expect(resolveScripts('awInvoiceDocs')).toEqual(['awInvoiceDocs']);
    expect(typeof invoiceDocsGate).toBe('function');
  });
});

describe('buildReport', () => {
  it('states what would be filed', () => {
    const text = buildReport({ plan: planInvoiceDocs([inv()], []), today: '2026-11-12' });
    expect(text).toContain('WOULD FILE: 1');
    expect(text).toContain('INV-000001');
  });
});
