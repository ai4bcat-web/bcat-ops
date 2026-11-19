// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChaseAchPreview } from '@/lib/apiClient'
import { ChaseAchDialog } from './ChaseAchDialog'

const api = vi.hoisted(() => ({ previewChaseAch: vi.fn(), exportChaseAch: vi.fn(), clearChaseAchMark: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const preview = (over: Partial<ChaseAchPreview> = {}): ChaseAchPreview => ({
  settingsReady: true, settingsProblem: null, effectiveDate: '2026-11-23', effectiveDateProblem: null,
  rows: [
    { billId: 'b1', status: 'READY', pro: '14525', payeeName: 'Fake Trucking LLC', payeeKind: 'CARRIER', method: 'ACH', last4: '6789', amountCents: 95000, alreadyExportedAt: null },
    { billId: 'b2', status: 'BLOCKED', reason: 'No bank details are available for the ACH method ending 1234', pro: '14610', payeeName: 'Sample Haulers', payeeKind: 'CARRIER', method: 'ACH', last4: '1234', amountCents: 110000, alreadyExportedAt: null },
    { billId: 'b3', status: 'SKIPPED', reason: 'Paid by check, not ACH', pro: '14692', payeeName: 'Third Co', payeeKind: 'CARRIER', method: 'CHECK', last4: null, amountCents: 95000, alreadyExportedAt: null },
  ],
  readyCount: 1, readyTotalCents: 95000, blockedCount: 1, skippedCount: 1, alreadyExportedCount: 0,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('ChaseAchDialog', () => {
  it('previews ready, blocked and skipped rows with last fours only', async () => {
    api.previewChaseAch.mockResolvedValue(preview())
    render(<ChaseAchDialog billIds={['b1', 'b2', 'b3']} onClose={vi.fn()} onDone={vi.fn()} />)
    expect(await screen.findByText('Fake Trucking LLC')).toBeInTheDocument()
    expect(screen.getByText('••6789')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Blocked')).toBeInTheDocument()
    expect(screen.getByText(/No bank details are available/)).toBeInTheDocument()
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download Chase ACH file' })).toBeEnabled()
  })

  it('disables the download until the Chase settings exist', async () => {
    api.previewChaseAch.mockResolvedValue(preview({ settingsReady: false, settingsProblem: 'Chase file settings are not set up yet' }))
    render(<ChaseAchDialog billIds={['b1']} onClose={vi.fn()} onDone={vi.fn()} />)
    expect(await screen.findByTestId('chase-ach-settings-problem')).toHaveTextContent('not set up')
    expect(screen.getByRole('button', { name: 'Download Chase ACH file' })).toBeDisabled()
  })

  it('downloads the file, says nothing was paid, and offers to undo the mark', async () => {
    api.previewChaseAch.mockResolvedValue(preview())
    api.exportChaseAch.mockResolvedValue({
      exportId: 'e1', fileName: 'BCAT-ACH-20261119-0900A.ach', fileText: 'FILE', entryCount: 1, totalCents: 95000,
      effectiveDate: '2026-11-23', exportedBillIds: ['b1'], notExported: [],
    })
    api.clearChaseAchMark.mockResolvedValue({ cleared: ['b1'] })
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const onDone = vi.fn()
    render(<ChaseAchDialog billIds={['b1']} onClose={vi.fn()} onDone={onDone} />)
    await screen.findByText('Fake Trucking LLC')
    fireEvent.click(screen.getByRole('button', { name: 'Download Chase ACH file' }))
    expect(await screen.findByTestId('chase-ach-result')).toHaveTextContent('BCAT-ACH-20261119-0900A.ach')
    expect(screen.getByTestId('chase-ach-result')).toHaveTextContent('record the payments')
    expect(click).toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo mark' }))
    await waitFor(() => expect(api.clearChaseAchMark).toHaveBeenCalledWith({ billIds: ['b1'] }))
    click.mockRestore()
  })
})
