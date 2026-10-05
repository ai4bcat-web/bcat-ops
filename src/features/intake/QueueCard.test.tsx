// @vitest-environment jsdom
/**
 * The task card's primary action depends on whether the task already has a load.
 * Appointment tasks (Dennis/Ruben ladder) are IVAN_CARTAGE items created WITH a
 * builtLoadId, so the action must open that load for update — never build a new one.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueueCard } from './IntakePage'
import type { IntakeItem } from '@/types'

const base = {
  id: 't1', source: 'IVAN_CARTAGE', status: 'NEW', subject: 'Book delivery appt — Pro# 123',
  bodyText: '', receivedAt: '2026-09-11T12:00:00Z', assignedTo: 'dennis@bcatcorp.com',
  externalSource: 'manual',
} as unknown as IntakeItem

function renderCard(item: IntakeItem) {
  const onBuildLoad = vi.fn()
  const onUpdateLoad = vi.fn()
  render(<QueueCard item={item} onBuildLoad={onBuildLoad} onUpdateLoad={onUpdateLoad}
                    onMarkDone={vi.fn()} onStatusChange={vi.fn()} onAssigneeChange={vi.fn()} />)
  return { onBuildLoad, onUpdateLoad }
}

describe('QueueCard primary action', () => {
  it('an appointment task with a load offers Update Load and opens that load', () => {
    const item = { ...base, builtLoadId: 'load-9', externalId: 'appt-task:book_delivery:load-9:1' } as IntakeItem
    const { onBuildLoad, onUpdateLoad } = renderCard(item)
    expect(screen.queryByText('Build Load')).toBeNull()
    fireEvent.click(screen.getByText('Update Load'))
    expect(onUpdateLoad).toHaveBeenCalledWith(item)
    expect(onBuildLoad).not.toHaveBeenCalled()
  })

  it('a new Ivan intake item without a load still offers Build Load', () => {
    const { onBuildLoad, onUpdateLoad } = renderCard(base)
    expect(screen.queryByText('Update Load')).toBeNull()
    fireEvent.click(screen.getByText('Build Load'))
    expect(onBuildLoad).toHaveBeenCalledWith(base)
    expect(onUpdateLoad).not.toHaveBeenCalled()
  })
})

/*
 * The Slack thread, on the card.
 *
 * The queue's status field was never maintained because the conversation happens in Slack
 * and the app could not see it. These assert the card now shows what was actually said,
 * and marks done on the load existing rather than on a reaction — the emoji in those
 * threads (:rocket:, :got-it:) mean acknowledged, not built.
 */
function item(over: Partial<IntakeItem>): IntakeItem {
  return { ...base, ...over } as IntakeItem
}

describe('the Slack thread on a queue card', () => {
  it('shows the most recent reply', () => {
    renderCard(item({
      lastReplyText: 'PRO# 14556 - Added in BCAT Ops',
      replyCount: 2,
      status: 'NEW',
    }))
    expect(screen.getByText('PRO# 14556 - Added in BCAT Ops')).toBeTruthy()
    expect(screen.getByText(/2 replies/)).toBeTruthy()
  })

  it('says so plainly when nobody has replied', () => {
    renderCard(item({ lastReplyText: '', replyCount: 0, status: 'BUILT' }))
    expect(screen.getByText('No replies yet')).toBeTruthy()
  })

  it('shows a checkmark once the load exists', () => {
    renderCard(item({ status: 'BUILT', lastReplyText: 'PRO# 14556 - Added in BCAT Ops', replyCount: 1 }))
    expect(screen.getByLabelText('Done')).toBeTruthy()
  })

  it('shows no checkmark while the item is still open', () => {
    renderCard(item({ status: 'NEW', builtLoadId: null, lastReplyText: 'on it', replyCount: 1 }))
    expect((screen.queryByLabelText('Done'))).toBeNull()
  })

  it('counts a built load as done even when the status was never moved', () => {
    // Exactly the 317-item case: the work was done, the status never caught up.
    renderCard(item({ status: 'NEW', builtLoadId: 'l1', lastReplyText: 'added', replyCount: 1 }))
    expect(screen.getByLabelText('Done')).toBeTruthy()
  })

  it('shows the PRO beside the reply once one is known', () => {
    renderCard(item({ proNumber: '14556', lastReplyText: 'added', replyCount: 1 }))
    expect(screen.getByText(/PRO 14556/)).toBeTruthy()
  })

  it('renders nothing for an item with no thread activity at all', () => {
    renderCard(item({ status: 'NEW', builtLoadId: null, lastReplyText: '', replyCount: 0 }))
    expect(screen.queryByText('No replies yet')).toBeNull()
  })
})
