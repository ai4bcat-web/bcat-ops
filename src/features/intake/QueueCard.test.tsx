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
