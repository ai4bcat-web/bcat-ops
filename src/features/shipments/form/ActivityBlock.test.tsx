// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditLogEntry } from '@/types'
import type { IntakeLoadRecord } from '@/types/intake'
import type { ShipmentBundle, UserProfileRecord } from '@/types/tms'

const listAuditLogsFor = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ listAuditLogsFor }))

import { invalidateLists } from '@/lib/listCache'
import { ActivityBlock } from './ActivityBlock'
import { emptyValues } from './model'
import { requiredRows, railSummary } from './railModel'
import { makeCtx } from './sections/sectionTestKit'
import { SummaryRail } from './SummaryRail'

const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const entry = (n: number, over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: `a${n}`, entityType: 'SHIPMENT' as AuditLogEntry['entityType'], entityId: 'sh-1', action: 'SAVE_ORDER_FORM' as AuditLogEntry['action'],
  user: 'dee@bcatcorp.com', changes: { equipmentType: { from: 'Dry Van', to: 'Reefer' } } as AuditLogEntry['changes'], createdAt: ago(n), ...over,
})
const staff = [{ id: 'u1', email: 'dee@bcatcorp.com', name: 'Dee Dispatch' }] as unknown as UserProfileRecord[]
const bundle = (over: Record<string, unknown> = {}) => ({
  shipment: { id: 'sh-1', number: 'S1', status: 'OPEN', ...over }, orders: [{ id: 'o-1' }], loads: [{ id: 'l-1' }], loadCarriers: [], charges: [], financials: [], documents: [],
}) as unknown as ShipmentBundle

const mount = (props: Partial<Parameters<typeof ActivityBlock>[0]> = {}) =>
  render(<MemoryRouter><ActivityBlock bundle={bundle()} staff={staff} {...props} /></MemoryRouter>)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  invalidateLists()
  listAuditLogsFor.mockReset()
  listAuditLogsFor.mockResolvedValue([])
})
afterEach(() => { vi.useRealTimers() })

describe('ActivityBlock', () => {
  it('create mode shows only the Draft chip with the stepper at Draft and no audit read', () => {
    mount({ bundle: null })
    expect(screen.getByTestId('rail-stage-chip').textContent).toBe('Draft, not created yet')
    expect(screen.getByTestId('rail-step-DRAFT').getAttribute('data-state')).toBe('current')
    expect(screen.getByTestId('rail-step-PAID').getAttribute('data-state')).toBe('todo')
    expect(screen.getByTestId('rail-activity-empty').textContent).toBe('Activity starts when the shipment is created')
    expect(screen.queryByTestId('rail-activity-history')).toBeNull()
    expect(listAuditLogsFor).not.toHaveBeenCalled()
  })

  it('shows the stage of the shipment, red for voided', async () => {
    mount({ bundle: bundle({ status: 'IN_TRANSIT' }) })
    await waitFor(() => expect(screen.getByTestId('rail-stage-chip').textContent).toBe('In transit'))
    expect(screen.getByTestId('rail-step-COVERED').getAttribute('data-state')).toBe('done')
    expect(screen.getByTestId('rail-step-IN_TRANSIT').getAttribute('data-state')).toBe('current')
  })

  it('a voided shipment is a terminal chip with no stepper', async () => {
    mount({ bundle: bundle({ status: 'DELIVERED', voidedAt: '2026-11-01T00:00:00Z' }) })
    await waitFor(() => expect(screen.getByTestId('rail-stage-chip').getAttribute('data-terminal')).toBe('true'))
    expect(screen.getByTestId('rail-stage-chip').textContent).toBe('Voided')
    expect(screen.queryByTestId('rail-step-DRAFT')).toBeNull()
  })

  it('reads the shipment, order, load and intake item in one call and lists newest first with the display name and field detail', async () => {
    listAuditLogsFor.mockResolvedValue([entry(30), entry(2), entry(10, { user: 'workflow-agent', action: 'SWEEP_STALLED' as AuditLogEntry['action'] })])
    mount({ bundle: bundle({ intakeLoadId: 'in-1' }) })
    const rows = await screen.findAllByTestId('rail-activity-row')
    expect(listAuditLogsFor).toHaveBeenCalledTimes(1)
    const asked = listAuditLogsFor.mock.calls[0]![0] as Array<{ entityType: string; entityId: string }>
    expect(asked.map((e) => e.entityId)).toEqual(expect.arrayContaining(['sh-1', 'o-1', 'l-1', 'in-1']))
    expect(asked).toContainEqual({ entityType: 'INTAKE_LOAD', entityId: 'in-1' })
    expect(rows.map((r) => within(r).getByTestId('rail-activity-actor').textContent)).toEqual(['Dee Dispatch', 'AI agent · Workflow agent', 'Dee Dispatch'])
    expect(rows[0]!.textContent).toContain('2m ago')
    // High level on the row (who, what, when); the field detail is the row's hover.
    expect(within(rows[0]!).queryByTestId('rail-activity-detail')).toBeNull()
    expect(rows[0]!.getAttribute('title')).toBe('was Dry Van')
  })

  it('keeps eight rows, five visible until Show more', async () => {
    listAuditLogsFor.mockResolvedValue(Array.from({ length: 12 }, (_, i) => entry(i + 1)))
    mount()
    expect(await screen.findAllByTestId('rail-activity-row')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('rail-activity-more'))
    expect(screen.getAllByTestId('rail-activity-row')).toHaveLength(8)
  })

  it('Full history links to the audit page filtered to this shipment', () => {
    mount()
    expect(screen.getByTestId('rail-activity-history').getAttribute('href')).toBe('/tms/brokerage/audit?entity=sh-1')
  })

  it('re-reads after a save hands the form a new bundle, and shows the new entry', async () => {
    listAuditLogsFor.mockResolvedValueOnce([entry(30)])
    const { rerender } = mount()
    expect(await screen.findAllByTestId('rail-activity-row')).toHaveLength(1)
    listAuditLogsFor.mockResolvedValueOnce([entry(30), entry(0, { id: 'new', changes: { status: { from: 'OPEN', to: 'BOOKED' } } as AuditLogEntry['changes'] })])
    await act(async () => { rerender(<MemoryRouter><ActivityBlock bundle={bundle({ updatedAt: 'later' })} staff={staff} /></MemoryRouter>) })
    await waitFor(() => expect(screen.getAllByTestId('rail-activity-row')).toHaveLength(2))
    expect(listAuditLogsFor).toHaveBeenCalledTimes(2)
    expect(screen.getAllByTestId('rail-activity-row')[0]!.textContent).not.toContain('status: BOOKED')
  })

  it('an intake pre-fill on create shows the extractor entry', async () => {
    const row = { id: 'in-9', createdAt: ago(4), autoFields: { reference: 'PO1', commodity: 'Steel', weightLb: 0, notes: '', customerCandidates: [{ id: 'c' }] } } as unknown as IntakeLoadRecord
    mount({ bundle: null, intakeId: 'in-9', intake: row })
    const rows = await screen.findAllByTestId('rail-activity-row')
    expect(rows[0]!.textContent).toContain('AI agent · Intake extractor')
    expect(rows[0]!.textContent).toContain('extracted the fields from the e-mail')
    expect(rows[0]!.textContent).not.toContain('fields: 3 fields')
    expect(listAuditLogsFor).toHaveBeenCalledWith([{ entityType: 'INTAKE_LOAD', entityId: 'in-9' }])
  })
})

describe('SummaryRail order', () => {
  it('stacks Summary, Money, Rate history, Required, Activity, Roles', () => {
    const values = emptyValues()
    const ctx = makeCtx()
    const noop = vi.fn()
    const common = { values, update: noop, ctx, form: { getValues: () => values, update: noop, focusField: noop }, issues: [], mode: 'create', locked: ctx.locked } as unknown as Parameters<typeof SummaryRail>[0]['common']
    render(
      <MemoryRouter>
        <SummaryRail
          common={common} summary={railSummary(values, null, null)} rows={requiredRows(values, 'create')} attempted={false} status="NEW"
          busy={false} voided={false} Roles={() => <div data-testid="roles-stub" />} RateHistory={() => <div data-testid="rh-stub" />} onRun={noop} onDiscard={noop}
        />
      </MemoryRouter>,
    )
    const order = [...document.querySelectorAll('[data-testid="rail-money"], [data-testid="rail-rate-history"], [data-testid="rail-required"], [data-testid="rail-activity"], [data-testid="rail-roles"]')].map((n) => n.getAttribute('data-testid'))
    expect(order).toEqual(['rail-money', 'rail-rate-history', 'rail-required', 'rail-activity', 'rail-roles'])
    expect(screen.getByTestId('rail-stage-chip').textContent).toBe('Draft, not created yet')
    // The actions are the page's bottom bar now: nothing action-like is left in the rail.
    expect(screen.queryByTestId('rail-actions')).toBeNull()
    expect(screen.getByTestId('ship-form-rail').querySelector('[data-testid="ship-form-create"], [data-testid="ship-form-save-draft"]')).toBeNull()
  })
})
