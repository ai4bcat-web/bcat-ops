// @vitest-environment jsdom
/**
 * Smoke render for the open-tasks board: tasks come from the (stubbed) command center,
 * are grouped under an assignee heading, and the empty state shows when none are open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CommandCenterTask } from '@/lib/commandCenterClient'

const listTasks = vi.fn<() => Promise<CommandCenterTask[]>>()
vi.mock('@/lib/commandCenterClient', () => ({ listTasks: () => listTasks(), updateTask: vi.fn() }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'staff@example.test' } }) }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) => sel({
    setSelectedLoad: vi.fn(),
    openNewShipment: vi.fn(),
    newShipmentPrefill: null,
    closeNewShipment: vi.fn(),
  }),
}))
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('@/features/shipments/components/NewShipmentDialog', () => ({ NewShipmentDialog: () => null }))

import { TasksPage } from './TasksPage'

const task: CommandCenterTask = {
  id: 't-1',
  title: 'Fake task title',
  business: 'bcat',
  source: 'email',
  status: 'NEW',
  subject: 'Fake task subject',
}

beforeEach(() => { listTasks.mockReset() })

describe('TasksPage render', () => {
  it('shows the heading, Refresh, and an open task under Unassigned', async () => {
    listTasks.mockResolvedValue([task])
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
    expect(await screen.findByText('Fake task subject')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Unassigned' })).toBeTruthy()
  })

  it('shows the all-clear empty state when nothing is open', async () => {
    listTasks.mockResolvedValue([])
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    expect(await screen.findByText('No open tasks — all clear!')).toBeTruthy()
  })
})
