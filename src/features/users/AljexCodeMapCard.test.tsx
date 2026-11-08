// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { AljexCodeSummary } from '@/types/tms'

const api = vi.hoisted(() => ({
  listAljexCodes: vi.fn(),
  setAljexCodeMap: vi.fn(),
  reassignShipmentsByRepCode: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: toastMock }))
// The picker is exercised on its own; here it is a plain control so the table logic is what is under test.
vi.mock('@/components/RepPicker', () => ({
  RepPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="picker" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { AljexCodeMapCard } from './AljexCodeMapCard'

const code = (over: Partial<AljexCodeSummary>): AljexCodeSummary => ({
  kind: 'SALES_REP', code: 'JD', shipmentCount: 10, pendingCount: 10, userId: null, userName: null,
  lastAppliedAt: null, lastAppliedBy: null, lastAppliedCount: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listAljexCodes.mockResolvedValue([code({}), code({ kind: 'STAFF', code: 'AB', pendingCount: 0 })])
})

describe('AljexCodeMapCard', () => {
  it('renders nothing before an import has stored any code', async () => {
    api.listAljexCodes.mockResolvedValue([])
    render(<AljexCodeMapCard />)
    await waitFor(() => expect(api.listAljexCodes).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Aljex code mapping')).not.toBeInTheDocument())
  })

  it('does not ask the Lambda for the codes until the card scrolls into view', async () => {
    let reveal: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof reveal) { reveal = cb }
      observe() {}
      disconnect() {}
    })
    try {
      render(<AljexCodeMapCard />)
      expect(screen.getByText(/Loading codes/)).toBeInTheDocument()
      expect(api.listAljexCodes).not.toHaveBeenCalled()
      act(() => { reveal([{ isIntersecting: true }]) })
      await waitFor(() => expect(api.listAljexCodes).toHaveBeenCalledTimes(1))
      expect(await screen.findByTestId('code-map-SALES_REP')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('saving a mapping writes only the mapping, never a reassign', async () => {
    api.setAljexCodeMap.mockResolvedValue({ map: {} })
    render(<AljexCodeMapCard />)
    const pickers = await screen.findAllByLabelText('picker')
    fireEvent.change(pickers[0], { target: { value: 'u-1' } })
    fireEvent.click(screen.getByLabelText('Save mapping for JD'))
    await waitFor(() => expect(api.setAljexCodeMap).toHaveBeenCalledWith({ kind: 'SALES_REP', code: 'JD', userId: 'u-1' }))
    expect(api.reassignShipmentsByRepCode).not.toHaveBeenCalled()
  })

  it('previews the count, and reassigns only after the confirm', async () => {
    api.reassignShipmentsByRepCode.mockImplementation(async (i: { dryRun?: boolean }) => ({
      code: 'JD', repId: 'u-1', dryRun: !!i.dryRun, matched: 10, updated: 7, skippedAlreadyAssigned: 3, skippedVoided: 0, failed: [], hasMore: false,
    }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<AljexCodeMapCard />)
    const pickers = await screen.findAllByLabelText('picker')
    fireEvent.change(pickers[0], { target: { value: 'u-1' } })
    fireEvent.click(screen.getByLabelText('Reassign shipments for JD'))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(confirm.mock.calls[0][0]).toMatch(/Reassign 7 shipment/)
    expect(api.reassignShipmentsByRepCode).toHaveBeenCalledTimes(1)
    expect(api.reassignShipmentsByRepCode).toHaveBeenLastCalledWith({ code: 'JD', repId: 'u-1', dryRun: true })

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('Reassign shipments for JD'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('7 shipment(s) reassigned'))
    expect(api.reassignShipmentsByRepCode).toHaveBeenLastCalledWith({ code: 'JD', repId: 'u-1' })
  })

  it('keeps calling while the Lambda reports more, and sums what each call changed', async () => {
    const page = (updated: number, hasMore: boolean) => ({
      code: 'JD', repId: 'u-1', dryRun: false, matched: 10, updated, skippedAlreadyAssigned: 0, skippedVoided: 0, failed: [], hasMore,
    })
    api.reassignShipmentsByRepCode
      .mockResolvedValueOnce({ ...page(7, false), dryRun: true })
      .mockResolvedValueOnce(page(4, true))
      .mockResolvedValueOnce(page(3, false))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<AljexCodeMapCard />)
    const pickers = await screen.findAllByLabelText('picker')
    fireEvent.change(pickers[0], { target: { value: 'u-1' } })
    fireEvent.click(screen.getByLabelText('Reassign shipments for JD'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('7 shipment(s) reassigned'))
    expect(api.reassignShipmentsByRepCode).toHaveBeenCalledTimes(3)
  })

  it('shows a refusal from the Lambda as written', async () => {
    api.reassignShipmentsByRepCode.mockRejectedValue(new Error('Owner or ADMIN only'))
    render(<AljexCodeMapCard />)
    const pickers = await screen.findAllByLabelText('picker')
    fireEvent.change(pickers[0], { target: { value: 'u-1' } })
    fireEvent.click(screen.getByLabelText('Reassign shipments for JD'))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Owner or ADMIN only'))
  })

  it('offers no reassign for staff codes', async () => {
    render(<AljexCodeMapCard />)
    await screen.findByTestId('code-map-STAFF')
    expect(screen.queryByLabelText('Reassign shipments for AB')).toBeNull()
  })
})
