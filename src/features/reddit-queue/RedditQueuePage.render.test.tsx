// @vitest-environment jsdom
/**
 * Smoke render for the Reddit draft queue: pending drafts load from the (stubbed) command
 * center API, and switching tab refetches without the pending-only status filter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RedditQueuePage } from './RedditQueuePage'

const draft = {
  id: 'rd-1',
  createdAt: '2026-01-01T00:00:00Z',
  subreddit: 'faketestsub',
  title: 'Fake thread title',
  threadUrl: 'https://reddit.example/r/faketestsub/1',
  response: 'Fake draft reply',
  business: 'jobsdone' as const,
  status: 'pending' as const,
  why: 'Fake reason',
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => [draft] })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('RedditQueuePage render', () => {
  it('shows the heading with the pending count and the draft actions', async () => {
    render(<RedditQueuePage />)
    expect(await screen.findByText('Fake thread title')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Reddit Queue \(1\)/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Copy response/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Mark Posted/ })).toBeTruthy()
    expect(fetchMock.mock.calls[0][0]).toContain('?status=pending')
  })

  it('switching to Posted refetches and shows the empty state when none match', async () => {
    render(<RedditQueuePage />)
    await screen.findByText('Fake thread title')
    fireEvent.click(screen.getByRole('button', { name: 'Posted' }))
    expect(await screen.findByText('No posted items yet.')).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).not.toContain('status=')
  })
})
