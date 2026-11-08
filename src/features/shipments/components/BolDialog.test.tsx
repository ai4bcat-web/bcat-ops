// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BolDialog } from './BolDialog'
import type * as BolModel from '@/lib/bolModel'
import type { ShipmentBundle, ShipmentDocumentRecord } from '@/types/tms'

const saveGeneratedDocument = vi.hoisted(() => vi.fn())
const emailBol = vi.hoisted(() => vi.fn())
const getShipmentDocumentUrl = vi.hoisted(() => vi.fn())
const downloadPodAsPdf = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  saveGeneratedDocument,
  emailBol,
  getShipmentDocumentUrl,
  listDivisions: vi.fn(async () => []),
}))
vi.mock('@/lib/podDownload', () => ({ downloadPodAsPdf }))
vi.mock('@/lib/bolPdf', () => ({
  buildBolPdf: vi.fn(async () => ({
    output: (kind: string) => (kind === 'blob' ? new Blob(['pdf']) : 'data:application/pdf;base64,QUJD'),
  })),
}))
// The scope list, slot and filename are the real ones; only the model build is stubbed.
vi.mock('@/lib/bolModel', async (importActual) => ({
  ...(await importActual<typeof BolModel>()),
  buildBolModel: vi.fn(() => ({})),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const stop = (id: string, type: 'pickup' | 'delivery', extra: object = {}) =>
  ({ id, type, name: id, city: 'Dallas', ...extra })

function bundle(over: {
  stops: unknown[]
  documents?: ShipmentDocumentRecord[]
  updatedAt?: string
  status?: string
}): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: 'S1', status: over.status ?? 'READY', updatedAt: over.updatedAt ?? '2026-04-01T00:00:00.000Z' },
    loads: [{ id: 'load-1', stops: over.stops }],
    loadCarriers: [{ id: 'lc1', status: 'ACTIVE', carrierName: 'Swift', dispatcherEmail: 'disp@swift.com' }],
    orders: [{}],
    charges: [],
    financials: [],
    documents: over.documents ?? [],
  } as unknown as ShipmentBundle
}

const ONE_DELIVERY = [stop('p1', 'pickup', { documentContact: { email: 'ship@acme.com' } }), stop('d1', 'delivery')]
const TWO_DELIVERIES = [...ONE_DELIVERY, stop('d2', 'delivery')]

const storedDoc = { id: 'doc-1', s3Key: 'shipment-docs/shp-1/doc-1-bol.pdf', name: 'bol-S1-v1.pdf' }

function renderDialog(b: ShipmentBundle, onSaved = vi.fn()) {
  render(<BolDialog bundle={b} customer={null} locations={[]} settings={null} onClose={vi.fn()} onSaved={onSaved} />)
  return onSaved
}

async function generate() {
  const button = await screen.findByTestId('bol-generate')
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(saveGeneratedDocument).toHaveBeenCalled())
}

const disabled = (id: string) => (screen.getByTestId(id) as HTMLButtonElement).disabled

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  saveGeneratedDocument.mockResolvedValue({ document: storedDoc, bundle: {} })
  emailBol.mockResolvedValue({ message: {}, emailStatus: 'SENT', emailError: null })
  getShipmentDocumentUrl.mockResolvedValue('https://example.com/bol.pdf')
})

describe('BolDialog', () => {
  it('offers a scope choice only when there are two deliveries', async () => {
    renderDialog(bundle({ stops: ONE_DELIVERY }))
    await screen.findByTestId('bol-generate')
    expect(screen.queryByTestId('bol-scope')).toBeNull()

    cleanup()
    renderDialog(bundle({ stops: TWO_DELIVERIES }))
    const scope = await screen.findByTestId('bol-scope')
    expect(within(scope).getAllByRole('option')).toHaveLength(3)
  })

  it('generates the master slot, then enables Download and E-mail; changing an option turns them off again', async () => {
    const onSaved = renderDialog(bundle({ stops: TWO_DELIVERIES }))
    expect(disabled('bol-download')).toBe(true)
    expect(disabled('bol-email-toggle')).toBe(true)

    await generate()
    expect(saveGeneratedDocument).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'shp-1', type: 'BOL', loadId: null, stopId: null, loadCarrierId: null, rated: false, pdfBase64: 'QUJD',
    }))
    await waitFor(() => expect(disabled('bol-download')).toBe(false))
    expect(disabled('bol-email-toggle')).toBe(false)
    expect(onSaved).toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('bol-language'), { target: { value: 'EN_ES' } })
    expect(disabled('bol-download')).toBe(true)
    expect(disabled('bol-email-toggle')).toBe(true)
  })

  it('sends the delivery stop slot for a per-stop BOL', async () => {
    renderDialog(bundle({ stops: TWO_DELIVERIES }))
    fireEvent.change(await screen.findByTestId('bol-scope'), { target: { value: 'STOP:d2' } })
    await generate()
    expect(saveGeneratedDocument).toHaveBeenCalledWith(expect.objectContaining({
      stopId: 'd2', rated: false, referenceSuffix: 'd2',
    }))
  })

  it('stores a rated copy as its own slot, states the consequence and offers no e-mail for it', async () => {
    renderDialog(bundle({ stops: ONE_DELIVERY }))
    fireEvent.change(await screen.findByTestId('bol-include-rates'), { target: { value: 'YES' } })
    expect(screen.getByTestId('bol-rates-note').textContent).toMatch(/cannot be e-mailed/i)
    await generate()
    expect(saveGeneratedDocument).toHaveBeenCalledWith(expect.objectContaining({ rated: true, referenceSuffix: 'rated' }))
    await waitFor(() => expect(disabled('bol-download')).toBe(false))
    expect(disabled('bol-email-toggle')).toBe(true)
    expect(screen.queryByTestId('bol-email-panel')).toBeNull()
    expect(screen.getByTestId('bol-customer-copy-note')).toBeTruthy()
  })

  it('downloads the stored file, not the preview', async () => {
    renderDialog(bundle({ stops: ONE_DELIVERY }))
    await generate()
    await waitFor(() => expect(disabled('bol-download')).toBe(false))
    fireEvent.click(screen.getByTestId('bol-download'))
    await waitFor(() => expect(downloadPodAsPdf).toHaveBeenCalledWith('https://example.com/bol.pdf', 'bol-S1-v1.pdf'))
    expect(getShipmentDocumentUrl).toHaveBeenCalledWith(storedDoc.s3Key)
  })

  describe('e-mail', () => {
    const openPanel = async () => {
      await generate()
      await waitFor(() => expect(disabled('bol-email-toggle')).toBe(false))
      fireEvent.click(screen.getByTestId('bol-email-toggle'))
      return screen.findByTestId('bol-email-panel')
    }

    it('preselects nobody, offers stop and dispatcher addresses, and mails only the picked one', async () => {
      renderDialog(bundle({ stops: ONE_DELIVERY }))
      const panel = await openPanel()
      const boxes = within(panel).getAllByRole('checkbox') as HTMLInputElement[]
      expect(boxes).toHaveLength(2)
      expect(boxes.every((b) => !b.checked)).toBe(true)
      expect(within(panel).getByText('ship@acme.com')).toBeTruthy()
      expect(within(panel).getByText('disp@swift.com')).toBeTruthy()

      fireEvent.click(boxes[1])
      fireEvent.click(screen.getByTestId('bol-email-send'))
      await waitFor(() => expect(emailBol).toHaveBeenCalledTimes(1))
      expect(emailBol).toHaveBeenCalledWith({
        shipmentId: 'shp-1', documentId: 'doc-1', to: ['disp@swift.com'], message: null, party: 'DISPATCHER',
      })
    })

    it('refuses to send with nobody picked or with a malformed typed address', async () => {
      renderDialog(bundle({ stops: ONE_DELIVERY }))
      await openPanel()
      fireEvent.click(screen.getByTestId('bol-email-send'))
      expect((await screen.findByTestId('bol-email-error')).textContent).toMatch(/at least one/i)

      fireEvent.change(screen.getByLabelText('Add another address'), { target: { value: 'not an address' } })
      fireEvent.click(screen.getByTestId('bol-email-send'))
      await waitFor(() => expect(screen.getByTestId('bol-email-error').textContent).toMatch(/not a valid/i))
      expect(emailBol).not.toHaveBeenCalled()
    })

    it('shows the reason when the mail is not sent', async () => {
      emailBol.mockResolvedValue({ message: {}, emailStatus: 'NOT_SENT', emailError: 'Sandbox denied', downloadUrl: 'u' })
      renderDialog(bundle({ stops: ONE_DELIVERY }))
      const panel = await openPanel()
      fireEvent.click(within(panel).getAllByRole('checkbox')[0])
      fireEvent.click(screen.getByTestId('bol-email-send'))
      expect((await screen.findByTestId('bol-email-error')).textContent).toBe('Sandbox denied')
    })
  })

  it('flags a stored BOL that predates the last shipment edit, only for the slot on screen', async () => {
    const doc = (over: Partial<ShipmentDocumentRecord>) => ({
      id: 'old', type: 'BOL', status: 'ACTIVE', audience: 'ALL', version: 2, stopId: null, loadCarrierId: null,
      uploadedAt: '2026-04-01T00:00:00.000Z', ...over,
    }) as ShipmentDocumentRecord
    renderDialog(bundle({
      stops: ONE_DELIVERY,
      updatedAt: '2026-04-02T00:00:00.000Z',
      documents: [doc({}), doc({ id: 'rated', audience: 'CUSTOMER', uploadedAt: '2026-04-05T00:00:00.000Z' })],
    }))
    expect((await screen.findByTestId('bol-stale-chip')).textContent).toContain('v2')

    // The customer copy is a different slot and is current, so it raises nothing.
    fireEvent.change(screen.getByTestId('bol-include-rates'), { target: { value: 'YES' } })
    await waitFor(() => expect(screen.queryByTestId('bol-stale-chip')).toBeNull())
  })

  it('does not flag a BOL saved after the last edit', async () => {
    renderDialog(bundle({
      stops: ONE_DELIVERY,
      documents: [{
        id: 'fresh', type: 'BOL', status: 'ACTIVE', audience: 'ALL', version: 1, uploadedAt: '2026-04-03T00:00:00.000Z',
      } as ShipmentDocumentRecord],
    }))
    await screen.findByTestId('bol-generate')
    expect(screen.queryByTestId('bol-stale-chip')).toBeNull()
  })

  it('warns while the shipment is still a draft', async () => {
    renderDialog(bundle({ stops: ONE_DELIVERY, status: 'DRAFT' }))
    expect(await screen.findByTestId('bol-draft-banner')).toBeTruthy()
  })
})
