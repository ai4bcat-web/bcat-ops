// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { FlowDefaultsValue } from './FlowDefaultsCard'
import { FlowDefaultsCard } from './FlowDefaultsCard'
import type { TmsSettings } from '@/types/tms'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const TEAMS = [{ key: 'DESK_A', name: 'Desk A', memberIds: [] }, { key: 'DESK_B', name: 'Desk B', memberIds: [] }]

vi.mock('@/components/RepPicker', () => ({
  RepPicker: ({ value, onChange, placeholder }: {
    value: string | null
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <select
      data-testid="rep-picker"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? 'Pick a person…'}</option>
      <option value="rep-1">Rep One</option>
      <option value="rep-2">Rep Two</option>
    </select>
  ),
  TeamPicker: ({ value, onChange, placeholder, teams }: {
    value: string | null
    onChange: (v: string) => void
    placeholder?: string
    teams?: { key: string; name: string }[]
  }) => (
    <select
      data-testid="team-picker"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? 'No team'}</option>
      {(teams ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
    </select>
  ),
}))

function baseSettings(overrides?: Partial<TmsSettings>): TmsSettings {
  return {
    id: 'default',
    teams: TEAMS,
    marginTargetBps: 2000,
    marginTargetBpsByMode: { FTL: 2200, LTL: 2500 },
    marginFloorBps: 500,
    quoteAutoReplyDefault: true,
    defaultRequiredLoadFields: ['pickupAddress', 'deliveryAddress', 'billTo', 'salesRep', 'revenueDivision'],
    defaultCheckCallPlan: {
      intervalHours: 4,
      channels: ['SMS', 'EMAIL'],
      milestones: ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED'],
      escalateAfterMinutes: 30,
      emailDispatcher: true,
      requestPodOnDelivery: true,
    },
    ...overrides,
  } as TmsSettings
}

function baseValue(overrides?: Partial<FlowDefaultsValue>): FlowDefaultsValue {
  return {
    defaultCarrierTeamKey: '',
    defaultCarrierRepId: '',
    marginTargetBps: null,
    marginFloorBps: null,
    quoteAutoReply: null,
    requiredLoadFields: [],
    checkCallPlan: null,
    ...overrides,
  }
}

describe('FlowDefaultsCard', () => {
  it('shows the org value as the placeholder when the customer has no override', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings()} onChange={() => {}} />)
    const targetInput = screen.getByLabelText('Target margin %') as HTMLInputElement
    const floorInput = screen.getByLabelText('Floor margin %') as HTMLInputElement
    expect(targetInput.placeholder).toBe('20.00')
    expect(floorInput.placeholder).toBe('5.00')
    expect(screen.getAllByText('Org default').length).toBeGreaterThanOrEqual(1)
  })

  it('uses a customer override in place of the org default', () => {
    render(
      <FlowDefaultsCard
        value={baseValue({ marginTargetBps: 3000, marginFloorBps: 1000, quoteAutoReply: false })}
        settings={baseSettings()}
        onChange={() => {}}
      />,
    )
    expect((screen.getByLabelText('Target margin %') as HTMLInputElement).value).toBe('30.00')
    expect((screen.getByLabelText('Floor margin %') as HTMLInputElement).value).toBe('10.00')
    expect((screen.getByLabelText('Quote reply') as HTMLSelectElement).value).toBe('manual')
  })

  it('checks and disables the org five required fields, and labels them org default', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings()} onChange={() => {}} />)
    const pickup = screen.getByRole('checkbox', { name: /Pickup address/i }) as HTMLInputElement
    const delivery = screen.getByRole('checkbox', { name: /Delivery address/i }) as HTMLInputElement
    expect(pickup.checked).toBe(true)
    expect(pickup.disabled).toBe(true)
    expect(delivery.checked).toBe(true)
    expect(delivery.disabled).toBe(true)
    // The "org default" hint appears next to every one of the five.
    expect(screen.getAllByText('(org default)').length).toBe(5)
  })

  it('shows VOICE greyed out with the deferred-channel reason', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings()} onChange={() => {}} />)
    const voice = screen.getByRole('checkbox', { name: /VOICE/i }) as HTMLInputElement
    expect(voice.disabled).toBe(true)
    expect(voice.checked).toBe(false)
    expect(screen.getByText(/voice is not switched on yet/i)).toBeTruthy()
  })

  it('shows a per-mode org margin when previewing an LTL customer', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings()} onChange={() => {}} />)
    const preview = screen.getByTestId('preview-mode') as HTMLSelectElement
    fireEvent.change(preview, { target: { value: 'LTL' } })
    expect((screen.getByLabelText('Target margin %') as HTMLInputElement).placeholder).toBe('25.00')
    expect(screen.getByText('Org default for LTL')).toBeTruthy()
  })

  it('shows the org default source for the check-call plan when the customer has no override', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings()} onChange={() => {}} />)
    expect(screen.getByTestId('check-call-source')).toHaveTextContent('Org default')
  })

  it('shows the customer override source for the check-call plan and can clear it', () => {
    let next: Partial<FlowDefaultsValue> | null = null
    render(
      <FlowDefaultsCard
        value={baseValue({ checkCallPlan: { ...baseSettings().defaultCheckCallPlan, intervalHours: 6 } })}
        settings={baseSettings()}
        onChange={(patch) => { next = patch }}
      />,
    )
    expect(screen.getByTestId('check-call-source')).toHaveTextContent('Customer override')
    fireEvent.click(screen.getByTestId('clear-check-call'))
    expect(next).toEqual({ checkCallPlan: null })
  })

  it('shows a blank interval field as inheritance, not zero', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings()} onChange={() => {}} />)
    const input = screen.getByLabelText('Interval (hours)') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('4')
  })

  it('shows a built-in default source when the org has no check-call plan', () => {
    render(<FlowDefaultsCard value={baseValue()} settings={baseSettings({ defaultCheckCallPlan: null })} onChange={() => {}} />)
    expect(screen.getByTestId('check-call-source')).toHaveTextContent('Built-in default')
  })
})
