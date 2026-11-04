// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'
import { TrackingPrefsPopover } from './TrackingPrefsPopover'

const setTrackingPrefs = vi.hoisted(() => vi.fn(async () => ({ shipment: {} })))
vi.mock('@/lib/apiClient', () => ({ setTrackingPrefs }))

const shipment = (trackingPrefs: unknown = null) => ({ id: 'S1', trackingPrefs } as unknown as ShipmentRecord)
const customer = { id: 'c1', trackingMode: 'AGENT', trackingMethod: 'BOTH' } as unknown as CustomerRecord

function open() {
  fireEvent.click(screen.getByTestId('tracking-prefs-button'))
}

describe('TrackingPrefsPopover', () => {
  it('says what is in force: the customer value when inheriting, the pin when overridden', () => {
    const { rerender } = render(<TrackingPrefsPopover shipment={shipment()} customer={customer} onSaved={vi.fn()} />)
    expect(screen.getByTestId('tracking-prefs-button')).toHaveTextContent('Agent · Both')
    expect(screen.queryByTestId('tracking-prefs-dot')).not.toBeInTheDocument()
    rerender(<TrackingPrefsPopover shipment={shipment({ mode: 'MANUAL', method: 'SMS' })} customer={customer} onSaved={vi.fn()} />)
    expect(screen.getByTestId('tracking-prefs-button')).toHaveTextContent('Manual · SMS')
    expect(screen.getByTestId('tracking-prefs-dot')).toBeInTheDocument()
  })

  it('labels the inherit option with the customer value', () => {
    render(<TrackingPrefsPopover shipment={shipment()} customer={customer} onSaved={vi.fn()} />)
    open()
    expect(screen.getByRole('option', { name: 'Inherit (AI agent tracking)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Inherit (Both)' })).toBeInTheDocument()
  })

  it('saves only the pinned keys, then tells the owner', async () => {
    const onSaved = vi.fn()
    render(<TrackingPrefsPopover shipment={shipment()} customer={customer} onSaved={onSaved} />)
    open()
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'EMAIL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setTrackingPrefs).toHaveBeenLastCalledWith({ shipmentId: 'S1', prefs: { method: 'EMAIL' } })
  })

  it('clearing every pin saves null (inherit everything)', async () => {
    const onSaved = vi.fn()
    render(<TrackingPrefsPopover shipment={shipment({ mode: 'MANUAL' })} customer={customer} onSaved={onSaved} />)
    open()
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setTrackingPrefs).toHaveBeenLastCalledWith({ shipmentId: 'S1', prefs: null })
  })
})
