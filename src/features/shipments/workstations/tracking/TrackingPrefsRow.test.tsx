// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'
import { TrackingPrefsRow } from './TrackingPrefsRow'

const setTrackingPrefs = vi.hoisted(() => vi.fn(async (_i: unknown) => ({ shipment: {} })))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ setTrackingPrefs }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const shipment = (trackingPrefs: unknown = null) => ({ id: 'S1', trackingPrefs } as unknown as ShipmentRecord)
const customer = { id: 'c1', trackingMode: 'AGENT', trackingMethod: 'BOTH' } as unknown as CustomerRecord
const save = () => screen.getByRole('button', { name: /Save|Saving/ })
const reset = () => screen.getByRole('button', { name: 'Reset' })

beforeEach(() => { vi.clearAllMocks() })

describe('TrackingPrefsRow', () => {
  it('is on screen with all three selects and no click, and is never a dialog', () => {
    render(<TrackingPrefsRow shipment={shipment()} customer={customer} onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Mode')).toBeInTheDocument()
    expect(screen.getByLabelText('Method')).toBeInTheDocument()
    expect(screen.getByLabelText('Driver SMS to')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'EMAIL' } })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says what is in force: the customer value when inheriting, the pin when overridden (dot only then)', () => {
    const { rerender } = render(<TrackingPrefsRow shipment={shipment()} customer={customer} onSaved={vi.fn()} />)
    expect(screen.getByTestId('tracking-prefs-effective')).toHaveTextContent('In force: AI agent · E-mail + SMS')
    expect(screen.queryByTestId('tracking-prefs-dot')).not.toBeInTheDocument()
    rerender(<TrackingPrefsRow shipment={shipment({ mode: 'MANUAL', method: 'SMS' })} customer={customer} onSaved={vi.fn()} />)
    expect(screen.getByTestId('tracking-prefs-effective')).toHaveTextContent('In force: Manual · SMS')
    expect(screen.getByTestId('tracking-prefs-dot')).toBeInTheDocument()
  })

  it('labels the inherit option with the customer value', () => {
    render(<TrackingPrefsRow shipment={shipment()} customer={customer} onSaved={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Inherit (AI agent tracking)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Inherit (Both)' })).toBeInTheDocument()
  })

  it('keeps Save and Reset in place but disabled until something changes, and Reset restores the saved values', () => {
    render(<TrackingPrefsRow shipment={shipment({ mode: 'MANUAL' })} customer={customer} onSaved={vi.fn()} />)
    expect(save()).toBeDisabled()
    expect(reset()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'SMS' } })
    expect(save()).toBeEnabled()
    fireEvent.click(reset())
    expect(screen.getByLabelText('Method')).toHaveValue('')
    expect(screen.getByLabelText('Mode')).toHaveValue('MANUAL')
    expect(save()).toBeDisabled()
  })

  it('saves only the pinned keys, then tells the owner', async () => {
    const onSaved = vi.fn()
    render(<TrackingPrefsRow shipment={shipment()} customer={customer} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'EMAIL' } })
    fireEvent.click(save())
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setTrackingPrefs).toHaveBeenLastCalledWith({ shipmentId: 'S1', prefs: { method: 'EMAIL' } })
  })

  it('clearing every pin saves null (inherit everything)', async () => {
    const onSaved = vi.fn()
    render(<TrackingPrefsRow shipment={shipment({ mode: 'MANUAL' })} customer={customer} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: '' } })
    fireEvent.click(save())
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setTrackingPrefs).toHaveBeenLastCalledWith({ shipmentId: 'S1', prefs: null })
  })

  it('a failed save keeps the draft, toasts, and does not tell the owner', async () => {
    setTrackingPrefs.mockRejectedValueOnce(new Error('Version conflict'))
    const onSaved = vi.fn()
    render(<TrackingPrefsRow shipment={shipment()} customer={customer} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'MANUAL' } })
    fireEvent.click(save())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Version conflict'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Mode')).toHaveValue('MANUAL')
    expect(save()).toBeEnabled()
  })
})
