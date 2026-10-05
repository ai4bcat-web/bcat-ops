// @vitest-environment jsdom
/**
 * The intake queue is a LIST now, not a grid of cards.
 *
 * The page exists to answer "what does Slack say about this tender", and a four-across
 * card grid pushed that into the corner of a box. These pin the row: the latest reply is
 * on the line, and the check means the load exists rather than that somebody reacted.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueueRow } from './IntakePage'
import type { IntakeItem } from '@/types'

const base = {
  id: 't1', source: 'IVAN_CARTAGE', status: 'NEW',
  subject: 'Tender TMS ID 212666394: CHICAGO, IL(10/08)',
  bodyText: '', receivedAt: '2026-10-04T12:00:00Z', assignedTo: 'dennis@bcatcorp.com',
  externalSource: 'slack',
} as unknown as IntakeItem

function renderRow(over: Partial<IntakeItem> = {}) {
  const fns = {
    onBuildLoad: vi.fn(), onUpdateLoad: vi.fn(), onMarkDone: vi.fn(),
    onStatusChange: vi.fn(), onAssigneeChange: vi.fn(),
  }
  render(<QueueRow item={{ ...base, ...over } as IntakeItem} {...fns} />)
  return fns
}

describe('what the row shows', () => {
  it('puts the latest Slack reply on the line', () => {
    renderRow({ lastReplyText: 'PRO# 14556 - Added in BCAT Ops', replyCount: 2 })
    expect(screen.getByText('PRO# 14556 - Added in BCAT Ops')).toBeTruthy()
    expect(screen.getByText('2 replies')).toBeTruthy()
  })

  it('says so when a thread has no replies', () => {
    renderRow({ lastReplyText: '', replyCount: 0 })
    expect(screen.getByText('No replies yet')).toBeTruthy()
    expect(screen.getByText('no thread activity')).toBeTruthy()
  })

  it('ticks an item whose load exists', () => {
    renderRow({ status: 'BUILT' })
    expect(screen.getByLabelText('Done')).toBeTruthy()
  })

  it('ticks an item built but never moved out of NEW', () => {
    // The 317-item case: work finished, status never caught up.
    renderRow({ status: 'NEW', builtLoadId: 'l1' })
    expect(screen.getByLabelText('Done')).toBeTruthy()
  })

  it('shows an empty circle while the work is outstanding', () => {
    renderRow({ status: 'NEW', builtLoadId: null })
    expect(screen.getByLabelText('Not done')).toBeTruthy()
    expect(screen.queryByLabelText('Done')).toBeNull()
  })

  it('shows the PRO once one is known', () => {
    renderRow({ proNumber: '14556' })
    expect(screen.getByText(/PRO 14556/)).toBeTruthy()
  })

  it('links to the Slack thread when there is a permalink', () => {
    renderRow({ externalUrl: 'https://slack.com/archives/C1/p123' })
    expect(screen.getByTitle('Open the Slack thread')).toBeTruthy()
  })
})

describe('whose rows offer Build load', () => {
  it('offers it for an Ivan tender, which is built in BCAT Ops', () => {
    renderRow({ source: 'IVAN_CARTAGE', builtLoadId: null })
    expect(screen.getByText('Build load')).toBeTruthy()
  })

  it('does not offer it for a BCAT Logistics tender', () => {
    // Those are built in the brokerage's own system; the row exists to track the thread.
    renderRow({ source: 'BCAT_LOGISTICS', builtLoadId: null })
    expect(screen.queryByText('Build load')).toBeNull()
  })

  it('still lets a BCAT item with a load open it', () => {
    const fns = renderRow({ source: 'BCAT_LOGISTICS', builtLoadId: 'l1' })
    fireEvent.click(screen.getByText('Open load'))
    expect(fns.onUpdateLoad).toHaveBeenCalled()
  })

  it('leaves Done available on a BCAT row that has no Build load', () => {
    // Removing the build button must not remove the only way to close the item out.
    const fns = renderRow({ source: 'BCAT_LOGISTICS', status: 'NEW', builtLoadId: null })
    // 'Done' also names an option in the status select, so match the button itself.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(fns.onMarkDone).toHaveBeenCalled()
  })
})

describe('acting on a row', () => {
  it('offers Build load for an item with no load, and Open load once there is one', () => {
    const a = renderRow({ builtLoadId: null })
    fireEvent.click(screen.getByText('Build load'))
    expect(a.onBuildLoad).toHaveBeenCalled()

    const b = renderRow({ builtLoadId: 'l1' })
    fireEvent.click(screen.getByText('Open load'))
    expect(b.onUpdateLoad).toHaveBeenCalled()
  })

  it('changes status in place, which is what a 200-row list needs', () => {
    const fns = renderRow({ status: 'NEW' })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'IN_PROGRESS' } })
    expect(fns.onStatusChange).toHaveBeenCalledWith('t1', 'IN_PROGRESS')
  })

  it('offers the Done button only while the item is outstanding', () => {
    // Scoped to the button: "Done" is also one of the status options in the select.
    const fns = renderRow({ status: 'NEW', builtLoadId: null })
    const done = screen.getByRole('button', { name: 'Done' })
    fireEvent.click(done)
    expect(fns.onMarkDone).toHaveBeenCalled()
  })

  it('drops the Done button once the load exists', () => {
    renderRow({ status: 'BUILT', builtLoadId: 'l1' })
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })
})
