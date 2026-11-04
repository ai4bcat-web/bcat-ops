// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FormDocumentsSection } from './FormDocumentsSection'
import { emptyValues } from '../model'
import type { FormCtx } from '../sectionProps'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

vi.mock('@/lib/apiClient', () => ({ getShipmentDocumentUrl: vi.fn(async () => 'https://example.invalid/doc') }))

const doc = (id: string, name: string, audience: string, status = 'ACTIVE') => ({ id, name, audience, status, type: 'OTHER', s3Key: `k/${id}` })

function setup(ctxOver: Partial<FormCtx> = {}, queued: ReturnType<typeof emptyValues>['docs']['queued'] = []) {
  const ctx = makeCtx(ctxOver)
  render(<FormDocumentsSection value={{ queued }} onChange={vi.fn()} ctx={ctx} form={makeForm()} />)
  return ctx
}

const pdf = (name = 'a.pdf', type = 'application/pdf') => new File(['x'], name, { type })
const pick = (file: File) => fireEvent.change(screen.getByLabelText('Upload'), { target: { files: [file] } })

describe('FormDocumentsSection', () => {
  const bundle = savedBundle({
    documents: [
      doc('1', 'customer-bol.pdf', 'CUSTOMER'), doc('2', 'carrier-rc.pdf', 'CARRIER'), doc('3', 'all.pdf', 'ALL'),
      doc('4', 'internal.pdf', 'INTERNAL'), doc('5', 'voided.pdf', 'ALL', 'VOID'),
    ],
  })

  it('Public lists CUSTOMER, CARRIER and ALL; Private lists INTERNAL; voided rows never show', () => {
    setup({ mode: 'edit', bundle })
    const names = () => screen.getAllByTestId('documents-row').map((r) => r.children[0].textContent)
    expect(names()).toEqual(['customer-bol.pdf', 'carrier-rc.pdf', 'all.pdf'])
    fireEvent.click(screen.getByRole('tab', { name: 'Private' }))
    expect(names()).toEqual(['internal.pdf'])
  })

  it('uploads on the active tab\'s audience: Public → ALL, Private → INTERNAL', async () => {
    const ctx = setup({ mode: 'edit', bundle })
    pick(pdf('p.pdf'))
    fireEvent.click(screen.getByTestId('documents-upload'))
    await waitFor(() => expect(ctx.actions.uploadDocument).toHaveBeenCalledWith(expect.any(File), 'ALL', 'OTHER'))
    fireEvent.click(screen.getByRole('tab', { name: 'Private' }))
    pick(pdf('q.pdf'))
    fireEvent.click(screen.getByTestId('documents-upload'))
    await waitFor(() => expect(ctx.actions.uploadDocument).toHaveBeenLastCalledWith(expect.any(File), 'INTERNAL', 'OTHER'))
  })

  it('in create mode the file is queued, not uploaded, and shows "will upload on save"', () => {
    const queuedFile = { file: pdf('later.pdf'), audience: 'ALL' as const, type: 'OTHER' as const }
    const ctx = setup({}, [queuedFile])
    expect(within(screen.getByTestId('documents-queued-row')).getByText(/will upload on save/)).toBeTruthy()
    pick(pdf('new.pdf'))
    fireEvent.click(screen.getByTestId('documents-upload'))
    expect(ctx.actions.queueDocument).toHaveBeenCalledWith(expect.any(File), 'ALL', 'OTHER')
    expect(ctx.actions.uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses a file type the server would refuse, before any upload', () => {
    const ctx = setup({ mode: 'edit', bundle })
    pick(pdf('movie.mp4', 'video/mp4'))
    fireEvent.click(screen.getByTestId('documents-upload'))
    expect(screen.getByTestId('documents-problem').textContent).toContain('PDF, a PNG or a JPEG')
    expect(ctx.actions.uploadDocument).not.toHaveBeenCalled()
  })
})
