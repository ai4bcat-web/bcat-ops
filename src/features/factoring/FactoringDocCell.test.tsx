// @vitest-environment jsdom
/**
 * Attaching a document to a factoring row.
 *
 * Readiness is a CACHED blob stored on the row. Attaching a POD does not change it, so the
 * row went on saying "missing POD" with the POD sitting right there — and Submit, which is
 * gated on that same cached blob, stayed disabled on an invoice that was actually complete.
 * Observed on PRO 14538.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FactoringDocCell } from './FactoringDocCell'

const assembleInvoice = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const staffUploadDriverDoc = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const uploadRateConfirm = vi.hoisted(() => vi.fn().mockResolvedValue('rate-confirms/load-1/rc.pdf'))
const updateLoad = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/otrClient', () => ({ assembleInvoice }))
vi.mock('@/lib/apiClient', () => ({ uploadRateConfirm, getRateConfirmUrl: vi.fn() }))
vi.mock('@/lib/driverSubmissionsClient', () => ({
  staffUploadDriverDoc,
  removeDriverDocs: vi.fn(),
  replaceDriverDocs: vi.fn(),
  driverDocValidationError: () => null,
  DRIVER_DOC_ACCEPT: 'image/jpeg,application/pdf',
}))
vi.mock('@/hooks/useLoadDriverDocs', () => ({
  useLoadDriverDocs: () => ({ pods: [], ratecons: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      loads: [{ id: 'load-1', deliveryDriverId: 'drv-1', rateConfirmKey: null }],
      updateLoad,
    }),
}))

function renderCell(kind: 'POD' | 'RATECON', onUploaded = vi.fn()) {
  render(
    <FactoringDocCell
      kind={kind}
      present={false}
      loadId="load-1"
      proNumber="14538"
      itemId="14538"
      staffEmail="ryne@bcatcorp.com"
      onUploaded={onUploaded}
    />,
  )
  const label = kind === 'POD' ? 'POD' : 'Rate con'
  const button = screen.getByRole('button', { name: `Upload the ${label} for PRO 14538` })
  return button.parentElement!.querySelector('input[type="file"]') as HTMLInputElement
}

const file = (name: string, type: string) => new File(['x'], name, { type })

beforeEach(() => vi.clearAllMocks())

describe('attaching a document to a factoring row', () => {
  it('rebuilds readiness after a POD lands, so the row stops calling it missing', async () => {
    const onUploaded = vi.fn()
    const input = renderCell('POD', onUploaded)
    fireEvent.change(input, { target: { files: [file('pod.jpg', 'image/jpeg')] } })

    await waitFor(() => expect(staffUploadDriverDoc).toHaveBeenCalled())
    await waitFor(() => expect(assembleInvoice).toHaveBeenCalledWith('14538'))
    await waitFor(() => expect(onUploaded).toHaveBeenCalled())
  })

  it('does the same for a rate confirmation, which is stored somewhere else entirely', async () => {
    const input = renderCell('RATECON')
    fireEvent.change(input, { target: { files: [file('rc.pdf', 'application/pdf')] } })

    await waitFor(() => expect(uploadRateConfirm).toHaveBeenCalled())
    await waitFor(() => expect(assembleInvoice).toHaveBeenCalledWith('14538'))
  })

  it('still reports the upload as done when readiness cannot be rebuilt', async () => {
    // The document is attached either way, and the row has its own Refresh. A failure to
    // rebuild a cache must never read as a failed upload.
    assembleInvoice.mockRejectedValueOnce(new Error('network'))
    const onUploaded = vi.fn()
    const input = renderCell('POD', onUploaded)
    fireEvent.change(input, { target: { files: [file('pod.jpg', 'image/jpeg')] } })

    await waitFor(() => expect(onUploaded).toHaveBeenCalled())
  })
})
