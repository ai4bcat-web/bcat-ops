// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FollowUpsPage } from './FollowUpsPage'

const auth = vi.hoisted(() => ({ value: { isAdmin: false, isOwner: false, user: { email: 'rep@x.test', groups: [] as string[] } } }))
const crmAction = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth.value }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ nameOf: (id: string | null) => id ?? '—' }) }))
vi.mock('@/lib/apiClient', () => ({ crmAction, graphqlErrorText: () => '' }))

const rows = [
  { customerId: 'c1', customerName: 'ZZ One', ownerId: 'dana', nextStep: 'Call back', nextStepDueAt: '2020-01-01T12:00:00Z', overdue: true,
    openTasks: [{ id: 'act:1', ownerId: 'dana', kind: 'TASK', at: '2020-01-01T00:00:00Z', summary: 'Send W9', dueAt: '2020-01-02T12:00:00Z', createdBy: 'dana' }] },
]

beforeEach(() => {
  auth.value = { isAdmin: false, isOwner: false, user: { email: 'rep@x.test', groups: [] } }
  crmAction.mockReset()
  crmAction.mockResolvedValue({ rows })
})

const page = () => render(<MemoryRouter><FollowUpsPage /></MemoryRouter>)

describe('FollowUpsPage', () => {
  it('lists next steps and tasks with a link to the customer card, flagging overdue', async () => {
    page()
    await waitFor(() => expect(screen.getByTestId('followup-step-c1')).toBeTruthy())
    expect(screen.getByTestId('followup-step-c1').textContent).toContain('overdue')
    expect(screen.getByTestId('followup-task-act:1').textContent).toContain('Send W9')
    expect(screen.getAllByTestId('followup-link-c1')[0].getAttribute('href')).toBe('/tms/customers?customer=c1')
  })

  it('a rep always asks for their own scope; a manager can widen it', async () => {
    const { unmount } = page()
    await waitFor(() => expect(crmAction).toHaveBeenCalledWith('CRM_LIST_FOLLOWUPS', { scope: 'mine' }))
    expect(screen.queryByTestId('followups-scope')).toBeNull()
    unmount()
    auth.value = { isAdmin: false, isOwner: false, user: { email: 'boss@x.test', groups: ['role-MANAGER'] } }
    page()
    fireEvent.change(await screen.findByTestId('followups-scope'), { target: { value: 'all' } })
    await waitFor(() => expect(crmAction).toHaveBeenCalledWith('CRM_LIST_FOLLOWUPS', { scope: 'all' }))
  })

  it('shows empty states when nothing is due', async () => {
    crmAction.mockResolvedValue({ rows: [] })
    page()
    await waitFor(() => expect(screen.getByText('Nothing due')).toBeTruthy())
    expect(screen.getByText('No open tasks')).toBeTruthy()
  })
})
