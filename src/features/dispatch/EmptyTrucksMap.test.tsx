// @vitest-environment jsdom
/**
 * The Empty trucks map with the real US map: a numbered, colour-coded pin per truck, the runs
 * and the dashed empty run to the best open load, open loads as diamonds, and selection by
 * click or keyboard.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Driver, Load, Stop } from '@/types'
import type { Equipment } from '@/types/equipment'
import { computeEmptyTrucks } from './emptyTrucks'
import { EmptyTrucksMap, EmptyTrucksLegend } from './EmptyTrucksMap'

const NOW = Date.parse('2026-11-18T18:30:00Z')
const H = 3_600_000
const at = (h: number) => new Date(NOW + h * H).toISOString()
const driver = (id: string, name: string): Driver => ({ id, name, phone: '+15555550100', active: true, fleetGroup: 'LOCAL', assignedTruckId: null }) as Driver
const stop = (o: Partial<Stop> & { id: string; type: Stop['type']; sequence: number }) => o as Stop
const loadOf = (o: Record<string, unknown>) => ({ readyToInvoice: false, status: 'DISPATCHED', revDivision: 'ASSETS', updatedAt: at(-1), ...o }) as unknown as Load

const loads = [
  loadOf({ id: 'L1', aljexId: '20012', shipmentId: 'S1', stops: [
    stop({ id: 'a', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: at(-4), driverId: 'd1' }),
    stop({ id: 'b', type: 'delivery', sequence: 1, city: 'Chicago, IL', appt: at(5), driverId: 'd1' }),
  ] }),
  loadOf({ id: 'L2', aljexId: '20013', shipmentId: 'S2', stops: [
    stop({ id: 'c', type: 'pickup', sequence: 0, city: 'Toledo, OH', appt: at(40), driverId: 'd2' }),
    stop({ id: 'd', type: 'delivery', sequence: 1, city: 'Dallas, TX', appt: at(24 * 6), driverId: 'd2' }),
  ] }),
  loadOf({ id: 'O1', aljexId: '20033', shipmentId: 'S3', status: 'SOURCING', customer: 'Acme Foods', rate: 180_000, stops: [
    stop({ id: 'o', type: 'pickup', sequence: 0, city: 'Elgin, IL', appt: at(20) }),
    stop({ id: 'p', type: 'delivery', sequence: 1, city: 'Dallas, TX', appt: at(40) }),
  ] }),
]
const result = computeEmptyTrucks({
  drivers: [driver('d1', 'Joshua Kly'), driver('d2', 'Pat Lund')], loads, equipment: [] as Equipment[], now: NOW, horizonDays: 7, dailyValueCents: null, canSeeMoney: true,
})

describe('EmptyTrucksMap', () => {
  it('draws a numbered pin per truck once the map has loaded, each with its driver, place and urgency', async () => {
    render(<EmptyTrucksMap rows={result.rows} openLoads={result.openLoads} now={NOW} selectedKey={null} onSelect={() => undefined} />)
    const first = await screen.findByTestId(`map-pin-${result.rows[0].key}`, undefined, { timeout: 4000 })
    expect(first.getAttribute('aria-label')).toMatch(/^1\. Joshua Kly .*Chicago, IL/)
    expect(first.getAttribute('aria-label')).toMatch(/Within a day/)
    const second = screen.getByTestId(`map-pin-${result.rows[1].key}`)
    expect(second.getAttribute('aria-label')).toMatch(/^2\. Pat Lund/)
  })

  it('selects a truck from its pin by click and by keyboard, and marks the selected one pressed', async () => {
    const onSelect = vi.fn()
    const { rerender } = render(<EmptyTrucksMap rows={result.rows} openLoads={result.openLoads} now={NOW} selectedKey={null} onSelect={onSelect} />)
    const pin = await screen.findByTestId(`map-pin-${result.rows[0].key}`, undefined, { timeout: 4000 })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pin)
    fireEvent.keyDown(pin, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenCalledWith(result.rows[0].key)
    rerender(<EmptyTrucksMap rows={result.rows} openLoads={result.openLoads} now={NOW} selectedKey={result.rows[0].key} onSelect={onSelect} />)
    expect(screen.getByTestId(`map-pin-${result.rows[0].key}`).getAttribute('aria-pressed')).toBe('true')
  })

  it('draws the run just done and the dashed empty run to the best open load', async () => {
    const { container } = render(<EmptyTrucksMap rows={result.rows} openLoads={result.openLoads} now={NOW} selectedKey={result.rows[0].key} onSelect={() => undefined} />)
    await screen.findByTestId(`map-pin-${result.rows[0].key}`, undefined, { timeout: 4000 })
    // The empty run to Elgin is short: green.
    await waitFor(() => expect(container.querySelectorAll('path[stroke-dasharray]').length).toBeGreaterThan(0))
    expect(container.querySelector('path[stroke="var(--tms-badge-green)"]')).not.toBeNull()
    // The open load is a diamond with a tooltip.
    expect(container.innerHTML).toContain('Open load PRO 20033')
  })

  it('says so when there is nothing to plot', async () => {
    render(<EmptyTrucksMap rows={[]} openLoads={[]} now={NOW} selectedKey={null} onSelect={() => undefined} />)
    expect(await screen.findByText('Nothing to plot yet', undefined, { timeout: 4000 })).toBeTruthy()
  })
})

describe('EmptyTrucksLegend', () => {
  it('names the pin colours and the three empty-run colours, and the open load marker only when there are open loads', () => {
    const { rerender } = render(<EmptyTrucksLegend hasOpenLoads />)
    for (const t of ['Empty now', 'Within a day', 'This week', 'Later', 'Empty run up to 75 mi', 'Up to 150 mi', 'Over 150 mi', 'Open load']) expect(screen.getByText(t)).toBeTruthy()
    rerender(<EmptyTrucksLegend hasOpenLoads={false} />)
    expect(screen.queryByText('Open load')).toBeNull()
  })
})
