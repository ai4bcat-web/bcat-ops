// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CarrierStatusDialog } from './CarrierStatusDialog'
import type { CarrierRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const carrier = (over: Partial<CarrierRecord>) => ({ id: 'c', name: 'Swift', status: 'PENDING', ...over }) as CarrierRecord
const options = () => screen.getAllByRole('option').map((o) => o.textContent)

describe('CarrierStatusDialog: Active belongs to MyCarrierPackets', () => {
  it('does not offer Active by hand until MyCarrierPackets reports the packet complete', () => {
    render(<CarrierStatusDialog carrier={carrier({ mcpStatus: 'INVITED' })} isAdmin onClose={vi.fn()} onConfirm={vi.fn()} />)
    expect(options()).not.toContain('Active')
    expect(screen.getByTestId('active-by-mcp')).toBeTruthy()
  })

  it('offers Active once the packet is complete', () => {
    render(<CarrierStatusDialog carrier={carrier({ mcpStatus: 'ACCEPTABLE' })} isAdmin onClose={vi.fn()} onConfirm={vi.fn()} />)
    expect(options()).toContain('Active')
    expect(screen.queryByTestId('active-by-mcp')).toBeNull()
  })

  it('keeps the hand move for a carrier imported from Aljex', () => {
    render(<CarrierStatusDialog carrier={carrier({ legacyImported: true })} isAdmin onClose={vi.fn()} onConfirm={vi.fn()} />)
    expect(options()).toContain('Active')
  })
})
