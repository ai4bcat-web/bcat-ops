// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deliveryPhase, type PhaseInput, type PhaseStop } from '@/lib/deliveryPhase'
import { DeliveryTimeline } from './DeliveryTimeline'

const NOW = Date.parse('2026-11-05T15:00:00.000Z')
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString()
const pu = (o: Partial<PhaseStop> = {}): PhaseStop => ({ type: 'pickup', appt: iso(-10), apptType: 'exact', ...o })
const de = (o: Partial<PhaseStop> = {}): PhaseStop => ({ type: 'delivery', appt: iso(600), apptType: 'exact', ...o })
const show = (o: Partial<PhaseInput> = {}) => render(<DeliveryTimeline result={deliveryPhase({ covered: true, stops: [pu(), de()], nowMs: NOW, ...o })} />)
const label = () => screen.getByTestId('delivery-timeline-svg').getAttribute('aria-label')
const reached = () => ['AT_PICKUP', 'DEPARTED', 'IN_TRANSIT', 'AT_DELIVERY', 'DELIVERED'].filter((k) => screen.getByTestId(`dt-cp-${k}`).getAttribute('data-reached') === 'true')

describe('DeliveryTimeline', () => {
  it('create: Draft, all grey, truck parked left', () => {
    show({ create: true, stops: [], covered: false })
    expect(label()).toBe('Draft')
    expect(screen.getByTestId('delivery-caption').textContent).toBe('Draft')
    expect(reached()).toEqual([])
    expect(screen.getByTestId('delivery-timeline').dataset.tone).toBe('grey')
  })
  it('not covered: "Not dispatched", nothing reached', () => {
    show({ covered: false })
    expect(screen.getByTestId('delivery-caption').textContent).toBe('Not dispatched')
    expect(reached()).toEqual([])
  })
  it('in transit on a four-stop load: summary, caption, reached dots and green segments', () => {
    show({ stops: [pu({ arrivedAt: iso(-100), departedAt: iso(-60) }), pu(), de(), de()] })
    expect(label()).toBe('In transit, stop 2 of 4')
    expect(screen.getByTestId('delivery-caption').textContent).toBe('In transit · Stop 2 of 4')
    expect(reached()).toEqual(['AT_PICKUP', 'DEPARTED', 'IN_TRANSIT'])
    expect(screen.getByTestId('dt-seg-1').getAttribute('data-on')).toBe('true')
    expect(screen.getByTestId('dt-seg-2').getAttribute('data-on')).toBe('false')
    expect(document.querySelector('.tms-dt-motion')).not.toBeNull()
  })
  it('hovering a reached checkpoint names its timestamp; the truck names the last position', () => {
    show({ stops: [pu({ arrivedAt: iso(-100), departedAt: iso(-60) }), de()], lastFix: { at: iso(-5), place: 'Joliet, IL' } })
    expect(screen.getByTestId('dt-cp-AT_PICKUP').querySelector('title')!.textContent).toMatch(/^On site \(pickup\): /)
    expect(screen.getByTestId('dt-cp-AT_DELIVERY').querySelector('title')!.textContent).toBe('On site (delivery): not yet')
    expect(screen.getByTestId('dt-truck').querySelector('title')!.textContent).toMatch(/In transit\nLast position Joliet, IL, /)
  })
  it('late is an amber truck with the reason on hover', () => {
    show({ stops: [pu({ appt: iso(-120) }), de()], status: 'DISPATCHED' })
    expect(screen.getByTestId('dt-truck').dataset.tone).toBe('amber')
    expect(screen.getByTestId('dt-truck').querySelector('title')!.textContent).toMatch(/Past the pickup appointment/)
  })
  it('an open exception is amber too', () => {
    show({ stops: [pu({ arrivedAt: iso(-100), departedAt: iso(-60) }), de()], openIncidents: 1 })
    expect(screen.getByTestId('dt-truck').dataset.tone).toBe('amber')
    expect(screen.getByTestId('dt-truck').querySelector('title')!.textContent).toMatch(/Open exception/)
  })
  it('delivered: everything reached, truck at the end', () => {
    show({ status: 'DELIVERED', deliveredAt: iso(-30) })
    expect(reached()).toHaveLength(5)
    expect(label()).toBe('Delivered')
  })
  it('voided: struck through and red', () => {
    show({ voided: true })
    expect(screen.getByTestId('dt-strike')).toBeTruthy()
    expect(screen.getByTestId('delivery-timeline').dataset.voided).toBe('true')
    expect(label()).toBe('Voided')
  })
  it('the svg is one role=img with a text summary', () => {
    show()
    expect(screen.getByRole('img', { name: /Not dispatched|Heading|Departed|transit|site|Delivered|Draft/ })).toBeTruthy()
  })
})
