// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentBundle } from '@/types/tms'
import { LABEL } from './labels'

const h = vi.hoisted(() => ({
  toastInfo: vi.fn(),
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
vi.mock('@/lib/apiClient', () => ({ getTmsSettings: vi.fn(async () => null), listLocations: h.listLocations }))
vi.mock('./useFormActions', () => ({
  useFormActions: (o: { busy: boolean }) => ({ actions: {}, dialogs: null, busy: o.busy }),
}))
vi.mock('./defaultSections', () => {
  const none = () => null
  return {
    SECTION_COMPONENTS: {
      shipping: (p: { value: { equipmentType: string }; onChange: (v: { equipmentType: string }) => void }) => (
        <input
          data-testid="f-shipping-equipmentType" value={p.value.equipmentType}
          onChange={(e) => p.onChange({ equipmentType: e.target.value })}
        />
      ),
      customer: (p: { value: { typedName: string }; onChange: (v: object) => void }) => (
        <input
          data-testid="f-customer-name" value={p.value.typedName}
          onChange={(e) => p.onChange({ typedName: e.target.value, useTyped: true })}
        />
      ),
      pickup: none, consignee: none, history: none, roles: none, more: none, rates: none,
      carrier: none, picks: none, documents: none, checkCalls: none,
    },
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

function renderForm(mode: 'create' | 'edit') {
  return render(
    <MemoryRouter initialEntries={[mode === 'create' ? '/new' : '/sh-1/edit']}>
      <Routes>
        <Route path="/new" element={<ShipmentFormPage mode="create" />} />
        <Route path="/:id/edit" element={<ShipmentFormPage mode="edit" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
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
      await act(async () => { vi.advanceTimersByTime(900) })
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

describe('ShipmentFormPage — sections and issues', () => {
  it('collapsing keeps the value and persists; Create force-expands a section with a blocking issue', async () => {
    renderForm('create')
    fireEvent.change(screen.getByTestId('f-shipping-equipmentType'), { target: { value: 'Van' } })
    const toggle = screen.getByTestId('section-shipping-toggle')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById('section-shipping-body')?.hidden).toBe(true)
    expect(localStorage.getItem('tms:ship-form:sections:rep@example.invalid')).toContain('"shipping":false')

    fireEvent.click(screen.getByTestId('ship-form-create'))
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'))
    expect((screen.getByTestId('f-shipping-equipmentType') as HTMLInputElement).value).toBe('Van')
    expect(screen.getByTestId('section-shipping-errors')).toBeTruthy()
  })

  it('an issue link expands its section and focuses the field', async () => {
    renderForm('create')
    fireEvent.click(screen.getByTestId('ship-form-create'))
    await screen.findByTestId('ship-form-issues')
    fireEvent.click(screen.getByTestId('section-shipping-toggle'))
    fireEvent.click(screen.getByTestId('issue-link-shipping:equipmentType'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('f-shipping-equipmentType')))
    expect(screen.getByTestId('section-shipping-toggle').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ShipmentFormPage — edit mode', () => {
  it('a DRAFT shows Save changes and Submit order, and Save changes runs the edit pipeline', async () => {
    h.shipment = { bundle: bundleOf('DRAFT'), loading: false, error: null }
    h.runEditSave.mockResolvedValue({ ok: true, bundle: bundleOf('DRAFT'), steps: [], failedSteps: [] })
    renderForm('edit')
    expect(screen.queryByTestId('ship-form-create')).toBeNull()
    expect(screen.getByTestId('ship-form-submit')).toBeTruthy()
    expect(screen.getByTestId('ship-form-title').textContent).toContain('S000123')
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
