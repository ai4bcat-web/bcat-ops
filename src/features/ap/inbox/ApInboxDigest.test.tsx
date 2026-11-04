// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { ApInboxConfig, ApRunDigest } from '@/lib/apInbox/types'
import { ApInboxDigest } from './ApInboxDigest'
import type { ApInboxStatusView } from './apInboxClient'

const CONFIG = { runHourChicago: 6 } as ApInboxConfig
const RUN: ApRunDigest = {
  id: 'r1', trigger: 'MANUAL', startedAt: '2026-11-04T12:00:00.000Z', endedAt: '2026-11-04T12:02:00.000Z',
  listed: 31, reviewed: 31, stage1Rejected: 20, stage2Rejected: 4, modelCalls: 7, notInvoice: 3, invoices: 4, applied: 4,
  updatedBills: 4, needReview: 3, errors: 0, abandoned: 0, partial: false,
}
const view = (patch: Partial<ApInboxStatusView> & { status?: ApInboxStatusView['connection']['status'] } = {}): ApInboxStatusView => ({
  config: CONFIG,
  connection: { status: patch.status ?? 'CONNECTED', googleEmail: 'ai4bcat@gmail.com', connectedAt: null, lastError: null },
  runs: [RUN], openCount: 5, devStack: false, providerReady: true, ...patch,
})
const draw = (status: ApInboxStatusView | null, extra: Partial<Parameters<typeof ApInboxDigest>[0]> = {}) =>
  render(
    <MemoryRouter>
      <ApInboxDigest status={status} syncing={false} progress={null} isAdmin={false} onReviewNow={vi.fn()} onOpenQueue={vi.fn()} now={new Date('2026-11-04T18:00:00Z')} {...extra} />
    </MemoryRouter>,
  )

describe('ApInboxDigest', () => {
  it('says what the last run did, in the plan’s words, with the open count and Review now', () => {
    const onReviewNow = vi.fn()
    draw(view(), { onReviewNow })
    const line = screen.getByTestId('ap-inbox-digest')
    expect(line).toHaveTextContent('reviewed 31 e-mails, updated 4 bills, 3 need review')
    expect(line).toHaveTextContent('(5 open in the queue)')
    fireEvent.click(screen.getByTestId('ap-inbox-review-now'))
    expect(onReviewNow).toHaveBeenCalled()
  })

  it('offers no Review now while disconnected, and points an admin at Settings', () => {
    draw(view({ status: 'NOT_CONNECTED', runs: [] }), { isAdmin: true })
    expect(screen.queryByTestId('ap-inbox-review-now')).toBeNull()
    expect(screen.getByTestId('ap-inbox-digest')).toHaveTextContent('not connected')
    expect(screen.getByRole('link', { name: 'Open settings' })).toBeTruthy()
  })

  it('shows the loop’s progress while reviewing and blocks a second press', () => {
    draw(view(), { syncing: true, progress: { reviewed: 14, remaining: 2 } })
    expect(screen.getByTestId('ap-inbox-digest')).toHaveTextContent('Reviewed 14 · 2 left')
    expect(screen.getByTestId('ap-inbox-review-now')).toBeDisabled()
  })

  it('warns when Google stopped accepting the connection', () => {
    draw(view({ status: 'NEEDS_RECONNECT' }))
    expect(screen.getByTestId('ap-inbox-digest')).toHaveTextContent('no longer accepts')
  })

  it('renders nothing before the status arrives', () => {
    draw(null)
    expect(screen.queryByTestId('ap-inbox-digest')).toBeNull()
  })
})
