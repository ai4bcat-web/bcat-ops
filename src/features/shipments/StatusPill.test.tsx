// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StatusPill } from './StatusPill'
import type { ShipmentRow } from './shipmentViews'

function row(patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: 's1', number: 'S1', status: 'OPEN', customerId: 'c1', customerName: 'Acme', mode: 'FTL', source: 'MANUAL',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

afterEach(cleanup)

describe('StatusPill', () => {
  it('prints the status with its stop progress in the row tone', () => {
    render(<StatusPill row={row({ status: 'DELIVERED', stops: [
      { departedAt: '2026-01-02T00:00:00Z' }, { departedAt: '2026-01-03T00:00:00Z' },
    ] as ShipmentRow['stops'] })} />)
    const pill = screen.getByTestId('status-pill')
    expect(pill.textContent).toBe('DELIVERED 2/2')
    expect(pill.getAttribute('data-tone')).toBe('delivered')
  })

  it.each([
    ['OPEN', 'open'],
    ['IN_TRANSIT', 'departed'],
    ['DISPATCHED', 'dispatched'],
    ['ON_HOLD', 'hold'],
    ['CANCELED', 'canceled'],
  ] as const)('%s takes the %s row tone', (status, tone) => {
    render(<StatusPill row={row({ status })} />)
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe(tone)
  })

  it('a voided shipment reads VOIDED in the voided tone', () => {
    render(<StatusPill row={row({ voidedAt: '2026-01-05T00:00:00Z' })} />)
    const pill = screen.getByTestId('status-pill')
    expect(pill.textContent).toBe('VOIDED')
    expect(pill.getAttribute('data-tone')).toBe('voided')
  })
})
