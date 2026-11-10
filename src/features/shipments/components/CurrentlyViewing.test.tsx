// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ user: { email: 'ryne@bcatcorp.com' } as { email: string } | null, isAdmin: false }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))
const api = vi.hoisted(() => ({ unlock: vi.fn(async () => ({ released: true })) }))
vi.mock('@/lib/apiClient', () => ({ unlockShipment: api.unlock }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

import { CurrentlyViewing } from './CurrentlyViewing'

const future = new Date(Date.now() + 5 * 60_000).toISOString()
const past = new Date(Date.now() - 60_000).toISOString()
const rows = [
  { id: 's1', number: '20011', editLockUserId: 'ryne@bcatcorp.com', editLockUserName: 'Ryne', editLockExpiresAt: future },
  { id: 's2', number: '20002', editLockUserId: 'dennis@bcatcorp.com', editLockUserName: 'Dennis', editLockExpiresAt: future },
  { id: 's3', number: '20003', editLockUserId: 'ruben@bcatcorp.com', editLockUserName: 'Ruben', editLockExpiresAt: past },
  { id: 's4', number: '20004' },
]

beforeEach(() => { api.unlock.mockClear(); auth.isAdmin = false })

describe('CurrentlyViewing', () => {
  it('lists only live locks with who holds each, under the words Currently viewing', () => {
    render(<CurrentlyViewing rows={rows} onOpen={vi.fn()} />)
    expect(screen.getByText('Currently viewing')).toBeTruthy()
    expect(screen.getByTestId('currently-viewing-s1').textContent).toContain('you')
    expect(screen.getByTestId('currently-viewing-s2').textContent).toContain('Dennis')
    expect(screen.queryByTestId('currently-viewing-s3')).toBeNull()
    expect(screen.queryByTestId('currently-viewing-s4')).toBeNull()
  })

  it('shows nothing when nobody has anything open', () => {
    const { container } = render(<CurrentlyViewing rows={[rows[3]!]} onOpen={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('the holder can let go of their own lock; someone else cannot let go of another person’s', async () => {
    const onChanged = vi.fn()
    render(<CurrentlyViewing rows={rows} onOpen={vi.fn()} onChanged={onChanged} />)
    expect(screen.queryByLabelText('Release the lock on 20002')).toBeNull()
    fireEvent.click(screen.getByLabelText('Release the lock on 20011'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(api.unlock).toHaveBeenCalledWith('s1', false)
  })

  it('an admin can let go of anybody’s lock (forced)', async () => {
    auth.isAdmin = true
    render(<CurrentlyViewing rows={rows} onOpen={vi.fn()} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Release the lock on 20002'))
    await waitFor(() => expect(api.unlock).toHaveBeenCalledWith('s2', true))
  })

  it('clicking the number opens the shipment', () => {
    const onOpen = vi.fn()
    render(<CurrentlyViewing rows={rows} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('20002'))
    expect(onOpen).toHaveBeenCalledWith('s2')
  })
})
