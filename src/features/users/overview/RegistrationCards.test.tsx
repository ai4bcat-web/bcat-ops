// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RegistrationCards } from './RegistrationCards'

vi.mock('@/features/compliance/DriverApplicationView', () => ({
  DriverApplicationView: () => <div>application body</div>,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const application = {
  kind: 'application' as const,
  id: 'a1',
  entityType: 'DRIVER' as const,
  entityId: 'd1',
  entityName: 'Ann Driver',
  label: 'Employment application',
  submittedAt: '2026-03-01T00:00:00Z',
  application: { id: 'a1', driverId: 'd1', status: 'SUBMITTED' } as never,
}

function setup(over: Partial<React.ComponentProps<typeof RegistrationCards>> = {}) {
  const props = {
    applications: [],
    refusals: [],
    awaiting: [],
    staffInvites: [],
    onApprove: vi.fn().mockResolvedValue(undefined),
    onReject: vi.fn().mockResolvedValue(undefined),
    onDismiss: vi.fn().mockResolvedValue(undefined),
    onReinvite: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  render(
    <MemoryRouter>
      <RegistrationCards {...props} />
    </MemoryRouter>,
  )
  return props
}

describe('RegistrationCards', () => {
  it('says so when nothing is waiting', () => {
    setup()
    expect(screen.getByText('No registrations waiting.')).toBeTruthy()
  })

  it('cannot reject an application without a reason', async () => {
    const props = setup({ applications: [application] })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const submit = screen.getAllByRole('button', { name: 'Reject' }).at(-1)!
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not a fit' } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(submit) })
    expect(props.onReject).toHaveBeenCalledWith(application.application, 'Not a fit')
  })

  it('dismisses a blocked sign-up and resends a staff invite', async () => {
    const props = setup({
      refusals: [{ email: 'x@y.com', at: '2026-03-02T00:00:00Z', reason: 'NO_DRIVER_RECORD' }],
      staffInvites: [{ username: 'sub-1', email: 'new@bcatcorp.com' }],
    })
    expect(screen.getByText(/not on the roster/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })) })
    expect(props.onDismiss).toHaveBeenCalledWith('x@y.com')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resend invite' })) })
    expect(props.onReinvite).toHaveBeenCalledWith('sub-1')
  })
})
