// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CrmAccountView, CrmTimelineEntry } from '@/lib/crm/types'
import type { CustomerRecord } from '@/types/tms'
import { CrmStrip } from './CrmStrip'
import { ActivityTab } from './ActivityTab'

vi.mock('@/lib/apiClient', () => ({ crmAction: vi.fn(), graphqlErrorText: () => '' }))

const customer = { id: 'c1', name: 'ZZ Co', status: 'ACTIVE', statusReason: 'FIRST_SHIPMENT', statusChangedAt: '2026-11-02T10:00:00Z' } as CustomerRecord

function view(over: Partial<CrmAccountView> = {}): CrmAccountView {
  return {
    account: { id: 'c1', lastTouchAt: '2026-11-01T12:00:00Z', lastTouchKind: 'CALL', nextStep: 'Call back', nextStepDueAt: '2020-01-01T12:00:00Z' },
    owner: { id: 'dana', name: 'Dana Carr', email: 'dana@x.test' },
    stage: 'ACTIVE',
    contacts: [{ id: 'jane@zz.test', name: 'Jane', origin: 'CRM' }],
    timeline: [],
    openTasks: [],
    domains: [{ id: 'zz.test' }],
    derived: { lastTouchAt: null, lastQuoteAt: null, lastShipmentAt: null },
    visible: true,
    ...over,
  }
}

const strip = (v: CrmAccountView | null, extra: Partial<Parameters<typeof CrmStrip>[0]> = {}) => render(
  <CrmStrip customer={customer} view={v} loading={false} error={null} isManager={false} tone="green"
    onSetNextStep={vi.fn(async () => ({}))} onReleaseDomain={vi.fn(async () => ({}))} {...extra} />,
)

const entry = (over: Partial<CrmTimelineEntry>): CrmTimelineEntry => ({ id: 'e', at: '2026-11-01T12:00:00Z', kind: 'NOTE', ...over })

const tab = (v: CrmAccountView, extra: Partial<Parameters<typeof ActivityTab>[0]> = {}) => render(
  <MemoryRouter>
    <ActivityTab view={v} loading={false} error={null}
      onAddActivity={vi.fn(async () => ({}))} onAddTask={vi.fn(async () => ({}))} onCompleteTask={vi.fn(async () => ({}))} {...extra} />
  </MemoryRouter>,
)

describe('CrmStrip', () => {
  it('shows owner, stage, last touch, overdue next step and the first-shipment promotion', () => {
    strip(view())
    expect(screen.getByTestId('crm-owner').textContent).toContain('Dana Carr')
    expect(screen.getByTestId('crm-stage').textContent).toContain('ACTIVE')
    expect(screen.getByTestId('crm-last-touch').textContent).toContain('Call')
    expect(screen.getByTestId('crm-next-step').getAttribute('data-overdue') ?? screen.getByTestId('crm-next-step').querySelector('[data-overdue]')?.getAttribute('data-overdue')).toBe('true')
    expect(screen.getByTestId('crm-promoted').textContent).toContain('first shipment')
  })

  it('saves an edited next step with its due date as an instant on that day', async () => {
    const onSetNextStep = vi.fn(async () => ({}))
    strip(view(), { onSetNextStep })
    fireEvent.click(screen.getByTestId('crm-next-step-edit'))
    fireEvent.change(screen.getByTestId('crm-next-step-input'), { target: { value: 'Send contract' } })
    fireEvent.change(screen.getByTestId('crm-next-step-due'), { target: { value: '2026-11-10' } })
    fireEvent.click(screen.getByTestId('crm-next-step-save'))
    await waitFor(() => expect(onSetNextStep).toHaveBeenCalledWith('Send contract', '2026-11-10T12:00:00.000Z'))
  })

  it('only managers can remove a domain', () => {
    const { unmount } = strip(view(), { isManager: false })
    expect(screen.queryByTestId('crm-domain-remove-zz.test')).toBeNull()
    unmount()
    strip(view(), { isManager: true })
    expect(screen.getByTestId('crm-domain-remove-zz.test')).toBeTruthy()
  })

  it('an account the viewer may not see shows no CRM detail or edit control', () => {
    strip(view({ visible: false, account: null, owner: null, domains: [] }))
    expect(screen.queryByTestId('crm-next-step-edit')).toBeNull()
    expect(screen.getByTestId('crm-strip').textContent).toContain('owner')
  })
})

describe('ActivityTab', () => {
  it('prints an e-mail subject only when the server returned one', () => {
    tab(view({ timeline: [
      entry({ id: 'a', kind: 'EMAIL_IN', subject: 'Van Chicago to Dallas' }),
      entry({ id: 'b', kind: 'EMAIL_IN', subject: null, restricted: true }),
    ] }))
    expect(screen.getByTestId('crm-timeline-a').textContent).toContain('Van Chicago to Dallas')
    expect(screen.getByTestId('crm-timeline-b').textContent).not.toContain('Van')
    expect(screen.getByTestId('crm-timeline-b').textContent).toContain('E-mail from a contact')
  })

  it('derived quote and shipment rows link to their records', () => {
    tab(view({ timeline: [
      entry({ id: 'q', kind: 'QUOTE_CREATED', derived: true, refs: { quoteId: 'Q-1' } }),
      entry({ id: 's', kind: 'SHIPMENT_CREATED', derived: true, refs: { shipmentId: 'S-1' } }),
    ] }))
    expect(screen.getByTestId('crm-timeline-q').querySelector('a')?.getAttribute('href')).toBe('/tms/rates/Q-1')
    expect(screen.getByTestId('crm-timeline-s').querySelector('a')?.getAttribute('href')).toBe('/tms/shipments/S-1/edit')
  })

  it('kind filters narrow the timeline', () => {
    tab(view({ timeline: [entry({ id: 'n', kind: 'NOTE', summary: 'hello' }), entry({ id: 'e', kind: 'EMAIL_OUT', subject: 'Re: lane' })] }))
    fireEvent.click(screen.getByTestId('crm-filter-email'))
    expect(screen.queryByTestId('crm-timeline-n')).toBeNull()
    expect(screen.getByTestId('crm-timeline-e')).toBeTruthy()
  })

  it('logs a call with the picked contact and clears the composer', async () => {
    const onAddActivity = vi.fn(async () => ({}))
    tab(view(), { onAddActivity })
    fireEvent.click(screen.getByTestId('crm-composer-CALL'))
    fireEvent.change(screen.getByTestId('crm-composer-summary'), { target: { value: 'Quoted verbally' } })
    fireEvent.change(screen.getByTestId('crm-composer-contact'), { target: { value: 'jane@zz.test' } })
    fireEvent.click(screen.getByTestId('crm-composer-submit'))
    await waitFor(() => expect(onAddActivity).toHaveBeenCalledWith({ kind: 'CALL', summary: 'Quoted verbally', at: undefined, contactEmail: 'jane@zz.test' }))
    await waitFor(() => expect((screen.getByTestId('crm-composer-summary') as HTMLTextAreaElement).value).toBe(''))
  })

  it('a task needs a due date; submitting adds it, and an open task can be completed', async () => {
    const onAddTask = vi.fn(async () => ({}))
    const onCompleteTask = vi.fn(async () => ({}))
    tab(view({ openTasks: [{ id: 'act:1', ownerId: 'dana', kind: 'TASK', at: '2026-11-01T00:00:00Z', summary: 'Send W9', dueAt: '2020-01-01T12:00:00Z', createdBy: 'dana' }] }), { onAddTask, onCompleteTask })
    fireEvent.click(screen.getByTestId('crm-composer-TASK'))
    fireEvent.change(screen.getByTestId('crm-composer-summary'), { target: { value: 'Follow up' } })
    expect((screen.getByTestId('crm-composer-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('crm-composer-date'), { target: { value: '2026-11-06' } })
    fireEvent.click(screen.getByTestId('crm-composer-submit'))
    await waitFor(() => expect(onAddTask).toHaveBeenCalledWith({ summary: 'Follow up', dueAt: '2026-11-06T12:00:00.000Z' }))
    fireEvent.click(screen.getByTestId('crm-task-complete-act:1'))
    await waitFor(() => expect(onCompleteTask).toHaveBeenCalledWith('act:1'))
  })

  it('shows a limited-access message instead of the composer for an invisible account', () => {
    tab(view({ visible: false }))
    expect(screen.queryByTestId('crm-composer')).toBeNull()
  })
})
