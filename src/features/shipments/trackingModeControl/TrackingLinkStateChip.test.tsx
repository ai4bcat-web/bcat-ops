// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as api from '@/lib/apiClient'
import { rowLinkSent, trackingLinkStage } from '@/lib/trackingLinkState'
import { TrackingLinkStateChip } from './TrackingLinkStateChip'

vi.mock('@/lib/apiClient', () => ({ listTrackingLinksByShipment: vi.fn() }))

const link = (over: Record<string, unknown> = {}) => ({ id: 't1', kind: 'CARRIER_PING', shipmentId: 's1', loadCarrierId: 'lc1', status: 'ACTIVE', sentAt: '2026-11-11T14:00:00Z', ...over }) as never

beforeEach(() => vi.clearAllMocks())

describe('trackingLinkStage / rowLinkSent', () => {
  it('reads not sent, sent and accepted from the link', () => {
    expect(trackingLinkStage(null)).toBe('NOT_SENT')
    expect(trackingLinkStage({ consentAt: null })).toBe('SENT')
    expect(trackingLinkStage({ consentAt: '2026-11-11T14:05:00Z' })).toBe('ACCEPTED')
  })
  it('a board row has a link out only while it was started and not stopped after', () => {
    expect(rowLinkSent({})).toBe(false)
    expect(rowLinkSent({ trackingStartedAt: '2026-11-11T14:00:00Z' })).toBe(true)
    expect(rowLinkSent({ trackingStartedAt: '2026-11-11T14:00:00Z', trackingStoppedAt: '2026-11-11T15:00:00Z' })).toBe(false)
    expect(rowLinkSent({ trackingStartedAt: '2026-11-11T16:00:00Z', trackingStoppedAt: '2026-11-11T15:00:00Z' })).toBe(true)
  })
})

describe('TrackingLinkStateChip', () => {
  const show = (props: Partial<Parameters<typeof TrackingLinkStateChip>[0]> = {}) => render(<TrackingLinkStateChip shipmentId="s1" loadCarrierId="lc1" hasCarrier revDivision="BROKERAGE" {...props} />)

  it.each([
    [[], 'NOT_SENT', 'Tracking link not sent'],
    [[link()], 'SENT', 'Tracking link sent, waiting for the driver'],
    [[link({ consentAt: '2026-11-11T14:05:00Z' })], 'ACCEPTED', 'Driver accepted the link'],
  ])('shows the stage of the link', async (links, stage, text) => {
    vi.mocked(api.listTrackingLinksByShipment).mockResolvedValue(links as never)
    show()
    const chip = await screen.findByTestId('tracking-link-stage')
    expect(chip).toHaveAttribute('data-stage', stage)
    expect(chip).toHaveTextContent(text)
  })

  it('ignores a revoked link and another carrier\'s link', async () => {
    vi.mocked(api.listTrackingLinksByShipment).mockResolvedValue([link({ status: 'REVOKED', consentAt: 'x' }), link({ loadCarrierId: 'other', consentAt: 'x' })] as never)
    show()
    expect(await screen.findByTestId('tracking-link-stage')).toHaveAttribute('data-stage', 'NOT_SENT')
  })

  it('shows nothing with no carrier, or on any non-Brokerage load', async () => {
    vi.mocked(api.listTrackingLinksByShipment).mockResolvedValue([])
    const a = show({ hasCarrier: false })
    const b = show({ revDivision: 'ASSETS' })
    const c = show({ revDivision: 'CAR_SHIPPING' })
    await waitFor(() => expect(api.listTrackingLinksByShipment).not.toHaveBeenCalled())
    expect(a.container).toBeEmptyDOMElement()
    expect(b.container).toBeEmptyDOMElement()
    expect(c.container).toBeEmptyDOMElement()
  })
})
