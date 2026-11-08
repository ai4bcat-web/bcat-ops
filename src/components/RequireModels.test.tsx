// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const deployed = vi.hoisted(() => ({ models: new Set<string>() }))
vi.mock('@/lib/modelAvailability', () => ({
  modelAvailable: (name: string) => deployed.models.has(name),
  modelsAvailable: (names: readonly string[]) => names.every((n) => deployed.models.has(n)),
}))

import { DormantPage, RequireModels } from './RequireModels'

function renderGuard(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('RequireModels', () => {
  beforeEach(() => { deployed.models = new Set(['Load']) })

  it('shows the calm empty state, not the page, while a model is missing', () => {
    renderGuard(<RequireModels models={['Load', 'Shipment']} area="Shipments"><p>the board</p></RequireModels>)
    expect(screen.queryByText('the board')).toBeNull()
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Shipments turns on during the merge')
    expect(status.textContent).toContain('This area switches on when the merge finishes. Nothing is wrong and no data is lost. Existing pages keep working.')
    expect(screen.getByRole('link', { name: 'Back to Dashboard' }).getAttribute('href')).toBe('/dashboard')
  })

  it('renders the children once every model is deployed', () => {
    deployed.models = new Set(['Load', 'Shipment'])
    renderGuard(<RequireModels models={['Load', 'Shipment']} area="Shipments"><p>the board</p></RequireModels>)
    expect(screen.getByText('the board')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('lets a page point the way out somewhere else', () => {
    renderGuard(<RequireModels models={['Shipment']} area="Dash" back={{ to: '/calendar', label: 'Open the Calendar' }}><p>x</p></RequireModels>)
    expect(screen.getByRole('link', { name: 'Open the Calendar' }).getAttribute('href')).toBe('/calendar')
  })
})

describe('DormantPage', () => {
  beforeEach(() => { deployed.models = new Set() })

  it('takes area and models from the page table', () => {
    renderGuard(<DormantPage page="shipments"><p>live</p></DormantPage>)
    expect(screen.getByRole('status').textContent).toContain('Shipments turns on during the merge')
  })

  it('stays dormant while any one model of the page is missing, then turns on when the last one arrives', () => {
    deployed.models = new Set(['Shipment', 'Order', 'LoadCarrier'])
    const first = renderGuard(<DormantPage page="shipments"><p>board</p></DormantPage>)
    expect(screen.queryByText('board')).toBeNull()
    first.unmount()
    deployed.models.add('LoadFinancials')
    renderGuard(<DormantPage page="shipments"><p>board</p></DormantPage>)
    expect(screen.getByText('board')).toBeTruthy()
  })
})
