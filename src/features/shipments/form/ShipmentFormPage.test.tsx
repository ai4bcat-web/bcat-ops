// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentBundle } from '@/types/tms'
import { LABEL } from './labels'

const h = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  intakeRow: null as unknown,
  linkIntakeShipment: vi.fn(async () => ({})),
  runCreate: vi.fn(),
  runSaveDraft: vi.fn(),
  runEditSave: vi.fn(),
  runSubmit: vi.fn(),
  runUploadQueued: vi.fn(async () => []),
  shipment: { bundle: null as unknown, loading: false, error: null as string | null },
  navigate: vi.fn(),
  useDirectory: vi.fn(),
  listLocations: vi.fn(async () => []),
}))

vi.mock('./pipelines', () => ({
  runCreate: h.runCreate, runSaveDraft: h.runSaveDraft, runEditSave: h.runEditSave,
  runSubmit: h.runSubmit, runUploadQueued: h.runUploadQueued,
}))
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => h.navigate }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn(), info: h.toastInfo } }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'rep@example.invalid' }, isAdmin: false }) }))
vi.mock('@/hooks/useShipment', () => ({
  useShipment: () => ({ ...h.shipment, refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: (opts: unknown) => { h.useDirectory(opts); return { customers: [], locations: [], refresh: vi.fn() } },
}))
vi.mock('@/hooks/useCarriers', () => ({ useCarriers: () => ({ carriers: [] }) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ staff: [] }) }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({ useOwnershipDivisions: () => ({ divisions: null }) }))
vi.mock('@/lib/apiClient', () => ({ getTmsSettings: vi.fn(async () => null), listLocations: h.listLocations, linkIntakeShipment: h.linkIntakeShipment }))
vi.mock('../intake/useIntakeLoads', () => ({ useIntakeLoad: () => ({ row: h.intakeRow, loading: false, error: null, reload: vi.fn(), setRow: vi.fn() }) }))
vi.mock('./useFormActions', () => ({
  useFormActions: (o: { busy: boolean }) => ({ actions: {}, dialogs: null, busy: o.busy }),
}))
vi.mock('./defaultSections', () => {
  const none = () => null
  type P = { values: { ship: { equipmentType: string }; customer: { typedName: string } }; update: (fn: (v: never) => unknown) => void }
  return {
    CARD_COMPONENTS: {
      customer: (p: P) => (
        <input
          data-testid="f-customer-name" value={p.values.customer.typedName}
          onChange={(e) => p.update((v: Record<string, unknown>) => ({ ...v, customer: { ...(v.customer as object), typedName: e.target.value, useTyped: true } }) as never)}
        />
      ),
      route: none,
      freight: (p: P) => (
        <input
          data-testid="f-shipping-equipmentType" value={p.values.ship.equipmentType}
          onChange={(e) => p.update((v: Record<string, unknown>) => ({ ...v, ship: { ...(v.ship as object), equipmentType: e.target.value } }) as never)}
        />
      ),
      rates: none,
      carrier: none,
    },
    MORE_TAB_COMPONENTS: {
      instructions: none, references: none, items: none, notes: none, documents: none, rateHistory: none, checkCalls: none, updates: none,
    },
    RAIL_ROLES: none,
  }
})

import { ShipmentFormPage } from './ShipmentFormPage'

const CUSTOMER_TESTID = LABEL.customer.name.testId

function bundleOf(status: string): ShipmentBundle {
  return {
    shipment: { id: 'sh-1', number: 'S000123', status, updatedAt: '2026-01-01T00:00:00Z', version: 1, salesRepId: null },
    orders: [{ id: 'o-1', customerId: null, mode: 'FTL', references: [], freight: [], specialRequirements: null }],
    loads: [{ id: 'l-1', stops: [] }],
    loadCarriers: [], charges: [], financials: [], documents: [],
  } as unknown as ShipmentBundle
}

function renderForm(mode: 'create' | 'edit', entry?: string | { pathname: string; state: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry ?? (mode === 'create' ? '/new' : '/sh-1/edit')]}>
      <Routes>
        <Route path="/new" element={<ShipmentFormPage mode="create" />} />
        <Route path="/:id/edit" element={<ShipmentFormPage mode="edit" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  h.intakeRow = null
  localStorage.clear()
  h.shipment = { bundle: null, loading: false, error: null }
})

describe('ShipmentFormPage — create mode', () => {
  it('does not read the locations table on mount', async () => {
    renderForm('create')
    await screen.findByTestId('ship-form-create')
    expect(h.useDirectory).toHaveBeenCalledWith({ locations: false })
    expect(h.listLocations).not.toHaveBeenCalled()
  })

  it('Create with an empty form shows the required list and calls nothing', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-create'))
    const strip = await screen.findByTestId('ship-form-issues')
    expect(strip.textContent).toContain('Equipment')
    expect(h.runCreate).not.toHaveBeenCalled()
    expect(h.runSaveDraft).not.toHaveBeenCalled()
  })

  it('Save draft needs only a customer and is serialised against double clicks', async () => {
    let finish: (v: unknown) => void = () => {}
    h.runSaveDraft.mockReturnValue(new Promise((r) => { finish = r }))
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-save-draft'))
    await screen.findByTestId('ship-form-issues')
    expect(h.runSaveDraft).not.toHaveBeenCalled()
    expect(h.toastInfo).toHaveBeenCalledWith(expect.stringMatching(/local draft/i))

    fireEvent.change(screen.getByTestId(CUSTOMER_TESTID), { target: { value: 'ZZ Customer' } })
    fireEvent.click(screen.getByTestId('ship-form-save-draft'))
    fireEvent.click(screen.getByTestId('ship-form-save-draft'))
    await waitFor(() => expect(h.runSaveDraft).toHaveBeenCalledTimes(1))
    expect(h.runSaveDraft.mock.calls[0][2]).toBeNull()
    await act(async () => { finish({ ok: true, bundle: bundleOf('DRAFT'), steps: [], failedSteps: [] }) })
    expect(h.navigate).toHaveBeenCalledWith('/tms/shipments/sh-1/edit', { replace: true })
  })

  it('a failure after the shipment exists offers Retry that never calls create again', async () => {
    h.runSaveDraft.mockResolvedValue({
      ok: false, bundle: bundleOf('DRAFT'), createdShipmentId: 'sh-1', failedSteps: ['SAVE_ORDER_FORM'],
      steps: [{ step: 'CREATE_SHIPMENT', ok: true }, { step: 'SAVE_ORDER_FORM', ok: false }], message: 'boom',
    })
    h.runCreate.mockResolvedValue({ ok: true, bundle: bundleOf('DRAFT'), steps: [], failedSteps: [] })
    renderForm('create')
    fireEvent.change(screen.getByTestId(CUSTOMER_TESTID), { target: { value: 'ZZ Customer' } })
    fireEvent.click(screen.getByTestId('ship-form-save-draft'))
    const partial = await screen.findByTestId('ship-form-partial')
    expect(partial.textContent).toContain('S000123')
    fireEvent.click(screen.getByTestId('ship-form-retry'))
    await waitFor(() => expect(h.runCreate).toHaveBeenCalledTimes(1))
    expect(h.runCreate.mock.calls[0][2]).toMatchObject({ resume: { shipmentId: 'sh-1', done: ['CREATE_SHIPMENT'] } })
    expect(h.runSaveDraft).toHaveBeenCalledTimes(1)
  })

  it('autosaves locally after the debounce and offers Resume on the next visit', async () => {
    vi.useFakeTimers()
    try {
      const first = renderForm('create')
      fireEvent.change(screen.getByTestId(CUSTOMER_TESTID), { target: { value: 'ZZ Draft Customer' } })
      expect(Object.keys(localStorage).some((k) => k.includes('draft'))).toBe(false)
      await act(async () => { vi.advanceTimersByTime(9_000) })
      expect(Object.keys(localStorage).some((k) => k.includes('draft'))).toBe(false)
      await act(async () => { vi.advanceTimersByTime(10_100) })
      expect(Object.keys(localStorage).some((k) => k.includes('draft'))).toBe(true)
      first.unmount()
    } finally {
      vi.useRealTimers()
    }
    renderForm('create')
    expect((screen.getByTestId(CUSTOMER_TESTID) as HTMLInputElement).value).toBe('')
    const banner = await screen.findByTestId('ship-form-drafts')
    fireEvent.click(banner.querySelector('[data-testid^="ship-form-draft-resume-"]') as HTMLElement)
    expect((screen.getByTestId(CUSTOMER_TESTID) as HTMLInputElement).value).toBe('ZZ Draft Customer')
    expect(screen.queryByTestId('ship-form-drafts')).toBeNull()
  })
})

describe('ShipmentFormPage — issues and rail', () => {
  it('Create with blocking issues focuses the first missing field', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-create'))
    await screen.findByTestId('ship-form-issues')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('f-customer-name')))
  })

  it('an issue link focuses the field', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-create'))
    await screen.findByTestId('ship-form-issues')
    fireEvent.click(screen.getByTestId('issue-link-shipping:equipmentType'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('f-shipping-equipmentType')))
  })

  it('the rail checklist counts live, marks a row done when its field is filled, and focuses on click', () => {
    renderForm('create')
    const count = screen.getByTestId('rail-required-count')
    expect(count.textContent).toBe('0 / 7')
    fireEvent.change(screen.getByTestId('f-customer-name'), { target: { value: 'ZZ Customer' } })
    expect(count.textContent).toBe('1 / 7')
    expect(screen.getByTestId('rail-req-customer').getAttribute('data-done')).toBe('true')
    expect(screen.getByTestId('rail-req-equipment').getAttribute('data-missing')).toBe('false')
    fireEvent.click(screen.getByTestId('rail-req-equipment'))
    return waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('f-shipping-equipmentType')))
  })

  it('missing rows turn amber only after a blocked attempt', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-create'))
    await screen.findByTestId('ship-form-issues')
    expect(screen.getByTestId('rail-req-weight').getAttribute('data-missing')).toBe('true')
  })

  it('Cmd+Enter creates and Cmd+S saves a draft, even while typing in a field', async () => {
    renderForm('create')
    const input = screen.getByTestId('f-customer-name')
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await screen.findByTestId('ship-form-issues')
    h.toastInfo.mockClear()
    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    await waitFor(() => expect(h.toastInfo).toHaveBeenCalledWith(expect.stringMatching(/local draft/i)))
    expect(h.runCreate).not.toHaveBeenCalled()
  })
})

describe('ShipmentFormPage — layout contract', () => {
  it('five numbered cards in build order, no positive tabindex', () => {
    renderForm('create')
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid^="section-"]:not([data-testid$="-errors"])')].map((n) => n.dataset.testid)
    expect(cards).toEqual(['section-customer', 'section-route', 'section-freight', 'section-rates', 'section-carrier'])
    expect([...document.querySelectorAll('.tms-ship-card-num')].map((n) => n.textContent)).toEqual(['1', '2', '3', '4', '5'])
    expect([...document.querySelectorAll('[tabindex]')].every((n) => Number(n.getAttribute('tabindex')) <= 0)).toBe(true)
  })

  it('the header shows Division, Mode, status and a read-only PRO preview', () => {
    renderForm('create')
    expect(screen.getByTestId('ship-form-title').textContent).toBe('New shipment')
    expect(screen.getByTestId('ship-form-status').textContent).toBe('Draft')
    expect(screen.getByLabelText('Division')).toBeTruthy()
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('FTL')
  })

  it('Check calls and Updates tabs exist only in edit mode', () => {
    const { unmount } = renderForm('create')
    expect([...document.querySelectorAll('[role="tab"]')].map((n) => n.textContent)).toEqual(
      ['Instructions', 'References', 'Items', 'Notes', 'Documents', 'Rate history'])
    unmount()
    h.shipment = { bundle: bundleOf('DRAFT'), loading: false, error: null }
    renderForm('edit')
    expect([...document.querySelectorAll('[role="tab"]')].map((n) => n.textContent)).toContain('Check calls')
    expect([...document.querySelectorAll('[role="tab"]')].map((n) => n.textContent)).toContain('Updates')
  })

  it('the issues strip names required fields without asterisks', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-create'))
    const strip = await screen.findByTestId('ship-form-issues')
    expect(strip.textContent).not.toContain('*')
  })
})

describe('ShipmentFormPage — edit mode', () => {
  it('a DRAFT shows Save changes and Submit order, and Save changes runs the edit pipeline', async () => {
    h.shipment = { bundle: bundleOf('DRAFT'), loading: false, error: null }
    h.runEditSave.mockResolvedValue({ ok: true, bundle: bundleOf('DRAFT'), steps: [], failedSteps: [] })
    renderForm('edit')
    expect(screen.queryByTestId('ship-form-create')).toBeNull()
    expect(screen.getByTestId('ship-form-submit')).toBeTruthy()
    expect(screen.getByTestId('ship-form-title').textContent).toBe('Edit PRO S000123')
    // Strict level needs the required fields; fill nothing → blocked, nothing called.
    fireEvent.click(screen.getByTestId('ship-form-save'))
    await screen.findByTestId('ship-form-issues')
    expect(h.runEditSave).not.toHaveBeenCalled()
  })

  it('a non-DRAFT shipment has neither Save draft nor Submit order', () => {
    h.shipment = { bundle: bundleOf('OPEN'), loading: false, error: null }
    renderForm('edit')
    expect(screen.queryByTestId('ship-form-save-draft')).toBeNull()
    expect(screen.queryByTestId('ship-form-submit')).toBeNull()
    expect(screen.getByTestId('ship-form-save').textContent).toBe('Save changes')
  })
})

describe('ShipmentFormPage — from an intake load', () => {
  const row = { id: 'il:r1', fields: { customerName: 'Acme Paper', equipmentType: 'Dry Van', stops: [] } }

  it('pre-fills from the e-mail extraction and says so; a plain create has no such banner', async () => {
    h.intakeRow = row
    renderForm('create', { pathname: '/new', state: { intakeId: 'il:r1' } })
    await waitFor(() => expect((screen.getByTestId('f-shipping-equipmentType') as HTMLInputElement).value).toBe('Dry Van'))
    expect((screen.getByTestId(CUSTOMER_TESTID) as HTMLInputElement).value).toBe('Acme Paper')
    expect(screen.getByTestId('ship-form-intake-banner')).toBeTruthy()
  })

  it('ties the intake load to the shipment once the create succeeds', async () => {
    h.intakeRow = row
    h.runSaveDraft.mockResolvedValue({ ok: true, bundle: bundleOf('DRAFT'), steps: [], failedSteps: [] })
    renderForm('create', { pathname: '/new', state: { intakeId: 'il:r1' } })
    await waitFor(() => expect((screen.getByTestId('f-shipping-equipmentType') as HTMLInputElement).value).toBe('Dry Van'))
    fireEvent.click(screen.getByTestId('ship-form-save-draft'))
    await waitFor(() => expect(h.linkIntakeShipment).toHaveBeenCalledWith({ intakeId: 'il:r1', shipmentId: 'sh-1' }))
  })

  it('does not look at an intake id on the edit route', () => {
    h.shipment = { bundle: bundleOf('DRAFT'), loading: false, error: null }
    renderForm('edit', { pathname: '/sh-1/edit', state: { intakeId: 'il:r1' } })
    expect(screen.queryByTestId('ship-form-intake-banner')).toBeNull()
  })
})
