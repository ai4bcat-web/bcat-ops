// @vitest-environment jsdom
/**
 * Opened from a load, the dialog must know which load it is for. Without that it created
 * a submission with no load and no PRO, nothing could find it again, and the next upload
 * for the same shipment started a second submission — two POD documents in the queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { Driver } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const staffUploadDriverDoc = vi.fn()
vi.mock('@/lib/driverSubmissionsClient', async (orig) => {
  const real = await orig<typeof import('@/lib/driverSubmissionsClient')>()
  return { ...real, staffUploadDriverDoc: (i: unknown) => staffUploadDriverDoc(i) }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { DriverDocUploadDialog } = await import('./DriverDocUploadDialog')

const roy = { id: 'drv-1', name: 'Roy Workman', email: 'roy@x.com', active: true } as Driver

beforeEach(() => {
  staffUploadDriverDoc.mockReset().mockResolvedValue({ id: 'sub-1', docs: [] })
})

function open(load?: { id: string; aljexId?: string | null } | null) {
  return render(
    <DriverDocUploadDialog
      open
      onClose={vi.fn()}
      drivers={[roy]}
      preselectedDriver={roy}
      preselectedKind="POD"
      load={load}
      staffEmail="ryne@bcatcorp.com"
      onSubmitted={vi.fn()}
    />,
  )
}

describe('DriverDocUploadDialog, opened from a load', () => {
  it('fills in the PRO and says so', () => {
    open({ id: 'load-9', aljexId: '14565  ' })
    expect(screen.getByLabelText('PRO #')).toHaveValue('14565')
    expect(screen.getByText(/join any POD already on this load/i)).toBeInTheDocument()
  })

  it('sends the load id with the pages, so a later batch can find this submission', async () => {
    open({ id: 'load-9', aljexId: '14565' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array(10)], 'pod.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: /upload/i }))
    await waitFor(() => expect(staffUploadDriverDoc).toHaveBeenCalled())
    expect(staffUploadDriverDoc.mock.calls[0][0]).toMatchObject({
      kind: 'POD', loadId: 'load-9', referenceNumber: '14565',
    })
  })

  it('still works as a free-standing upload with no load', () => {
    open(null)
    expect(screen.getByLabelText(/Reference #/)).toHaveValue('')
    expect(screen.queryByText(/join any POD already on this load/i)).toBeNull()
  })
})
