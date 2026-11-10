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

vi.mock('./useShipmentLock', () => ({ useShipmentLock: () => ({ heldBy: null, release: async () => undefined }) }))
vi.mock('./pipelines', () => ({
  runCreate: h.runCreate, runSaveDraft: h.runSaveDraft, runEditSave: h.runEditSave,
  runSubmit: h.runSubmit, runUploadQueued: h.runUploadQueued,
}))
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => h.navigate }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn(), info: h.toastInfo } }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'rep@example.invalid' }, isAdmin: false, isOwner: false, hasPageAccess: () => false }), useAuthUser: () => ({ userId: 'u1', email: 'rep@example.invalid', groups: [] }) }))
vi.mock('@/hooks/useShipment', () => ({
  useShipment: () => ({ ...h.shipment, refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: (opts: unknown) => { h.useDirectory(opts); return { customers: [], locations: [], refresh: vi.fn() } },
}))
vi.mock('@/hooks/useCarriers', () => ({ useCarriers: () => ({ carriers: [] }) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ staff: [] }) }))
vi.mock('@/hooks/useOwnFleetRoster', () => ({ useOwnFleetRoster: () => [] }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({ useOwnershipDivisions: () => ({ divisions: null }) }))
vi.mock('@/lib/apiClient', () => ({ getTmsSettings: vi.fn(async () => null), listLocations: h.listLocations, linkIntakeShipment: h.linkIntakeShipment, listAuditLogsFor: vi.fn(async () => []) }))
vi.mock('../intake/useIntakeLoads', () => ({ useIntakeLoad: () => ({ row: h.intakeRow, loading: false, error: null, reload: vi.fn(), setRow: vi.fn() }) }))
vi.mock('./useFormActions', () => ({
  useFormActions: (o: { busy: boolean }) => ({ actions: {}, dialogs: null, busy: o.busy }),
}))
vi.mock('./defaultSections', () => {
  const none = () => null
  type P = { values: { ship: { equipmentType: string }; customer: { typedName: string; refNo: string } }; update: (fn: (v: never) => unknown) => void }
  return {
    CARD_COMPONENTS: {
      route: none,
      freight: (p: P) => (
        <input
          data-testid="f-shipping-equipmentType" value={p.values.ship.equipmentType}
          onChange={(e) => p.update((v: Record<string, unknown>) => ({ ...v, ship: { ...(v.ship as object), equipmentType: e.target.value } }) as never)}
        />
      ),
      rates: none, carrier: none, documents: none,
    },
    HEADER_PARTS: {
      CustomerPicker: (p: P) => (
        <input
          data-testid="f-customer-name" value={p.values.customer.typedName}
          onChange={(e) => p.update((v: Record<string, unknown>) => ({ ...v, customer: { ...(v.customer as object), typedName: e.target.value, useTyped: true } }) as never)}
        />
      ),
      CustomerRef: (p: P) => (
        <input
          data-testid="f-customer-refNo" value={p.values.customer.refNo}
          onChange={(e) => p.update((v: Record<string, unknown>) => ({ ...v, customer: { ...(v.customer as object), refNo: e.target.value } }) as never)}
        />
      ),
      BillToStrip: (p: P & { open: boolean; onToggle: () => void }) => (
        <>
          <button type="button" data-testid="hdr-billTo-chip" aria-expanded={p.open} onClick={p.onToggle}>Bill To</button>
          <div data-testid="ship-form-header-panel" data-header-panel hidden={!p.open}>
            <input data-testid="f-customer-email-1" defaultValue="" />
          </div>
        </>
      ),
    },
    MORE_TAB_COMPONENTS: {
      instructions: none, references: none, items: none, notes: none,
    },
    RAIL_ROLES: none,
    RAIL_RATE_HISTORY: () => <div data-testid="card-rateHistory-stub" />,
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
    // Shipment type defaults to Truckload, so that row starts done.
    expect(count.textContent).toBe('1 / 8')
    fireEvent.change(screen.getByTestId('f-customer-name'), { target: { value: 'ZZ Customer' } })
    expect(count.textContent).toBe('2 / 8')
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
  it('five numbered cards in build order (Customer and Bill To live in the header), no positive tabindex', () => {
    renderForm('create')
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid^="section-"]:not([data-testid$="-errors"])')].map((n) => n.dataset.testid)
    expect(cards).toEqual(['section-freight', 'section-route', 'section-rates', 'section-carrier', 'section-documents'])
    expect([...document.querySelectorAll('.tms-ship-card-num')].map((n) => n.textContent)).toEqual(['1', '2', '3', '4', '5'])
    expect([...document.querySelectorAll('[tabindex]')].every((n) => Number(n.getAttribute('tabindex')) <= 0)).toBe(true)
  })

  it('the More strip sits directly under Carrier & Tracking and before Documents', () => {
    renderForm('create')
    const order = [...document.querySelectorAll<HTMLElement>('[data-testid^="section-"]:not([data-testid$="-errors"]), [data-testid="ship-form-more"]')].map((n) => n.dataset.testid)
    expect(order).toEqual(['section-freight', 'section-route', 'section-rates', 'section-carrier', 'ship-form-more', 'section-documents'])
  })

  it('the header strip holds the Customer picker and the Bill To chip, with no Mode pill', () => {
    renderForm('create')
    const header = screen.getByTestId('ship-form-header')
    expect(screen.getByTestId('ship-form-title').textContent).toBe('New shipment')
    expect(screen.getByTestId('ship-form-status').textContent).toBe('Draft')
    for (const id of ['f-customer-name', 'f-customer-refNo', 'hdr-billTo-chip', 'ship-form-pro']) expect(header.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    expect(screen.queryByLabelText('Mode')).toBeNull()
    expect(header.querySelector('[data-testid="delivery-timeline"]')).not.toBeNull()
    expect(screen.getByTestId('delivery-caption').textContent).toBe('Draft')
    expect(screen.queryByTestId('f-header-division')).toBeNull()
    expect(screen.queryByLabelText('Division')).toBeNull()
    expect(screen.getByTestId('hdr-billTo-chip').getAttribute('aria-expanded')).toBe('false')
    expect((screen.getByTestId('ship-form-header-panel') as HTMLElement).hidden).toBe(true)
  })

  it('the Bill To panel opens from the chip, and focusing a field inside it (an issue link, the rail) opens it', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('hdr-billTo-chip'))
    expect((screen.getByTestId('ship-form-header-panel') as HTMLElement).hidden).toBe(false)
    fireEvent.click(screen.getByTestId('hdr-billTo-chip'))
    expect((screen.getByTestId('ship-form-header-panel') as HTMLElement).hidden).toBe(true)
    // Customer is required, so Create focuses the header picker; the panel stays shut for it.
    fireEvent.click(screen.getByTestId('ship-form-create'))
    await screen.findByTestId('ship-form-issues')
    expect((screen.getByTestId('ship-form-header-panel') as HTMLElement).hidden).toBe(true)
  })

  it('the More strip holds only Instructions, References, Items and Notes, in both modes', () => {
    const { unmount } = renderForm('create')
    const names = () => [...document.querySelectorAll('[role="tab"]')].map((n) => n.textContent)
    expect(names()).toEqual(['Instructions', 'References', 'Items', 'Notes'])
    unmount()
    h.shipment = { bundle: bundleOf('DRAFT'), loading: false, error: null }
    renderForm('edit')
    expect(names()).toEqual(['Instructions', 'References', 'Items', 'Notes'])
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
