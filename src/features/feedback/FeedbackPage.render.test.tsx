// @vitest-environment jsdom
/**
 * Smoke render for the feedback page: the submit form and the list both mount from a
 * stubbed client, and the status filter narrows the list.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { FeedbackItem } from './feedbackLogic'

const items: FeedbackItem[] = [
  { id: 'f-1', page: 'Loads', summary: 'Fake new report', status: 'NEW', submittedBy: 'a.person@example.test', createdAt: '2026-01-02T12:00:00Z' },
  { id: 'f-2', page: 'Fleet', summary: 'Fake finished report', status: 'DONE', submittedBy: 'b.person@example.test', createdAt: '2026-01-01T12:00:00Z' },
  { id: 'f-3', page: 'Calendar', summary: 'My own report', status: 'IN_PROGRESS', priority: 1, submittedBy: 'Staff@Example.test', createdAt: '2026-01-03T12:00:00Z' },
]

vi.mock('@/lib/feedbackClient', () => ({
  createFeedback: vi.fn(),
  listFeedback: vi.fn(async () => items),
  updateFeedback: vi.fn(),
  uploadFeedbackScreenshot: vi.fn(),
  getFeedbackScreenshotUrl: vi.fn().mockResolvedValue(''),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.test' }, isAdmin: false }),
}))

import { FeedbackPage } from './FeedbackPage'
import { createFeedback, updateFeedback } from '@/lib/feedbackClient'

describe('FeedbackPage render', () => {
  it('shows the heading, the submit control, and the listed reports', async () => {
    render(<FeedbackPage />)
    expect(screen.getByRole('heading', { name: 'Feedback' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Submit feedback/ })).toBeTruthy()
    expect(await screen.findByText('Fake new report')).toBeTruthy()
    expect(screen.getByText('Fake finished report')).toBeTruthy()
  })

  it('the Done filter hides reports that are not done', async () => {
    render(<FeedbackPage />)
    await screen.findByText('Fake new report')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('Fake new report')).toBeNull()
    expect(screen.getByText('Fake finished report')).toBeTruthy()
  })

  it('the person who submitted a report can mark it done; someone else\'s report has no such button', async () => {
    vi.mocked(updateFeedback).mockResolvedValue({ ...items[2]!, status: 'DONE' } as never)
    render(<FeedbackPage />)
    fireEvent.click(await screen.findByText('Fake new report'))
    expect(screen.queryByTestId('feedback-mark-done')).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('feedback-mark-done')).toBeNull())
    fireEvent.click(await screen.findByText('My own report'))
    fireEvent.click(await screen.findByTestId('feedback-mark-done'))
    await waitFor(() => expect(updateFeedback).toHaveBeenCalledWith('f-3', { status: 'DONE' }))
  })

  it('the form asks for a priority (defaulting to 2) and sends it; the list shows it and can filter by it', async () => {
    vi.mocked(createFeedback).mockResolvedValue({ id: 'f-9', page: 'Loads', summary: 'x' } as never)
    render(<FeedbackPage />)
    await screen.findByText('My own report')
    expect(screen.getByText('P1 Blocking')).toBeTruthy()
    const priority = screen.getByLabelText('Priority') as HTMLSelectElement
    expect(priority.value).toBe('2')
    expect([...priority.options].map((o) => o.textContent)).toEqual(['1 · Blocking me from working', '2 · Need to fix, not ASAP', '3 · Nice to have'])
    fireEvent.change(priority, { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('What is not working'), { target: { value: 'Cannot save a shipment' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit feedback/ }))
    await waitFor(() => expect(createFeedback).toHaveBeenCalledWith(expect.objectContaining({ priority: 1, summary: 'Cannot save a shipment' })))
    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: '1' } })
    expect(screen.getByText('My own report')).toBeTruthy()
    expect(screen.queryByText('Fake new report')).toBeNull()
  })

  it('owns its scroll container, so every row is reachable in the fixed-height host', async () => {
    render(<FeedbackPage />)
    await screen.findByText('Fake new report')
    const scroll = screen.getByTestId('feedback-scroll')
    expect(scroll.className).toContain('overflow-auto')
    expect(scroll.className).toContain('h-full')
    expect(scroll.contains(screen.getByText('Fake new report'))).toBe(true)
  })
})
