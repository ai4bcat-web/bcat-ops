// @vitest-environment jsdom
/**
 * What the dialog says happened to the e-mail.
 *
 * The banner is the only account of a send a person gets, so it may state nothing it
 * does not know. SES is denied on dev, but a refused address or an oversized attachment
 * comes back the same way on production: the dialog reports that nothing was sent and
 * quotes the server's own `emailError`, and never names a cause of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EmailInvoiceDialog } from './EmailInvoiceDialog'
import type { InvoiceRecord } from '@/types/tms'
import type { InvoiceEmailResult } from '@/lib/apiClient'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const { getInvoice, listCustomers, listDivisions, getTmsSettings, emailInvoice } = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  listCustomers: vi.fn(),
  listDivisions: vi.fn(),
  getTmsSettings: vi.fn(),
  emailInvoice: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({
  getInvoice,
  listCustomers,
  listDivisions,
  getTmsSettings,
  emailInvoice,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

const INVOICE: InvoiceRecord = {
  id: 'inv-1',
  number: 'INV-000001',
  orderId: 'ord-1',
  shipmentId: 'shp-1',
  customerId: 'cust-1',
  status: 'ISSUED',
  invoiceDate: '2026-01-10',
  issuedAt: '2026-01-10T12:00:00.000Z',
  issuedBy: 'ar@bcat.test',
  dueAt: '2026-02-09',
  termsDays: 30,
  invoiceMonth: '2026-01',
  subtotalCents: 100_000,
  totalCents: 100_000,
  paidCents: 0,
  writtenOffCents: 0,
  balanceCents: 100_000,
  arOpen: 'OPEN',
  createdBy: 'ar@bcat.test',
  updatedBy: 'ar@bcat.test',
  version: 1,
}

/** A real SES refusal: the address is rejected, which has nothing to do with dev. */
const REFUSED: InvoiceEmailResult = {
  notice: { id: 'ntc-1' } as InvoiceEmailResult['notice'],
  emailStatus: 'NOT_SENT',
  emailError: 'Email address is not verified: billing@acme.test',
  subject: 'Invoice INV-000001 · BCAT',
  body: 'Hello,\n\nInvoice INV-000001 is attached.',
  to: ['billing@acme.test'],
  cc: [],
  downloads: [{ name: 'INV-000001.pdf', url: 'https://example.test/INV-000001.pdf' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  getInvoice.mockResolvedValue(INVOICE)
  listCustomers.mockResolvedValue([])
  listDivisions.mockResolvedValue([])
  getTmsSettings.mockResolvedValue(null)
  emailInvoice.mockResolvedValue(REFUSED)
})

function renderDialog() {
  return render(<EmailInvoiceDialog invoiceId="inv-1" onClose={vi.fn()} onDone={vi.fn()} />)
}

describe('EmailInvoiceDialog', () => {
  it('reports that nothing was sent and quotes the mail service, naming no cause of its own', async () => {
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(screen.getByText(/Nothing was sent\./)).toBeTruthy())
    expect(screen.getByText(/Email address is not verified: billing@acme\.test/)).toBeTruthy()
    expect(screen.queryByText(/SES/)).toBeNull()
    expect(screen.queryByText(/on dev/)).toBeNull()
  })

  it('still hands over the body to copy and the attachments to download', async () => {
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(screen.getByLabelText('Copy e-mail body')).toBeTruthy())
    expect(screen.getByLabelText('Copy e-mail subject')).toBeTruthy()
    const link = screen.getByLabelText('Download INV-000001.pdf') as HTMLAnchorElement
    expect(link.href).toBe('https://example.test/INV-000001.pdf')
  })
})
