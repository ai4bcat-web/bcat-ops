// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '@/lib/apiClient'
import { toast } from 'sonner'
import { DuplicateDialog } from './DuplicateDialog'
import { parseCopies } from './duplicateCopies'
import { ActionBar } from './ActionBar'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({ duplicateShipment: vi.fn(), getShipmentBundle: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('parseCopies', () => {
  it.each([['1', 1], [' 20 ', 20], ['0', null], ['21', null], ['', null], ['2.5', null], ['abc', null]])('%j -> %j', (text, out) => expect(parseCopies(text)).toBe(out))
})

describe('DuplicateDialog', () => {
  const open = (onDone = vi.fn(), onClose = vi.fn()) => render(<DuplicateDialog shipmentId="shp-1" number="20009" onClose={onClose} onDone={onDone} />)

  it('asks the server for the copies with a blank customer ref, names the new PROs and hands back the ids', async () => {
    vi.mocked(api.duplicateShipment).mockResolvedValue({ created: ['shp-2', 'shp-3'] } as never)
    vi.mocked(api.getShipmentBundle).mockImplementation(async (id: string) => ({ shipment: { number: id === 'shp-2' ? '20031' : '20032' } }) as never)
    const onDone = vi.fn()
    open(onDone)
    fireEvent.change(screen.getByTestId('duplicate-copies'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('duplicate-confirm'))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['shp-2', 'shp-3']))
    expect(api.duplicateShipment).toHaveBeenCalledWith({ shipmentId: 'shp-1', copies: [{}, {}], clearReference: true })
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toContain('PRO 20031, 20032')
  })

  it('refuses a bad count and shows a server refusal without closing', async () => {
    vi.mocked(api.duplicateShipment).mockRejectedValue(new Error('Credit limit reached'))
    const onDone = vi.fn()
    open(onDone)
    fireEvent.change(screen.getByTestId('duplicate-copies'), { target: { value: '25' } })
    expect(screen.getByTestId('duplicate-confirm')).toBeDisabled()
    fireEvent.change(screen.getByTestId('duplicate-copies'), { target: { value: '1' } })
    fireEvent.click(screen.getByTestId('duplicate-confirm'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Credit limit reached'))
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('ActionBar Duplicate button', () => {
  const bar = (over: Record<string, unknown> = {}) => render(
    <ActionBar createMode={false} status="OPEN" dirty={false} savedAt={null} done={8} total={8} ready busy={false} voided={false}
      onRun={() => {}} onDiscard={() => {}} onDuplicate={() => {}} {...over} />,
  )
  it('is there on a saved shipment and says why when it cannot be used', () => {
    const { unmount } = bar()
    expect(screen.getByTestId('ship-form-duplicate')).toBeEnabled()
    unmount()
    const dirty = bar({ dirty: true })
    expect(screen.getByTestId('ship-form-duplicate')).toBeDisabled()
    expect(screen.getByTestId('ship-form-duplicate').getAttribute('title')).toMatch(/Save your changes first/)
    dirty.unmount()
    bar({ voided: true })
    expect(screen.getByTestId('ship-form-duplicate')).toBeDisabled()
  })
  it('is not on a create page', () => {
    bar({ createMode: true, onDuplicate: undefined })
    expect(screen.queryByTestId('ship-form-duplicate')).toBeNull()
  })
})
