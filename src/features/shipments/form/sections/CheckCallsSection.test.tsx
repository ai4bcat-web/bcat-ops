// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CheckCallsSection } from './CheckCallsSection'
import { emptyCheckCall, emptyValues } from '../model'
import { encodeCheckCallNote } from '../checkCallNote'
import type { CheckCallDraft } from '../sectionProps'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

const listCheckCallsByLoad = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ listCheckCallsByLoad }))

beforeEach(() => { listCheckCallsByLoad.mockReset(); listCheckCallsByLoad.mockResolvedValue([]) })

function setup(draft: Partial<CheckCallDraft> = {}, saved = true) {
  const onChange = vi.fn()
  const v = emptyValues()
  v.carrier.originCity = 'Joliet'
  v.carrier.originState = 'IL'
  const ctx = makeCtx(saved ? { mode: 'edit', bundle: savedBundle() } : {})
  render(<CheckCallsSection value={{ ...emptyCheckCall(), ...draft }} onChange={onChange} ctx={ctx} form={makeForm(v)} />)
  return { ctx, onChange }
}

const add = () => screen.getByTestId('f-checkCalls-add') as HTMLButtonElement

describe('CheckCallsSection', () => {
  it('cannot add a call before the first save', () => {
    setup({}, false)
    expect(add().disabled).toBe(true)
    expect(screen.getByTestId('checkcall-block').textContent).toBe('Save the draft first')
  })

  it('refuses a future date-time without calling the action', async () => {
    const { ctx } = setup({ at: '2999-01-01T10:00' })
    fireEvent.click(add())
    expect((await screen.findByTestId('checkcall-error')).textContent).toBe('A check call cannot be logged in the future')
    expect(ctx.actions.addCheckCall).not.toHaveBeenCalled()
  })

  it('logs the call with the carrier origin as the default place, then clears the row', async () => {
    const { ctx, onChange } = setup({ message: 'ON_TIME', temperature: '34', ediReason: 'NS' })
    fireEvent.click(add())
    await waitFor(() => expect(ctx.actions.addCheckCall).toHaveBeenCalledTimes(1))
    expect(ctx.actions.addCheckCall).toHaveBeenCalledWith(expect.objectContaining({ city: 'Joliet', state: 'IL', message: 'ON_TIME', temperature: '34' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(emptyCheckCall()))
  })

  it('keeps the draft and shows the reason when the log is refused', async () => {
    const { ctx, onChange } = setup({ message: 'LATE' })
    ctx.actions.addCheckCall.mockRejectedValueOnce(new Error('Load is canceled'))
    fireEvent.click(add())
    expect((await screen.findByTestId('checkcall-error')).textContent).toBe('Load is canceled')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('decodes message, EDI reason and temperature out of the note, and leaves legacy notes alone', async () => {
    listCheckCallsByLoad.mockResolvedValue([
      { id: 'a', at: '2026-01-02T10:00:00.000Z', type: 'LOCATION_UPDATE', city: 'Joliet', state: 'IL', createdBy: 'x', note: encodeCheckCallNote({ message: 'ON_TIME', ediReason: 'NS', temperature: 34, unit: 'F', note: 'rolling' }) },
      { id: 'b', at: '2026-01-01T10:00:00.000Z', type: 'TRACKING_PING', createdBy: 'system', note: 'plain legacy note' },
    ])
    setup()
    const rows = await screen.findAllByTestId('checkcall-row')
    const first = within(rows[0]).getAllByRole('cell').map((c) => c.textContent)
    expect(first.slice(0, 7)).toEqual(['Joliet', 'IL', 'NORMAL STATUS - NS', '34°F', 'rolling', 'x', 'On Time'])
    const second = within(rows[1]).getAllByRole('cell').map((c) => c.textContent)
    expect(second[4]).toBe('plain legacy note')
    expect(second[6]).toBe('Tracking Ping')
  })
})
