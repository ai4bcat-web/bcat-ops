// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DocumentsCard } from './DocumentsCard'
import { releaseDocItems } from './releaseDocs'
import { emptyValues, NO_LOCKS, type QueuedFile } from '../model'
import type { FormCtx } from '../sectionProps'
import { makeCtx, makeForm, savedBundle } from '../sections/ah5TestKit'
import type { CustomerRecord, TmsSettings } from '@/types/tms'

vi.mock('@/lib/apiClient', () => ({ getShipmentDocumentUrl: vi.fn(async () => 'https://example.invalid/doc') }))
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

  it('Public lists CUSTOMER, CARRIER and ALL; Private lists INTERNAL; voided rows never show', () => {
    setup({ mode: 'edit', bundle })
    const names = () => screen.getAllByTestId('card-documents-row').map((r) => r.children[0].textContent)
    expect(names()).toEqual(['customer-bol.pdf', 'carrier-rc.pdf', 'all.pdf'])
    expect(within(screen.getAllByTestId('card-documents-row')[0]).getByText(/ann@example.invalid/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Private' }))
    expect(names()).toEqual(['internal.pdf'])
  })

  it('on create, picked files are queued on the active tab audience and never uploaded', () => {
    const ctx = setup()
    pick(pdf('tender.pdf'), pdf('rc.pdf'))
    expect(ctx.actions.queueDocument).toHaveBeenCalledTimes(2)
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
  const settings = { defaultRequiredDocs: ['BOL'], requiredCarrierUploadTypes: ['CARRIER_INVOICE'] } as unknown as TmsSettings

  it('customer list replaces the org default; POD joins via the podReceived review requirement; rate con always', () => {
    const customer = { requiredDocsForInvoice: ['POD'], reviewRequirements: [] } as unknown as CustomerRecord
    const types = releaseDocItems({ customer, settings, bundle: null, queued: [] }).map((i) => i.type)
    expect(types).toEqual(['BOL', 'POD', 'RATE_CON', 'CARRIER_INVOICE'])
    expect(releaseDocItems({ customer, settings, bundle: null, queued: [] }).find((i) => i.type === 'BOL')?.required).toBe(false)
    const noCustomer = releaseDocItems({ customer: null, settings, bundle: null, queued: [] }).map((i) => i.type)
    expect(noCustomer).toEqual(['BOL', 'POD', 'RATE_CON', 'CARRIER_INVOICE'])
    expect(releaseDocItems({ customer: null, settings, bundle: null, queued: [] }).find((i) => i.type === 'BOL')?.required).toBe(true)
  })

  it('a queued file marks its type queued, not present; pending/rejected reviews do not count', () => {
    const items = releaseDocItems({
      customer: null, settings,
      bundle: { documents: [{ ...doc('9', 'b.pdf', 'ALL', 'BOL'), reviewStatus: 'PENDING' }], loadCarriers: [] } as never,
      queued: [{ file: pdf(), audience: 'ALL', type: 'CARRIER_INVOICE' }],
    })
    expect(items.find((i) => i.type === 'BOL')).toMatchObject({ present: false, queued: false })
    expect(items.find((i) => i.type === 'CARRIER_INVOICE')).toMatchObject({ present: false, queued: true })
  })
})
