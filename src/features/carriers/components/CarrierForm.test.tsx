// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { CarrierForm } from './CarrierForm'
import { carrierFormFrom, carrierFormInput, type CarrierFormValue, type CarrierPatch } from './carrierFormModel'
import type { CarrierRecord, TmsSettings, UserProfileRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// The owner and team fields are pickers now: one reads the staff directory, the other
// the teams on the org settings.
const staff = vi.hoisted(() => [
  {
    id: 'dana@bcatcorp.com', email: 'dana@bcatcorp.com', name: 'Dana Carr', role: 'CARRIER_REP',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1,
  },
] as UserProfileRecord[])
const settings = vi.hoisted(() => ({
  id: 'default',
  teams: [{ key: 'DESK_1', name: 'Desk One', memberIds: [] }],
} as TmsSettings))
vi.mock('@/lib/apiClient', () => ({
  listUserProfiles: vi.fn(async () => staff),
  getTmsSettings: vi.fn(async () => settings),
}))

/** Free text typed before there were profiles, exactly as a record still holds it. */
const carrier = {
  id: 'car-1', name: 'Reliable Freight', type: 'TL', status: 'ACTIVE',
  accountOwnerIds: ['legacy.rep@nowhere.test'], teamKey: 'DESK_1',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as CarrierRecord

function Harness({ onSave }: { onSave: (patch: CarrierPatch) => void }) {
  const [value, setValue] = useState<CarrierFormValue>(() => carrierFormFrom(carrier))
  return (
    <>
      <CarrierForm
        value={value}
        set={(key, next) => setValue((prev) => ({ ...prev, [key]: next }))}
        section="identity"
      />
      <button type="button" onClick={() => onSave(carrierFormInput(value, []))}>Save carrier</button>
    </>
  )
}

describe('CarrierForm identity', () => {
  it('prints the free-text owner, flags it, and saves it untouched', async () => {
    const onSave = vi.fn()
    render(<Harness onSave={onSave} />)

    expect(await screen.findByText('legacy.rep@nowhere.test')).toBeTruthy()
    expect(screen.getByText('not a user')).toBeTruthy()
    expect(screen.getByText('Desk One')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save carrier' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      accountOwnerIds: ['legacy.rep@nowhere.test'],
      teamKey: 'DESK_1',
    }))
  })

  it('adds a picked rep’s username to the owners it saves', async () => {
    const onSave = vi.fn()
    render(<Harness onSave={onSave} />)

    fireEvent.click(await screen.findByText('Add an account owner…'))
    fireEvent.click(await screen.findByRole('option', { name: /Dana Carr/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Save carrier' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      accountOwnerIds: ['legacy.rep@nowhere.test', 'dana@bcatcorp.com'],
    }))
  })
})
