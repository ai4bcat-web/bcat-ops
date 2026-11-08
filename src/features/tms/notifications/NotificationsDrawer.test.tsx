// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NotificationsDrawer } from './NotificationsDrawer'
import type { NotificationGroup } from './collectNotifications'

const groups: NotificationGroup[] = [
  {
    kind: 'CHECK_CALLS', label: 'Check calls', total: 12, moreTo: '/tms/tracking?assignee=all&focus=checkcalls', moreLabel: 'Open worklist',
    items: [{ id: 'cc:1', kind: 'CHECK_CALLS', severity: 'critical', title: 'L-1 overdue', detail: 'Acme', at: null, to: '/tms/shipments/s1?tab=tracking' }],
  },
  {
    kind: 'WORKFLOWS', label: 'Workflow errors', total: 1, moreTo: '/tms/workflows?tab=errors', moreLabel: 'Open Errors tab',
    items: [{ id: 'wf:1', kind: 'WORKFLOWS', severity: 'critical', title: 'AP run failed', detail: 'boom', at: null, to: '/tms/workflows?tab=errors' }],
  },
]

function renderDrawer(list: NotificationGroup[], onOpenChange = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<NotificationsDrawer open onOpenChange={onOpenChange} groups={list} />} />
      </Routes>
    </MemoryRouter>,
  )
  return onOpenChange
}

describe('NotificationsDrawer', () => {
  it('offers a tab per kind that has items, with counts, and filters to the chosen kind', () => {
    renderDrawer(groups)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      expect.stringContaining('All'), expect.stringContaining('Check calls'), expect.stringContaining('Workflow errors'),
    ])
    expect(screen.queryByRole('tab', { name: /Credit/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Workflow errors/ }))
    expect(screen.queryByText('L-1 overdue')).toBeNull()
    expect(screen.getByText('AP run failed')).toBeInTheDocument()
  })

  it('links to the owning page when a group has more than it shows, and closes on item click', () => {
    const onOpenChange = renderDrawer(groups)
    expect(screen.getByRole('link', { name: /Open worklist — 11 more/ })).toHaveAttribute('href', '/tms/tracking?assignee=all&focus=checkcalls')
    expect(screen.queryByRole('link', { name: /Open Errors tab/ })).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: /L-1 overdue/ }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says the user is caught up with no items', () => {
    renderDrawer([])
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
  })
})
