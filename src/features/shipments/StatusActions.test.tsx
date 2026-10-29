// @vitest-environment jsdom
/**
 * Two contracts live here.
 *
 * 1. A failed action must not escape as an unhandled promise rejection. Radix's
 *    `onSelect`/`onConfirm` ignore the promise they are handed, so a `run` wrapper that
 *    rethrows after the handler has already toasted produced an unhandled rejection on
 *    every refused action. The dialog must also stay open, so the user can retry after
 *    reading the toast rather than watch it vanish on failure.
 * 2. A PRO number is permanent: there is no Delete and no Restore anywhere in the menu,
 *    Void is the only exit, only the owner or an admin is offered it, and a shipment
 *    that is already voided offers nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ShipmentRowActions, type ShipmentActionHandlers } from './components/StatusActions'
import { AuthContext } from '@/hooks/useAuth'
import type { ShipmentRecord } from '@/types/tms'

vi.mock('./components/VoidShipmentDialog', () => ({
  VoidShipmentDialog: ({ shipment }: { shipment: { number: string } }) => (
    <div data-testid="void-dialog">Void {shipment.number}</div>
  ),
}))

const shipment = {
  id: 'shp-1', number: 'S000001', status: 'OPEN', updatedAt: '2026-04-01T00:00:00.000Z',
  pickupAppt: null, deliveryAppt: null,
} as unknown as ShipmentRecord

function handlers(over: Partial<ShipmentActionHandlers> = {}): ShipmentActionHandlers {
  return {
    onDuplicate: vi.fn(async () => {}),
    onSetStatus: vi.fn(async () => {}),
    onVoid: vi.fn(),
    onTenderRespond: vi.fn(async () => {}),
    ...over,
  }
}

function openMenu() {
  fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
}

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
        handlers={handlers({ onSetStatus })}
      />,
    )
    openMenu()
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

describe('the PRO never leaves', () => {
  it('offers no way to delete or restore a shipment', async () => {
    render(
      <ShipmentRowActions shipment={shipment} isAdmin cancelDeleteAdminOnly={false} handlers={handlers()} />,
    )
    openMenu()
    await waitFor(() => expect(screen.getByText('Duplicate')).toBeTruthy())
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.queryByText('Restore')).toBeNull()
  })

  it('offers Void to an admin and opens the void dialog', async () => {
    render(
      <ShipmentRowActions shipment={shipment} isAdmin cancelDeleteAdminOnly={false} handlers={handlers()} />,
    )
    openMenu()
    fireEvent.click(await screen.findByText('Void shipment…'))
    expect(await screen.findByTestId('void-dialog')).toBeTruthy()
  })

  it('offers Void to the owner even when they are not flagged admin', async () => {
    render(
      <AuthContext.Provider
        value={{
          user: null, loading: false, needsNewPassword: false,
          login: vi.fn(), completeNewPassword: vi.fn(), logout: vi.fn(),
          isAdmin: false, isOwner: true, hasPageAccess: () => true,
        }}
      >
        <ShipmentRowActions shipment={shipment} isAdmin={false} cancelDeleteAdminOnly={false} handlers={handlers()} />
      </AuthContext.Provider>,
    )
    openMenu()
    expect(await screen.findByText('Void shipment…')).toBeTruthy()
  })

  it('hides Void from everybody else', async () => {
    render(
      <ShipmentRowActions shipment={shipment} isAdmin={false} cancelDeleteAdminOnly={false} handlers={handlers()} />,
    )
    openMenu()
    await waitFor(() => expect(screen.getByText('Duplicate')).toBeTruthy())
    expect(screen.queryByText('Void shipment…')).toBeNull()
  })

  it('disables every action on a shipment that is already voided', async () => {
    const voided = { ...shipment, voidedAt: '2026-04-02T00:00:00.000Z' } as ShipmentRecord
    render(
      <ShipmentRowActions shipment={voided} isAdmin cancelDeleteAdminOnly={false} handlers={handlers()} />,
    )
    openMenu()
    await waitFor(() => expect(screen.getByText('Duplicate')).toBeTruthy())
    for (const label of ['Duplicate', 'Put on hold', 'Cancel']) {
      expect(screen.getByText(label).closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true')
    }
    // Without the new handlers, neither void-related exit nor re-point appears.
    expect(screen.queryByText('Void shipment…')).toBeNull()
    expect(screen.queryByText('Unvoid shipment…')).toBeNull()
    expect(screen.queryByText('Re-point customer…')).toBeNull()
  })

  it('offers Unvoid on a voided row when the board provides a handler', async () => {
    const voided = { ...shipment, voidedAt: '2026-04-02T00:00:00.000Z' } as ShipmentRecord
    const onUnvoid = vi.fn()
    render(
      <ShipmentRowActions shipment={voided} isAdmin cancelDeleteAdminOnly={false} handlers={handlers({ onUnvoid })} />,
    )
    openMenu()
    fireEvent.click(await screen.findByText('Unvoid shipment…'))
    await waitFor(() => expect(onUnvoid).toHaveBeenCalled())
  })

  it('offers Re-point customer to an admin when the board provides a handler', async () => {
    const onRepointCustomer = vi.fn()
    render(
      <ShipmentRowActions shipment={shipment} isAdmin cancelDeleteAdminOnly={false} handlers={handlers({ onRepointCustomer })} />,
    )
    openMenu()
    fireEvent.click(await screen.findByText('Re-point customer…'))
    await waitFor(() => expect(onRepointCustomer).toHaveBeenCalled())
  })
})
