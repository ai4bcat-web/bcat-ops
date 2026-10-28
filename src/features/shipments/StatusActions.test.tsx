// @vitest-environment jsdom
/**
 * A failed action must not escape as an unhandled promise rejection.
 *
 * Radix's `onSelect`/`onConfirm` ignore the promise they are handed, so a `run` wrapper
 * that rethrows after the handler has already toasted produced an unhandled rejection on
 * every refused action. The dialog must also stay open, so the user can retry after
 * reading the toast rather than watch it vanish on failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ShipmentRowActions } from './components/StatusActions'
import type { ShipmentRecord } from '@/types/tms'

const shipment = {
  id: 'shp-1', status: 'OPEN', deletedAt: null, pickupAppt: null, deliveryAppt: null,
} as unknown as ShipmentRecord

const rejections: unknown[] = []
const onRejection = (reason: unknown) => { rejections.push(reason) }

beforeEach(() => { rejections.length = 0; process.on('unhandledRejection', onRejection) })
afterEach(() => { process.off('unhandledRejection', onRejection) })

describe('row actions with a failing handler', () => {
  it('does not leave the rejection unhandled, and keeps the dialog open', async () => {
    const onSetStatus = vi.fn(async () => { throw new Error('boom') })
    render(
      <ShipmentRowActions
        shipment={shipment}
        isAdmin
        cancelDeleteAdminOnly={false}
        handlers={{
          onDuplicate: vi.fn(), onSetStatus, onDelete: vi.fn(),
          onRestore: vi.fn(), onTenderRespond: vi.fn(),
        }}
      />,
    )
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByText('Put on hold')).toBeTruthy())
    fireEvent.click(screen.getByText('Put on hold'))
    await waitFor(() => expect(screen.getByLabelText('Reason')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(onSetStatus).toHaveBeenCalled())
    // Node reports an unhandled rejection a turn after it goes unclaimed.
    const settled = Promise.withResolvers<void>()
    setTimeout(() => settled.resolve(), 20)
    await settled.promise

    expect(rejections).toEqual([])
    expect(screen.getByLabelText('Reason')).toBeTruthy()
  })
})
