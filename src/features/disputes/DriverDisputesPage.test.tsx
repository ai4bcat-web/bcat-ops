// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/lib/disputePortalClient', () => ({
  DISPUTE_PORTAL_API_URL: 'https://portal.example',
  portalAvailable: true,
  DisputePortalError: class extends Error {},
  listDisputes: vi.fn().mockResolvedValue({ items: [], nextToken: null }),
  listDrivers: vi.fn().mockResolvedValue([]),
  getUploadUrl: vi.fn().mockResolvedValue({ url: 'https://upload.example', key: 'k' }),
  submitDispute: vi.fn().mockResolvedValue({ id: 'sub-1' }),
  uploadFileToS3: vi.fn().mockResolvedValue(undefined),
  uuid: vi.fn().mockReturnValue('new-id'),
}))

import { DriverDisputesPage } from './DriverDisputesPage'

function renderIn(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('DriverDisputesPage evidence chips', () => {
  it('labels the first file as the trip confirmation and re-labels when it is removed', async () => {
    renderIn(<DriverDisputesPage />)

    const drop = screen.getByLabelText(/Trip confirmation email and any other photos/i) as HTMLInputElement
    fireEvent.change(drop, {
      target: {
        files: [
          new File(['a'], 'first.jpg', { type: 'image/jpeg' }),
          new File(['b'], 'second.jpg', { type: 'image/jpeg' }),
        ],
      },
    })

    const chips = await screen.findAllByRole('listitem')
    expect(chips.length).toBe(2)
    expect(chips[0].textContent).toContain('first.jpg')
    expect(chips[0].textContent).toContain('Trip confirmation')
    expect(chips[1].textContent).toContain('second.jpg')
    expect(chips[1].textContent).not.toContain('Trip confirmation')

    fireEvent.click(screen.getByRole('button', { name: /Remove first\.jpg/ }))

    await waitFor(() => {
      const remaining = screen.getByText('second.jpg').closest('li')!
      expect(remaining.textContent).toContain('Trip confirmation')
    })
  })
})
