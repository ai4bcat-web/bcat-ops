// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { StopActualTimes } from './StopActualTimes'
import { emptyStop } from '../model'
import type { FormCtx } from '../sectionProps'

const api = vi.hoisted(() => ({ updateStop: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ updateStop: api.updateStop }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const stopRow = (over: Record<string, unknown> = {}) => ({ id: 'stp-1', type: 'pickup', sequence: 0, appt: '2026-11-10T13:00:00Z', ...over })
const bundleOf = (stops: unknown[]) => ({ loads: [{ id: 'ld1', updatedAt: 'u1', stops }] })
const ctxOf = (over: Record<string, unknown> = {}): FormCtx => ({
  mode: 'edit', bundle: bundleOf([stopRow()]), busy: false, locked: { voided: false, stops: {} }, refreshBundle: vi.fn(async () => {}), ...over,
}) as unknown as FormCtx

const show = (ctx: FormCtx, stop = { ...emptyStop('pickup'), id: 'stp-1' }, extra: Partial<Parameters<typeof StopActualTimes>[0]> = {}) => {
  const onChange = vi.fn()
  render(<StopActualTimes stop={stop} ctx={ctx} onChange={onChange} isFinalDelivery={false} disabled={false} {...extra} />)
  return { onChange }
}

beforeEach(() => vi.clearAllMocks())

describe('StopActualTimes', () => {
  it('Now stamps the current time through SET_TIMES, says so, and keeps the form in step with the server', async () => {
    api.updateStop.mockResolvedValue(bundleOf([stopRow({ arrivedAt: '2026-11-11T15:00:00.000Z', arrivedSource: 'MANUAL' })]))
    const ctx = ctxOf()
    const { onChange } = show(ctx)
    fireEvent.click(screen.getByTestId('stop-stp-1-arrived-now'))
    await waitFor(() => expect(api.updateStop).toHaveBeenCalledTimes(1))
    expect(api.updateStop).toHaveBeenCalledWith({ loadId: 'ld1', expectedUpdatedAt: 'u1', op: 'SET_TIMES', stopId: 'stp-1', patch: { arrivedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Arrived time saved'))
    const patch = onChange.mock.calls[0]![0] as (p: ReturnType<typeof emptyStop>) => ReturnType<typeof emptyStop>
    const next = patch(emptyStop('pickup'))
    expect(next.arrivedAt).toBe('2026-11-11T15:00:00.000Z')
    expect(next.extra).toMatchObject({ arrivedSource: 'MANUAL' })
    expect(ctx.refreshBundle).toHaveBeenCalled()
  })

  it('a typed time saves only when Save is pressed, as that Chicago time in UTC', async () => {
    api.updateStop.mockResolvedValue(bundleOf([stopRow({ departedAt: '2026-11-10T20:30:00.000Z' })]))
    show(ctxOf())
    expect(screen.queryByTestId('stop-stp-1-departed-save')).toBeNull()
    fireEvent.change(screen.getByTestId('stop-stp-1-departed'), { target: { value: '2026-11-10T14:30' } })
    expect(api.updateStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('stop-stp-1-departed-save'))
    await waitFor(() => expect(api.updateStop).toHaveBeenCalledWith(expect.objectContaining({ patch: { departedAt: '2026-11-10T20:30:00.000Z' } })))
  })

  it('shows where a time came from, and Delivered on the last delivery', () => {
    const bundle = bundleOf([stopRow({ id: 'stp-9', type: 'delivery', sequence: 1, arrivedAt: '2026-11-10T19:00:00Z', arrivedSource: 'TRACKING_LINK' })])
    show(ctxOf({ bundle }), { ...emptyStop('delivery'), id: 'stp-9', arrivedAt: '2026-11-10T19:00:00Z' }, { isFinalDelivery: true })
    expect(screen.getByTestId('stop-stp-9-arrived-source')).toHaveTextContent('tracking link')
    expect(screen.getByText('Delivered')).toBeInTheDocument()
    expect(screen.queryByText('Departed')).toBeNull()
  })

  it('shows nothing before the shipment is saved, and is disabled on a voided one', () => {
    const { onChange } = show(ctxOf({ mode: 'create', bundle: null }))
    expect(screen.queryByTestId('stop-stp-1-actual')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is disabled while the shipment is voided', () => {
    show(ctxOf({ locked: { voided: true, stops: {} } }))
    expect(screen.getByTestId('stop-stp-1-arrived-now')).toBeDisabled()
    expect(screen.getByTestId('stop-stp-1-arrived')).toBeDisabled()
  })

  it('reports a refused save and leaves the stop as it was', async () => {
    api.updateStop.mockRejectedValue(new Error('A stop cannot be arrived in the future'))
    const { onChange } = show(ctxOf())
    fireEvent.click(screen.getByTestId('stop-stp-1-arrived-now'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A stop cannot be arrived in the future'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
