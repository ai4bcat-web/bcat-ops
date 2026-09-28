// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import {
  listVendorPayables,
  getVendorPayable,
  updateVendorPayable,
  completeVendorPayable,
  reopenVendorPayable,
  deleteVendorPayable,
  getVendorApAttachmentUrl,
} from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import { useVendorPayables } from './useVendorPayables'
import type { VendorPayable } from '@/types/vendorAp'

vi.mock('@/lib/apiClient', () => ({
  listVendorPayables: vi.fn(),
  getVendorPayable: vi.fn(),
  updateVendorPayable: vi.fn(),
  completeVendorPayable: vi.fn(),
  reopenVendorPayable: vi.fn(),
  deleteVendorPayable: vi.fn(),
  getVendorApAttachmentUrl: vi.fn(),
}))

vi.mock('@/store/useAppStore', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: () => ({ maintenanceInvoices: [] }),
  },
}))

function payable(overrides: Partial<VendorPayable> = {}): VendorPayable {
  return {
    id: 'vp-1',
    status: 'NEED_TO_PAY',
    source: 'EMAIL',
    subject: 'Invoice for repairs',
    vendor: 'Rush Truck Centers',
    invoiceNumber: 'RT-1001',
    amount: 12300,
    invoiceDate: '2026-09-20',
    description: 'Brake work',
    fromEmail: 'billing@rush.com',
    emailBody: 'Please remit payment.',
    attachments: [],
    receivedAt: '2026-09-20T10:00:00Z',
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

function maintenanceInvoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    equipmentId: 'eq-1',
    date: '2026-09-20',
    vendor: 'Rush Truck Centers',
    description: 'Brake work',
    amount: 12300,
    invoiceNumber: 'RT-1001',
    source: 'EMAIL',
    status: 'POSTED',
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  if (typeof Promise.withResolvers === 'function') {
    return Promise.withResolvers<T>()
  }
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('useVendorPayables', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('loads on mount and polls every 30 seconds', async () => {
    vi.mocked(listVendorPayables).mockResolvedValue([])
    renderHook(() => useVendorPayables())

    expect(listVendorPayables).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(0))
    expect(listVendorPayables).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTime(30_000))
    expect(listVendorPayables).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a pending row during a background poll', async () => {
    const initial = payable({ id: 'vp-pending', vendor: 'Alpha' })
    vi.mocked(listVendorPayables).mockResolvedValue([initial])

    const { promise, resolve } = deferred<VendorPayable>()
    vi.mocked(updateVendorPayable).mockReturnValue(promise)

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    act(() => {
      void result.current.updateDetails('vp-pending', { vendor: 'Alpha Updated' })
    })
    await waitFor(() => expect(result.current.pendingIds.has('vp-pending')).toBe(true))

    // Poll returns a different value while the update is in flight.
    vi.mocked(listVendorPayables).mockResolvedValue([payable({ id: 'vp-pending', vendor: 'Poll Value', updatedAt: '2026-09-20T12:00:00Z' })])
    await act(async () => vi.advanceTimersByTime(30_000))

    // Pending row should keep its in-flight value, not the poll value.
    expect(result.current.items.find((i) => i.id === 'vp-pending')?.vendor).toBe('Alpha')

    // Once the mutation completes, the confirmed value is applied.
    const confirmed = payable({ id: 'vp-pending', vendor: 'Alpha Updated', updatedAt: '2026-09-21T10:00:00Z' })
    await act(async () => {
      resolve(confirmed)
      await promise
    })
    await waitFor(() => expect(result.current.items.find((i) => i.id === 'vp-pending')?.vendor).toBe('Alpha Updated'))
    expect(result.current.pendingIds.has('vp-pending')).toBe(false)
  })

  it('does not resurrect a deleted row from a stale poll, but allows a later new row with the same source', async () => {
    const initial = payable({ id: 'vp-del', vendor: 'Beta', updatedAt: '2026-09-20T10:00:00Z' })
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    vi.mocked(deleteVendorPayable).mockResolvedValue(undefined)

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await act(async () => result.current.removePayable('vp-del'))
    expect(result.current.items).toHaveLength(0)

    // Stale poll returns the deleted row with its old updatedAt.
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(result.current.items).toHaveLength(0)

    // A genuinely recreated invoice has a new id (and likely newer updatedAt).
    const recreated = payable({ id: 'vp-del-new', vendor: 'Beta', updatedAt: '2026-09-21T10:00:00Z' })
    vi.mocked(listVendorPayables).mockResolvedValue([recreated])
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].id).toBe('vp-del-new')
  })

  it('keeps a confirmed completed state when a stale poll returns an older version', async () => {
    const initial = payable({ id: 'vp-pay', status: 'NEED_TO_PAY', updatedAt: '2026-09-20T10:00:00Z' })
    const completed = payable({
      id: 'vp-pay',
      status: 'DONE',
      paymentMethod: 'Check',
      paymentDate: '2026-09-21',
      updatedAt: '2026-09-21T10:00:00Z',
    })
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    vi.mocked(completeVendorPayable).mockResolvedValue(completed)

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items[0].status).toBe('NEED_TO_PAY'))

    await act(async () =>
      result.current.recordPayment('vp-pay', { paymentMethod: 'Check', paymentDate: '2026-09-21' }),
    )
    expect(result.current.items[0].status).toBe('DONE')

    // Stale poll returns the pre-payment version.
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(result.current.items[0].status).toBe('DONE')
  })

  it('updates the local maintenance invoice after a linked payment without a second backend mutation', async () => {
    const initial = payable({
      id: 'vp-link',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'mi-1',
      status: 'NEED_TO_PAY',
      updatedAt: '2026-09-20T10:00:00Z',
    })
    const completed = payable({
      ...initial,
      status: 'DONE',
      paymentMethod: 'Zelle',
      paymentDate: '2026-09-22',
      paymentReference: 'REF-99',
      updatedAt: '2026-09-22T10:00:00Z',
    })
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    vi.mocked(completeVendorPayable).mockResolvedValue(completed)

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await act(async () =>
      result.current.recordPayment('vp-link', {
        paymentMethod: 'Zelle',
        paymentDate: '2026-09-22',
        paymentReference: 'REF-99',
      }),
    )

    const setState = vi.mocked(useAppStore.setState)
    expect(setState).toHaveBeenCalled()
    const updater = setState.mock.lastCall![0] as (state: { maintenanceInvoices: ReturnType<typeof maintenanceInvoice>[] }) => { maintenanceInvoices: unknown[] }
    const next = updater({ maintenanceInvoices: [maintenanceInvoice('mi-1')] })
    expect(next.maintenanceInvoices[0]).toMatchObject({
      paymentMethod: 'Zelle',
      paymentDate: '2026-09-22',
    })
  })

  it('clears the local maintenance invoice payment fields on reopen without a second backend mutation', async () => {
    const initial = payable({
      id: 'vp-reopen',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'mi-2',
      status: 'DONE',
      paymentMethod: 'Check',
      paymentDate: '2026-09-22',
      updatedAt: '2026-09-20T10:00:00Z',
    })
    const reopened = payable({
      ...initial,
      status: 'NEED_TO_PAY',
      paymentMethod: null,
      paymentDate: null,
      paymentReference: null,
      updatedAt: '2026-09-23T10:00:00Z',
    })
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    vi.mocked(reopenVendorPayable).mockResolvedValue(reopened)

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items[0].status).toBe('DONE'))

    await act(async () => result.current.reopenPayable('vp-reopen'))
    expect(result.current.items[0].status).toBe('NEED_TO_PAY')

    const setState = vi.mocked(useAppStore.setState)
    const updater = setState.mock.lastCall![0] as (state: { maintenanceInvoices: ReturnType<typeof maintenanceInvoice>[] }) => { maintenanceInvoices: unknown[] }
    const next = updater({ maintenanceInvoices: [maintenanceInvoice('mi-2', { paymentMethod: 'Check', paymentDate: '2026-09-22' })] })
    expect(next.maintenanceInvoices[0]).toMatchObject({
      paymentMethod: undefined,
      paymentDate: undefined,
    })
  })

  it('surfaces fetch errors without clearing existing items', async () => {
    const initial = payable()
    vi.mocked(listVendorPayables).mockResolvedValueOnce([initial]).mockRejectedValueOnce(new Error('network down'))

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await act(async () => vi.advanceTimersByTime(30_000))
    await waitFor(() => expect(result.current.error).toBe('network down'))
    expect(result.current.items).toHaveLength(1)
  })

  it('reverts to the previous value and removes pending when a mutation fails', async () => {
    const initial = payable({ id: 'vp-fail', vendor: 'Before' })
    vi.mocked(listVendorPayables).mockResolvedValue([initial])
    vi.mocked(updateVendorPayable).mockRejectedValue(new Error('save failed'))

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))
    await waitFor(() => expect(result.current.items[0].vendor).toBe('Before'))

    await expect(act(async () => result.current.updateDetails('vp-fail', { vendor: 'After' }))).rejects.toThrow('save failed')
    expect(result.current.items[0].vendor).toBe('Before')
    expect(result.current.pendingIds.has('vp-fail')).toBe(false)
  })

  it('exposes getAttachmentUrl through the API client', async () => {
    vi.mocked(listVendorPayables).mockResolvedValue([])
    vi.mocked(getVendorApAttachmentUrl).mockResolvedValue('https://example.com/file.pdf')

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))

    const url = await result.current.getAttachmentUrl('intake-pdfs/vendor-ap/file.pdf')
    expect(url).toBe('https://example.com/file.pdf')
    expect(getVendorApAttachmentUrl).toHaveBeenCalledWith('intake-pdfs/vendor-ap/file.pdf')
  })

  it('exposes getPayableDetails through the API client', async () => {
    const full = payable({ id: 'vp-detail', emailBody: 'Full body' })
    vi.mocked(listVendorPayables).mockResolvedValue([])
    vi.mocked(getVendorPayable).mockResolvedValue(full)

    const { result } = renderHook(() => useVendorPayables())
    await act(async () => vi.advanceTimersByTime(0))

    const got = await result.current.getPayableDetails('vp-detail')
    expect(got.emailBody).toBe('Full body')
    expect(getVendorPayable).toHaveBeenCalledWith('vp-detail')
  })
})
