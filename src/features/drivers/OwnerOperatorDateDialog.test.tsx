// @vitest-environment jsdom
/**
 * The owner-operator date question opens over the driver drawer. It was a shadcn dialog at z-index 50, under the drawer's own overlay and
 * panel (60/61), so it showed dimmed and could not be clicked. It now stacks above the drawer and is a form: Enter saves, Cancel closes,
 * and a missing date says why Save driver is off.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TmsDrawer } from '@/features/tms/kit/TmsDrawer'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@example.com' }) }))

const { OwnerOperatorDateDialog } = await import('./OwnerOperatorDateDialog')

const over = (props: Partial<React.ComponentProps<typeof OwnerOperatorDateDialog>> = {}) => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <TmsDrawer open onOpenChange={() => {}} title="Edit driver">
      <p>drawer body</p>
      <OwnerOperatorDateDialog change="START" driverName="Daniel Palmer" onConfirm={onConfirm} onCancel={onCancel} {...props} />
    </TmsDrawer>,
  )
  return { onConfirm, onCancel }
}

describe('OwnerOperatorDateDialog over the driver drawer', () => {
  it('stacks above the drawer overlay (60) and panel (61)', () => {
    over()
    const overlays = Array.from(document.querySelectorAll('.tms-dialog-overlay')) as HTMLElement[]
    const dialog = screen.getByRole('dialog', { name: /owner operator effective from/i })
    const zs = overlays.map((o) => Number(o.style.zIndex || 0))
    expect(Math.max(...zs)).toBeGreaterThan(61)
    expect(Number(dialog.style.zIndex)).toBeGreaterThan(Math.max(...zs))
  })

  it('has Save driver on with today filled in, and saves it with the signed-in e-mail', () => {
    const { onConfirm } = over()
    const save = screen.getByRole('button', { name: /save driver/i })
    expect(save).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Owner operator effective from', { selector: 'input' }), { target: { value: '2026-10-08' } })
    fireEvent.click(save)
    expect(onConfirm).toHaveBeenCalledWith('2026-10-08', 'ryne@example.com')
  })

  it('saves on Enter', () => {
    const { onConfirm } = over()
    fireEvent.submit(screen.getByLabelText('Owner operator effective from', { selector: 'input' }).closest('form') as HTMLFormElement)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('turns Save driver off with the reason beside it when the date is cleared', () => {
    const { onConfirm } = over()
    fireEvent.change(screen.getByLabelText('Owner operator effective from', { selector: 'input' }), { target: { value: '' } })
    expect(screen.getByRole('button', { name: /save driver/i })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a date to save.')
    fireEvent.submit(screen.getByLabelText('Owner operator effective from', { selector: 'input' }).closest('form') as HTMLFormElement)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Cancel closes it without saving, and the "until" wording is used when switching away', () => {
    const { onConfirm, onCancel } = over({ change: 'END' })
    expect(screen.getByRole('dialog', { name: /owner operator until/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Last day as an owner operator', { selector: 'input' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
