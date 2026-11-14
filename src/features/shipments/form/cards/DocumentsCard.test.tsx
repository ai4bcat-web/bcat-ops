// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DocumentsCard } from './DocumentsCard'
import { releaseDocItems } from './releaseDocs'
import { emptyValues, NO_LOCKS, type QueuedFile } from '../model'
import type { FormCtx } from '../sectionProps'
import { makeCtx, makeForm, savedBundle } from '../sections/ah5TestKit'
import type { CustomerRecord, TmsSettings } from '@/types/tms'

const api = vi.hoisted(() => ({
  getShipmentDocumentUrl: vi.fn(async () => 'https://example.invalid/doc'),
  getIntakeLoad: vi.fn(async () => ({ id: 'il:9', attachments: [{ key: 'k', name: 'ratecon.pdf', contentType: 'application/pdf', size: 5 }] })),
  attachIntakeFiles: vi.fn(async () => ({ attached: 1, available: 1 })),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/features/shipments/components/BolDialog', () => ({ BolDialog: () => null }))

const doc = (id: string, name: string, audience: string, type = 'OTHER', status = 'ACTIVE') => ({
  id, name, audience, status, type, s3Key: `k/${id}`, uploadedBy: 'ann@example.invalid', uploadedAt: '2026-01-02T15:00:00.000Z',
})
const pdf = (name = 'a.pdf', type = 'application/pdf') => new File(['x'], name, { type })

function setup(ctxOver: Partial<FormCtx> = {}, queued: QueuedFile[] = []) {
  const ctx = makeCtx(ctxOver)
  const values = { ...emptyValues(), docs: { queued } }
  render(<DocumentsCard values={values} update={vi.fn()} form={makeForm(values)} ctx={ctx} issues={[]} mode={ctx.mode} locked={NO_LOCKS} />)
  return ctx
}
const pick = (...files: File[]) => fireEvent.change(screen.getByLabelText('Upload'), { target: { files } })

describe('DocumentsCard', () => {
  const bundle = savedBundle({
    documents: [
      doc('1', 'customer-bol.pdf', 'CUSTOMER', 'BOL'), doc('2', 'carrier-rc.pdf', 'CARRIER', 'RATE_CON'), doc('3', 'all.pdf', 'ALL'),
      doc('4', 'internal.pdf', 'INTERNAL'), doc('5', 'voided.pdf', 'ALL', 'OTHER', 'VOID'),
    ],
  })

  it('Other documents: Public lists CUSTOMER, CARRIER and ALL; Private lists INTERNAL; voided rows and the POD / rate con never show there', () => {
    setup({ mode: 'edit', bundle })
    const names = () => screen.getAllByTestId('card-documents-row').map((r) => r.children[0].textContent)
    expect(names()).toEqual(['customer-bol.pdf', 'all.pdf'])
    // The carrier rate con lives in its own box.
    expect(within(screen.getByTestId('card-documents-slot-RATE_CON')).getByText('carrier-rc.pdf')).toBeTruthy()
    expect(within(screen.getAllByTestId('card-documents-row')[0]).getByText(/ann@example.invalid/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Private' }))
    expect(names()).toEqual(['internal.pdf'])
  })

  it('the POD and Rate confirmation slots show what is on file and where it came from, or offer an upload', () => {
    const rc = { ...doc('9', 'Signed Rate Confirmation v1.pdf', 'ALL', 'RATE_CON'), uploadedBy: 'link:abcd1234', source: 'GENERATED' }
    setup({ mode: 'edit', bundle: savedBundle({ documents: [rc] }) })
    const rcSlot = screen.getByTestId('card-documents-slot-RATE_CON')
    expect(rcSlot.getAttribute('data-on-file')).toBe('true')
    expect(rcSlot.textContent).toContain('e-signed by the carrier')
    const podSlot = screen.getByTestId('card-documents-slot-POD')
    expect(podSlot.getAttribute('data-on-file')).toBe('false')
    expect(podSlot.textContent).toContain('Missing')
  })

  it('a shipment built from an e-mail whose PDF never reached Documents offers to add it, once, and refreshes', async () => {
    const tied = savedBundle({ documents: [] }) as never as { shipment: Record<string, unknown> }
    tied.shipment.intakeLoadId = 'il:9'
    api.attachIntakeFiles.mockClear()
    const ctx = setup({ mode: 'edit', bundle: tied as never, refreshBundle: vi.fn(async () => undefined) })
    // Opening the shipment files it by itself, once...
    await waitFor(() => expect(api.attachIntakeFiles).toHaveBeenCalledTimes(1))
    expect(api.attachIntakeFiles).toHaveBeenCalledWith({ intakeId: 'il:9', shipmentId: expect.any(String) })
    await waitFor(() => expect(ctx.refreshBundle).toHaveBeenCalled())
    // ...and the button is there to do it again by hand.
    fireEvent.click(await screen.findByTestId('card-documents-add-email-pdf'))
    await waitFor(() => expect(api.attachIntakeFiles).toHaveBeenCalledTimes(2))
  })

  it('no offer when the e-mail\'s PDF is already in Documents, or the shipment was not built from an e-mail', async () => {
    const filed = savedBundle({ documents: [doc('intake-il:9-0', 'ratecon.pdf', 'INTERNAL', 'CUSTOMER_RATE_CON')] }) as never as { shipment: Record<string, unknown> }
    filed.shipment.intakeLoadId = 'il:9'
    setup({ mode: 'edit', bundle: filed as never })
    await waitFor(() => expect(api.getIntakeLoad).toHaveBeenCalled())
    expect(screen.queryByTestId('card-documents-add-email-pdf')).toBeNull()
  })

  it('Preview opens the document in the page\'s own preview (with its signed link), not a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    setup({ mode: 'edit', bundle })
    fireEvent.click(screen.getAllByLabelText('Preview customer-bol.pdf')[0]!)
    expect(await screen.findByText(/Bill of lading · customer-bol\.pdf|BOL · customer-bol\.pdf|customer-bol\.pdf/, { selector: '[role="dialog"] *' })).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[role="dialog"] iframe, [role="dialog"] embed, [role="dialog"] object, [role="dialog"] img')).not.toBeNull())
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('a queued file previews in the same dialog, from the file itself', async () => {
    setup({ mode: 'create' }, [{ file: pdf('queued.pdf'), audience: 'ALL', type: 'OTHER' }])
    ;(URL as unknown as { createObjectURL: (f: File) => string }).createObjectURL = () => 'blob:queued'
    fireEvent.click(screen.getByLabelText('Preview queued.pdf'))
    expect(await screen.findByText(/Will upload when the shipment is created/)).toBeTruthy()
  })

  it('uploading from the POD slot saves a public POD without touching the type picker', async () => {
    const ctx = setup({ mode: 'edit', bundle: savedBundle({ documents: [] }) })
    fireEvent.change(screen.getByLabelText('Upload Proof of delivery (POD)'), { target: { files: [pdf('pod.pdf')] } })
    await waitFor(() => expect(ctx.actions.uploadDocument).toHaveBeenCalledWith(expect.any(File), 'ALL', 'POD'))
  })

  it('on create, picked files are queued on the active tab audience and never uploaded', () => {
    const ctx = setup()
    pick(pdf('rc.pdf'), pdf('tender.pdf'))
    expect(ctx.actions.queueDocument).toHaveBeenCalledTimes(2)
    // A name that says rate con files as one; anything else keeps the picked type.
    expect(ctx.actions.queueDocument).toHaveBeenNthCalledWith(1, expect.any(File), 'ALL', 'RATE_CON')
    expect(ctx.actions.queueDocument).toHaveBeenLastCalledWith(expect.any(File), 'ALL', 'OTHER')
    fireEvent.click(screen.getByRole('tab', { name: 'Private' }))
    pick(pdf('internal.pdf'))
    expect(ctx.actions.queueDocument).toHaveBeenLastCalledWith(expect.any(File), 'INTERNAL', 'OTHER')
    expect(ctx.actions.uploadDocument).not.toHaveBeenCalled()
    expect(screen.getByTestId('card-documents-draft-note')).toBeTruthy()
  })

  it('a dropped file is queued too, and a queued file can be removed', () => {
    const ctx = setup({}, [{ file: pdf('later.pdf'), audience: 'ALL', type: 'OTHER' }])
    expect(within(screen.getByTestId('card-documents-queued-row')).getByText(/will upload on create/)).toBeTruthy()
    fireEvent.drop(screen.getByTestId('card-documents-dropzone'), { dataTransfer: { files: [pdf('dropped.pdf')] } })
    expect(ctx.actions.queueDocument).toHaveBeenCalledWith(expect.any(File), 'ALL', 'OTHER')
    fireEvent.click(screen.getByLabelText('Remove later.pdf'))
    expect(ctx.actions.unqueueDocument).toHaveBeenCalledWith(0)
  })

  it('on a saved shipment uploads straight away: Public → ALL, Private → INTERNAL', async () => {
    const ctx = setup({ mode: 'edit', bundle })
    pick(pdf('p.pdf'))
    await waitFor(() => expect(ctx.actions.uploadDocument).toHaveBeenCalledWith(expect.any(File), 'ALL', 'OTHER'))
    fireEvent.click(screen.getByRole('tab', { name: 'Private' }))
    pick(pdf('q.pdf'))
    await waitFor(() => expect(ctx.actions.uploadDocument).toHaveBeenLastCalledWith(expect.any(File), 'INTERNAL', 'OTHER'))
    expect(ctx.actions.queueDocument).not.toHaveBeenCalled()
  })

  it('refuses a type the server would refuse, before any upload or queue', () => {
    const ctx = setup()
    pick(pdf('movie.mp4', 'video/mp4'))
    expect(screen.getByTestId('card-documents-problem').textContent).toContain('PDF, a PNG or a JPEG')
    expect(ctx.actions.queueDocument).not.toHaveBeenCalled()
  })

  it('checklist ticks as documents arrive and counts queued files as queued, never blocking', () => {
    setup({ mode: 'edit', bundle, settings: { defaultRequiredDocs: ['BOL', 'POD'] } as unknown as TmsSettings })
    expect(screen.getByTestId('card-documents-check-BOL').getAttribute('data-met')).toBe('true')
    expect(screen.getByTestId('card-documents-check-RATE_CON').getAttribute('data-met')).toBe('true')
    expect(screen.getByTestId('card-documents-check-POD').getAttribute('data-met')).toBe('false')
  })

  it('lists a BOL row even when nothing requires it (optional); generated BOLs show their version, stale ones a chip, superseded ones hide until asked', () => {
    const bol = (id: string, status: string, version: number, uploadedAt: string) =>
      ({ ...doc(id, `bol-v${version}.pdf`, 'ALL', 'BOL', status), source: 'GENERATED', version, uploadedAt })
    const withBol = savedBundle({ documents: [bol('1', 'SUPERSEDED', 1, '2026-01-02T10:00:00.000Z'), bol('2', 'ACTIVE', 2, '2026-01-02T11:00:00.000Z')] })
    const stale = { ...withBol, shipment: { ...withBol.shipment, updatedAt: '2026-01-03T00:00:00.000Z' } }
    setup({ mode: 'edit', bundle: stale, settings: { defaultRequiredDocs: [] } as unknown as TmsSettings })
    const row = screen.getByTestId('card-documents-check-BOL')
    expect(row.getAttribute('data-required')).toBe('false')
    expect(row.getAttribute('data-met')).toBe('true')
    expect(screen.getByTestId('card-documents-check-generated').textContent).toBe('generated v2')
    expect(screen.getByTestId('card-documents-bol-stale')).toBeTruthy()
    expect(screen.getAllByTestId('card-documents-row')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('card-documents-show-superseded'))
    expect(screen.getAllByTestId('card-documents-row')).toHaveLength(2)
    expect(screen.getByTestId('card-documents-superseded-chip')).toBeTruthy()
  })
})

describe('releaseDocItems (Load Review rules)', () => {
  // requiredCarrierUploadTypes (carrier invoice) is set on purpose: it is paperwork for paying the carrier, never a release requirement.
  const settings = { defaultRequiredDocs: ['BOL'], requiredCarrierUploadTypes: ['CARRIER_INVOICE'] } as unknown as TmsSettings

  it('customer list replaces the org default; POD joins via the podReceived review requirement; rate con always', () => {
    const customer = { requiredDocsForInvoice: ['POD'], reviewRequirements: [] } as unknown as CustomerRecord
    const types = releaseDocItems({ customer, settings, bundle: null, queued: [] }).map((i) => i.type)
    expect(types).toEqual(['BOL', 'POD', 'RATE_CON'])
    expect(releaseDocItems({ customer, settings, bundle: null, queued: [] }).find((i) => i.type === 'BOL')?.required).toBe(false)
    const noCustomer = releaseDocItems({ customer: null, settings, bundle: null, queued: [] }).map((i) => i.type)
    expect(noCustomer).toEqual(['BOL', 'POD', 'RATE_CON'])
    expect(releaseDocItems({ customer: null, settings, bundle: null, queued: [] }).find((i) => i.type === 'BOL')?.required).toBe(true)
  })

  it('a queued file marks its type queued, not present; pending/rejected reviews do not count', () => {
    const items = releaseDocItems({
      customer: null, settings,
      bundle: { documents: [{ ...doc('9', 'b.pdf', 'ALL', 'BOL'), reviewStatus: 'PENDING' }], loadCarriers: [] } as never,
      queued: [{ file: pdf(), audience: 'ALL', type: 'RATE_CON' }],
    })
    expect(items.find((i) => i.type === 'BOL')).toMatchObject({ present: false, queued: false })
    expect(items.find((i) => i.type === 'RATE_CON')).toMatchObject({ present: false, queued: true })
    // The carrier's invoice is never on the release list.
    expect(items.some((i) => i.type === 'CARRIER_INVOICE')).toBe(false)
  })

  describe('saved files: change type, delete', () => {
    const mistyped = savedBundle({ documents: [doc('p', 'POD 14657.pdf', 'ALL'), doc('r', 'RateConf_4010854523.pdf', 'ALL')] })
    const api2 = () => ({ retype: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) })
    const renderWith = (documentApi: ReturnType<typeof api2>, b = mistyped) => {
      const ctx = makeCtx({ mode: 'edit', bundle: b, refreshBundle: vi.fn(async () => undefined) })
      const values = { ...emptyValues(), docs: { queued: [] } }
      render(<DocumentsCard values={values} update={vi.fn()} form={makeForm(values)} ctx={ctx} issues={[]} mode={ctx.mode} locked={NO_LOCKS} documentApi={documentApi} />)
      return ctx
    }

    it('a file filed as Other can be retyped to POD after upload, and the shipment re-reads', async () => {
      const documentApi = api2()
      const ctx = renderWith(documentApi)
      fireEvent.change(screen.getByLabelText('Type of POD 14657.pdf'), { target: { value: 'POD' } })
      await waitFor(() => expect(documentApi.retype).toHaveBeenCalledWith('p', 'POD'))
      await waitFor(() => expect(ctx.refreshBundle).toHaveBeenCalled())
    })

    it('a POD on file shows in the POD box with its own type picker and delete', () => {
      renderWith(api2(), savedBundle({ documents: [doc('p', 'POD 14657.pdf', 'ALL', 'POD')] }))
      const box = screen.getByTestId('card-documents-slot-POD')
      expect(box.getAttribute('data-on-file')).toBe('true')
      expect(within(box).getByLabelText('Type of POD 14657.pdf')).toBeTruthy()
      expect(within(box).getByLabelText('Delete POD 14657.pdf')).toBeTruthy()
      expect(screen.queryAllByTestId('card-documents-row')).toHaveLength(0)
    })

    it('delete asks inline first, then voids the file; Keep backs out', async () => {
      const documentApi = api2()
      renderWith(documentApi)
      fireEvent.click(screen.getByLabelText('Delete POD 14657.pdf'))
      fireEvent.click(screen.getByText('Keep'))
      expect(documentApi.remove).not.toHaveBeenCalled()
      fireEvent.click(screen.getByLabelText('Delete POD 14657.pdf'))
      fireEvent.click(screen.getByTestId('card-documents-delete-confirm-p'))
      await waitFor(() => expect(documentApi.remove).toHaveBeenCalledWith('p'))
    })

    it('driver-app and generated files keep their type (no picker)', () => {
      const pointer = { ...doc('d', 'driver-pod.jpg', 'ALL', 'POD'), source: 'DRIVER_APP' }
      const gen = { ...doc('g', 'BOL v1.pdf', 'ALL', 'BOL'), source: 'GENERATED', version: 1 }
      renderWith(api2(), savedBundle({ documents: [pointer, gen] }))
      expect(screen.queryByLabelText('Type of driver-pod.jpg')).toBeNull()
      expect(screen.queryByLabelText('Type of BOL v1.pdf')).toBeNull()
    })
  })

  it('the board\'s Missing chip lands on the matching box (#docs-RATE_CON) with its upload focused', () => {
    window.location.hash = '#docs-RATE_CON'
    setup({ mode: 'edit', bundle: savedBundle({ documents: [] }) })
    expect(document.activeElement?.getAttribute('data-testid')).toBe('card-documents-slot-RATE_CON-upload')
    window.location.hash = ''
  })
})
