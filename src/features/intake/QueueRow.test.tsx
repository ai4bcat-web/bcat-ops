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
import { QueueRow, VoidIntakeItemDialog } from './IntakePage'
import { voidNote } from '@/lib/intake'
import type { IntakeItem } from '@/types'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))

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

describe('void', () => {
  const fns = () => ({
    onBuildLoad: vi.fn(), onUpdateLoad: vi.fn(), onMarkDone: vi.fn(),
    onStatusChange: vi.fn(), onAssigneeChange: vi.fn(),
  })

  it('offers Void on any active item and hands the item to the handler', () => {
    const onVoid = vi.fn()
    const item = { ...base, builtLoadId: null } as IntakeItem
    render(<QueueRow item={item} {...fns()} onVoid={onVoid} />)
    fireEvent.click(screen.getByRole('button', { name: /void/i }))
    expect(onVoid).toHaveBeenCalledWith(item)
  })
})

describe('the void dialog', () => {
  const item = { ...base } as IntakeItem

  it('needs a reason', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<VoidIntakeItemDialog item={item} onConfirm={onConfirm} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Void item' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(await screen.findByText('Say why this item is being voided.')).toBeTruthy()
  })

  it('says the built shipment stays active, and only then', () => {
    const { unmount } = render(<VoidIntakeItemDialog item={{ ...item, builtLoadId: 'l1' } as IntakeItem} onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('void-shipment-note').textContent).toMatch(/stays active/)
    unmount()
    render(<VoidIntakeItemDialog item={item} onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByTestId('void-shipment-note')).toBeNull()
  })

  it('confirms with the reason', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<VoidIntakeItemDialog item={item} onConfirm={onConfirm} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate tender' } })
    fireEvent.click(screen.getByRole('button', { name: 'Void item' }))
    expect(onConfirm).toHaveBeenCalledWith('Duplicate tender')
  })
})

describe('what a void writes', () => {
  it('records who, when and why, keeps earlier notes, and never names a shipment field', () => {
    const note = voidNote('earlier note', ' Duplicate ', 'ryne@bcatcorp.com', new Date('2026-11-20T12:00:00Z'))
    expect(note).toBe('VOIDED by ryne@bcatcorp.com on 2026-11-20: Duplicate\nearlier note')
  })
})
