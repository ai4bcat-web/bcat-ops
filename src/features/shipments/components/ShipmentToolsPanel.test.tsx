// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShipmentToolsPanel } from './ShipmentToolsPanel'

const ctx = vi.fn(() => ({ bundle: null, loading: true, error: null, cancelDeleteAdminOnly: false, actions: {}, detailProps: {} }))
vi.mock('../useShipmentContext', () => ({ useShipmentContext: (...a: unknown[]) => ctx(...(a as [])) }))
vi.mock('./ShipmentTools', () => ({ ShipmentTools: ({ initialTab }: { initialTab?: string }) => <div data-testid="tools">{initialTab ?? 'default'}</div> }))
vi.mock('./StatusActions', () => ({ ShipmentRowActions: () => null }))

const options = { customers: [], locations: [], settings: null, isAdmin: true, currentUser: 'a@b.c' }
const props = { shipmentId: 'shp-1', options, onChanged: vi.fn(), onDeleted: vi.fn() }

describe('ShipmentToolsPanel', () => {
  it('stays closed, and loads nothing, until it is opened', () => {
    render(<ShipmentToolsPanel {...props} />)
    expect(screen.getByTestId('ship-tools-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(ctx).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('ship-tools-toggle'))
    expect(ctx).toHaveBeenCalled()
  })

  it('opens itself on the tab a link asked for and asks for the locations', () => {
    const onOpen = vi.fn()
    ctx.mockReturnValue({ bundle: {} as never, loading: false, error: null, cancelDeleteAdminOnly: false, actions: { shipment: {} } as never, detailProps: {} as never })
    render(<ShipmentToolsPanel {...props} initialTab="documents" onOpen={onOpen} />)
    expect(screen.getByTestId('tools').textContent).toBe('documents')
    expect(onOpen).toHaveBeenCalled()
  })
})
