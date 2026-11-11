// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useState } from 'react'

const api = vi.hoisted(() => ({ lockShipment: vi.fn(), unlockShipment: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ ...api, countOpenIntakeLoads: async () => 0 }))

import { useShipmentLock } from '@/features/shipments/form/useShipmentLock'
import { useShipmentTabs } from './shipmentTabsContext'
import { ShipmentTabsProvider } from './ShipmentTabsProvider'
import { ShipmentTabStrip } from './ShipmentTabStrip'
import { ShipmentTabHost } from './ShipmentTabHost'
import { ShipmentTabAnchor } from './ShipmentTabAnchor'
import { SHIPMENT_TABS_KEY } from './tabsModel'

/** Stands in for the real form: a draft input, the real edit-lock hook, and the two exits the real form has. */
vi.mock('@/features/shipments/form/ShipmentFormPage', () => ({
  ShipmentFormPage: ({ shipmentId }: { shipmentId: string }) => <FakeForm id={shipmentId} />,
}))
function FakeForm({ id }: { id: string }) {
  const tabs = useShipmentTabs()
  const nav = useNavigate()
  const { release } = useShipmentLock(id)
  const [draft, setDraft] = useState('')
  return (
    <div data-testid={`form-${id}`}>
      <input aria-label={`draft ${id}`} value={draft} onChange={(e) => { setDraft(e.target.value); tabs?.setDirty(id, e.target.value !== '') }} />
      <button type="button" onClick={() => tabs?.setMeta(id, { number: `P${id}`, customer: 'ACME' })}>load {id}</button>
      <button type="button" onClick={async () => { await release(); tabs?.close(id); nav('/tms/shipments') }}>save and exit {id}</button>
    </div>
  )
}

function Board() {
  const nav = useNavigate()
  return <div data-testid="board"><button onClick={() => nav('/tms/shipments/s1/edit')}>open s1</button><button onClick={() => nav('/tms/shipments/s2/edit')}>open s2</button></div>
}

function app(start = '/tms/shipments') {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <ShipmentTabsProvider>
        <ShipmentTabStrip />
        <ShipmentTabHost />
        <Routes>
          <Route path="/tms/shipments" element={<Board />} />
          <Route path="/tms/shipments/:id/edit" element={<ShipmentTabAnchor />} />
        </Routes>
      </ShipmentTabsProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  api.lockShipment.mockResolvedValue({ locked: true })
  api.unlockShipment.mockResolvedValue({ released: true })
})

describe('shipment tabs', () => {
  it('opening a shipment adds a tab and focuses it; opening it again does not duplicate', async () => {
    app()
    for (const k of ['active', 'all', 'intake', 'voided']) expect(screen.getByTestId(`ship-tab-section-${k}`)).toBeInTheDocument()
    expect(screen.queryByTestId('ship-tab-s1')).toBeNull()
    fireEvent.click(screen.getByText('open s1'))
    expect(await screen.findByTestId('ship-tab-s1')).toBeInTheDocument()
    expect(screen.getByTestId('ship-pane-s1')).toHaveAttribute('data-active', 'true')
    fireEvent.click(screen.getByTestId('ship-tab-section-active'))
    fireEvent.click(screen.getByText('open s1'))
    await waitFor(() => expect(screen.getByTestId('ship-pane-s1')).toHaveAttribute('data-active', 'true'))
    expect(screen.getAllByRole('tab').filter((t) => t.getAttribute('data-testid')?.startsWith('ship-tab-s1'))).toHaveLength(1)
  })

  it('a draft typed in one tab is still there after working in another tab and coming back', async () => {
    app()
    fireEvent.click(screen.getByText('open s1'))
    fireEvent.change(await screen.findByLabelText('draft s1'), { target: { value: 'half typed' } })
    fireEvent.click(screen.getByTestId('ship-tab-section-active'))
    fireEvent.click(screen.getByText('open s2'))
    fireEvent.change(await screen.findByLabelText('draft s2'), { target: { value: 'other' } })
    expect(screen.getByTestId('ship-pane-s1')).toHaveAttribute('data-active', 'false')
    fireEvent.click(screen.getByTestId('ship-tab-s1'))
    await waitFor(() => expect(screen.getByTestId('ship-pane-s1')).toHaveAttribute('data-active', 'true'))
    expect(screen.getByLabelText('draft s1')).toHaveValue('half typed')
    expect(screen.getByLabelText('draft s2')).toHaveValue('other')
  })

  it('a tab with unsaved edits shows a dot, and the label reads PRO number and customer once the shipment loaded', async () => {
    app()
    fireEvent.click(screen.getByText('open s1'))
    fireEvent.click(await screen.findByText('load s1'))
    expect(await screen.findByText('PRO Ps1 · ACME')).toBeInTheDocument()
    expect(screen.queryByTestId('ship-tab-dirty-s1')).toBeNull()
    fireEvent.change(screen.getByLabelText('draft s1'), { target: { value: 'x' } })
    expect(await screen.findByTestId('ship-tab-dirty-s1')).toBeInTheDocument()
  })

  it('the edit lock is taken when the tab opens, kept while you work in other tabs and on the board, and let go when the tab is closed', async () => {
    app()
    fireEvent.click(screen.getByText('open s1'))
    await waitFor(() => expect(api.lockShipment).toHaveBeenCalledWith('s1'))
    fireEvent.click(screen.getByTestId('ship-tab-section-active'))
    fireEvent.click(screen.getByText('open s2'))
    await waitFor(() => expect(api.lockShipment).toHaveBeenCalledWith('s2'))
    expect(api.unlockShipment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('ship-tab-close-s1'))
    await waitFor(() => expect(api.unlockShipment).toHaveBeenCalledWith('s1'))
    expect(screen.queryByTestId('ship-tab-s1')).toBeNull()
    expect(api.unlockShipment).not.toHaveBeenCalledWith('s2')
  })

  it('middle-click closes a tab', async () => {
    app()
    fireEvent.click(screen.getByText('open s1'))
    const tab = (await screen.findByTestId('ship-tab-s1')).parentElement!
    fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await waitFor(() => expect(screen.queryByTestId('ship-tab-s1')).toBeNull())
    expect(api.unlockShipment).toHaveBeenCalledWith('s1')
  })

  it('closing a tab with unsaved edits asks first, and keeps it open on Keep editing', async () => {
    app()
    fireEvent.click(screen.getByText('open s1'))
    fireEvent.change(await screen.findByLabelText('draft s1'), { target: { value: 'x' } })
    await screen.findByTestId('ship-tab-dirty-s1')
    fireEvent.click(screen.getByTestId('ship-tab-close-s1'))
    fireEvent.click(await screen.findByText('Keep editing'))
    expect(screen.getByTestId('ship-tab-s1')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ship-tab-close-s1'))
    fireEvent.click(await screen.findByTestId('ship-tab-confirm-close'))
    await waitFor(() => expect(screen.queryByTestId('ship-tab-s1')).toBeNull())
    expect(api.unlockShipment).toHaveBeenCalledWith('s1')
  })

  it('Save & exit lets go of the lock and closes that tab, leaving the others', async () => {
    app()
    fireEvent.click(screen.getByText('open s1'))
    await screen.findByTestId('ship-tab-s1')
    fireEvent.click(screen.getByTestId('ship-tab-section-active'))
    fireEvent.click(screen.getByText('open s2'))
    await screen.findByTestId('ship-tab-s2')
    fireEvent.click(screen.getByText('save and exit s2'))
    await waitFor(() => expect(screen.queryByTestId('ship-tab-s2')).toBeNull())
    expect(api.unlockShipment).toHaveBeenCalledWith('s2')
    expect(screen.getByTestId('ship-tab-s1')).toBeInTheDocument()
    expect(screen.getByTestId('board')).toBeInTheDocument()
  })

  it('the tabs survive a reload of the page (sessionStorage) and reopen their forms', async () => {
    const first = app()
    fireEvent.click(screen.getByText('open s1'))
    await screen.findByTestId('ship-tab-s1')
    expect(sessionStorage.getItem(SHIPMENT_TABS_KEY)).toContain('s1')
    first.unmount()
    app()
    expect(await screen.findByTestId('ship-tab-s1')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('form-s1')).toBeInTheDocument())
  })

  it('Create shipment sits on the tab row on the board, opens the new-shipment form, and is not shown on an open shipment', async () => {
    render(
      <MemoryRouter initialEntries={['/tms/shipments']}>
        <ShipmentTabsProvider>
          <ShipmentTabStrip />
          <Routes>
            <Route path="/tms/shipments" element={<Board />} />
            <Route path="/tms/shipments/new" element={<div>new shipment form</div>} />
            <Route path="/tms/shipments/:id/edit" element={<ShipmentTabAnchor />} />
          </Routes>
        </ShipmentTabsProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('open s1'))
    await screen.findByTestId('ship-tab-s1')
    expect(screen.queryByTestId('create-shipment')).toBeNull()
    fireEvent.click(screen.getByTestId('ship-tab-section-active'))
    fireEvent.click(await screen.findByRole('button', { name: 'Create shipment' }))
    expect(await screen.findByText('new shipment form')).toBeInTheDocument()
  })
})
