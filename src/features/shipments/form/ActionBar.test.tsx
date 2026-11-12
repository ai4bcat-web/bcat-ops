// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActionBar, type ActionBarProps } from './ActionBar'
import { saveStateText } from './saveState'

const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const base: ActionBarProps = {
  createMode: true, status: 'NEW', dirty: false, savedAt: null, done: 6, total: 8, ready: false, busy: false, voided: false, onRun: vi.fn(), onDiscard: vi.fn(),
}
const show = (o: Partial<ActionBarProps> = {}) => render(<ActionBar {...base} {...o} />)

describe('saveStateText', () => {
  it('unsaved wins, then relative last-saved, else not saved yet', () => {
    expect(saveStateText(true, '2026-11-05T11:00:00.000Z', NOW)).toBe('Unsaved changes')
    expect(saveStateText(false, '2026-11-05T11:55:00.000Z', NOW)).toBe('Last saved 5m ago')
    expect(saveStateText(false, null, NOW)).toBe('Not saved yet')
  })
})

describe('ActionBar', () => {
  it('create: Draft chip, Cancel, Save draft, Create shipment, and the required count', () => {
    const onRun = vi.fn(); const onDiscard = vi.fn()
    show({ onRun, onDiscard })
    expect(screen.getByTestId('ship-form-status').textContent).toBe('Draft')
    expect(screen.getByTestId('ship-form-required').textContent).toBe('6 / 8 required')
    expect(screen.getByTestId('ship-form-cancel').textContent).toBe('Cancel')
    fireEvent.click(screen.getByTestId('ship-form-save-draft')); expect(onRun).toHaveBeenCalledWith('draft')
    fireEvent.click(screen.getByTestId('ship-form-create')); expect(onRun).toHaveBeenCalledWith('create')
    fireEvent.click(screen.getByTestId('ship-form-cancel')); expect(onDiscard).toHaveBeenCalled()
    expect(screen.queryByTestId('ship-form-save')).toBeNull()
  })
  it('edit a DRAFT: Save changes, Submit order, Discard; a submitted order has neither Save draft nor Submit', () => {
    const onRun = vi.fn()
    const { unmount } = show({ createMode: false, status: 'DRAFT', onRun })
    expect(screen.getByTestId('ship-form-cancel').textContent).toBe('Discard')
    fireEvent.click(screen.getByTestId('ship-form-save')); expect(onRun).toHaveBeenCalledWith('save')
    fireEvent.click(screen.getByTestId('ship-form-submit')); expect(onRun).toHaveBeenCalledWith('submit')
    unmount()
    show({ createMode: false, status: 'OPEN' })
    expect(screen.getByTestId('ship-form-status').textContent).toBe('OPEN')
    expect(screen.queryByTestId('ship-form-save-draft')).toBeNull()
    expect(screen.queryByTestId('ship-form-submit')).toBeNull()
  })
  it('shows saved / unsaved state and goes green when ready', () => {
    show({ dirty: true, ready: true, done: 8 })
    expect(screen.getByTestId('ship-form-savestate').textContent).toBe('Unsaved changes')
    expect(screen.getByTestId('ship-form-required').dataset.ready).toBe('true')
  })
  it('the required count scrolls the rail checklist into view and focuses the first missing row', () => {
    render(<><div data-testid="rail-required"><button data-done="true">a</button><button data-done="false" data-testid="miss">b</button></div><ActionBar {...base} /></>)
    const el = screen.getByTestId('rail-required'); el.scrollIntoView = vi.fn()
    fireEvent.click(screen.getByTestId('ship-form-required'))
    expect(el.scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('miss'))
  })
  it('busy or voided disables the run buttons', () => {
    show({ busy: true })
    expect((screen.getByTestId('ship-form-create') as HTMLButtonElement).disabled).toBe(true)
  })
  it('edit: Save & exit sits beside Save changes; a create form has none', () => {
    const onSaveExit = vi.fn(); const onRun = vi.fn()
    const { unmount } = show({ createMode: false, status: 'OPEN', onRun, onSaveExit })
    fireEvent.click(screen.getByTestId('ship-form-save-exit'))
    expect(onSaveExit).toHaveBeenCalledTimes(1)
    expect(onRun).not.toHaveBeenCalled()
    unmount()
    show({ createMode: true, onSaveExit })
    expect(screen.queryByTestId('ship-form-save-exit')).toBeNull()
  })

  it('edit: Push to Load Review shows only when offered, and calls the handler', () => {
    const onPushToReview = vi.fn()
    const { unmount } = show({ createMode: false, status: 'DELIVERED' })
    expect(screen.queryByTestId('ship-form-push-review')).toBeNull()
    unmount()
    show({ createMode: false, status: 'DELIVERED', onPushToReview })
    fireEvent.click(screen.getByTestId('ship-form-push-review'))
    expect(onPushToReview).toHaveBeenCalledTimes(1)
  })
  it('create mode never offers Push to Load Review', () => {
    show({ onPushToReview: vi.fn() })
    expect(screen.queryByTestId('ship-form-push-review')).toBeNull()
  })
})
