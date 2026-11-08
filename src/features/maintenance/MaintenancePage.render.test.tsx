// @vitest-environment jsdom
/**
 * The task list splits open work from completed work by tab; New Task opens the form
 * once there is equipment to attach it to.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const equipment = vi.fn(() => [
  { id: 'eq-1', type: 'truck', unitNumber: '101', nickname: 'Test Truck', active: true },
])
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({
    equipment: equipment(),
    maintenanceTasks: [
      { id: 't-open', equipmentId: 'eq-1', title: 'Rotate tires', status: 'upcoming', priority: 'med', dueDate: '2099-01-01' },
      { id: 't-done', equipmentId: 'eq-1', title: 'Replace wipers', status: 'complete', priority: 'low', dueDate: '2099-01-01' },
    ],
    addMaintenanceTask: vi.fn(),
    updateMaintenanceTask: vi.fn(),
    deleteMaintenanceTask: vi.fn(),
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { MaintenancePage } from './MaintenancePage'

describe('MaintenancePage render', () => {
  it('shows the heading, the New Task control and the open tasks', () => {
    render(<MaintenancePage />)
    expect(screen.getByRole('heading', { name: 'Maintenance' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /New Task/ })).toBeTruthy()
    expect(screen.getByText('Rotate tires')).toBeTruthy()
    expect(screen.queryByText('Replace wipers')).toBeNull()
  })

  it('opens the New Task form', () => {
    render(<MaintenancePage />)
    fireEvent.click(screen.getByRole('button', { name: /New Task/ }))
    expect(screen.getByText('Task Details')).toBeTruthy()
  })
})
