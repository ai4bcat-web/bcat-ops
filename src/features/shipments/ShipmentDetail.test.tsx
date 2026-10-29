// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ShipmentDetail } from './components/ShipmentDetail'
import { normalizeDetailTab } from './components/detailTabs'
import type { ShipmentActions } from './useShipmentActions'
import type {
  CustomerRecord, LoadCarrierRecord, LoadChargeRecord, OrderRecord, ShipmentBundle, ShipmentLoad, ShipmentRecord,
  ShipmentStatus, WorkflowRunRecord,
} from '@/types/tms'
import type { Stop } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const listOwnershipDivisions = vi.hoisted(() => vi.fn())
const listOwnershipRules = vi.hoisted(() => vi.fn())
const previewInvoice = vi.hoisted(() => vi.fn())
const listAuditLogs = vi.hoisted(() => vi.fn())
// Step J — the Overview Integrations card reads the rows and runs a stub through these.
const listIntegrations = vi.hoisted(() => vi.fn())
const runIntegrationStub = vi.hoisted(() => vi.fn())
// Step K — the AI Agent tab exists only while this answers with a run.
const listWorkflowRunsForShipment = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))
vi.mock('@/features/loads/LoadDriverDocs', () => ({
  LoadDriverDocs: ({ kind }: { kind: string }) => <div>docs:{kind}</div>,
}))
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  getCarrierBundle: vi.fn(async () => null),
  listDivisions: vi.fn(async () => []),
  getRateConfirmUrl: vi.fn(async () => ''),
  // Step E — the Documents tab and the delivery card read through these.
  listShipmentDocuments: vi.fn(async () => []),
  listShipmentNotices: vi.fn(async () => []),
  listTrackingLinksByShipment: vi.fn(async () => []),
  listCheckCallsByLoad: vi.fn(async () => []),
  getShipmentDocumentUrl: vi.fn(async () => ''),
  readyToInvoice: vi.fn(),
  updateDocument: vi.fn(),
  voidDocument: vi.fn(),
  attachDriverDoc: vi.fn(),
  sendUploadLink: vi.fn(),
  revokeUploadLink: vi.fn(),
  sendMilestoneNotice: vi.fn(),
  emailDocuments: vi.fn(),
  rateCarrier: vi.fn(),
  prepareDocumentUpload: vi.fn(),
  commitDocument: vi.fn(),
  saveGeneratedDocument: vi.fn(),
  putPresignedFile: vi.fn(),
  // Step R — the Overview division card, the Invoicing gate and the History tab.
  listOwnershipDivisions,
  listOwnershipRules,
  previewInvoice,
  listAuditLogs,
  listUserProfiles: vi.fn(async () => []),
  getInvoice: vi.fn(async () => null),
  getCarrier: vi.fn(async () => null),
  getCarrierBill: vi.fn(async () => null),
  voidBill: vi.fn(),
  voidInvoice: vi.fn(),
  saveOrderForm: vi.fn(),
  getInvoicePdfUrl: vi.fn(async () => ''),
  listIntegrations,
  runIntegrationStub,
  listWorkflowRunsForShipment,
}))
vi.mock('@/lib/driverSubmissionsClient', () => ({
  getDriverDocUrl: vi.fn(async () => ''),
  attachDocs: vi.fn(async () => []),
}))
vi.mock('@/hooks/useLoadDriverDocs', () => ({
  useLoadDriverDocs: () => ({ pods: [], ratecons: [], misc: [], loading: false, error: null, refresh: vi.fn() }),
}))
// The generated-document dialog pulls in jsPDF through these; the tab itself does not
// render a PDF, so the builders stay out of this render test.
vi.mock('@/lib/bolPdf', () => ({ buildBolPdf: vi.fn(), bolFilename: vi.fn(() => 'bol.pdf') }))
vi.mock('@/lib/loadSummaryPdf', () => ({
  buildLoadSummaryPdf: vi.fn(), loadSummaryFilename: vi.fn(() => 'load-summary.pdf'),
}))
vi.mock('@/lib/carrierRateCon', () => ({
  buildRateConPdf: vi.fn(),
  rateConPdfBase64: vi.fn(() => ''),
  rateConFilename: vi.fn(() => 'rate-con.pdf'),
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: [], loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))
// Step H — the Carrier tab's offers card and the Financials tab's lane history read
// through these; this test is about the tabs, not about what the lane has paid.
vi.mock('@/hooks/useLoadOffers', () => ({
  useLoadOffers: () => ({ offers: [], loading: false, error: null, refresh: vi.fn(async () => {}) }),
}))
vi.mock('@/hooks/useLaneStats', () => ({
  useLaneStats: () => ({
    stats: {
      customer: { count: 0, lowCents: null, medianCents: null, avgCents: null, highCents: null, perMileCents: null },
      carrier: { count: 0, lowCents: null, medianCents: null, avgCents: null, highCents: null, perMileCents: null },
      marginAvgBps: null, milesAvg: null, byMonth: [], lastAt: null,
    },
    basis: 'NONE', badge: 'No history on this lane', samples: [],
    loading: false, error: null, refresh: vi.fn(async () => {}),
  }),
}))

const stops: Stop[] = [
  { id: 'p1', type: 'pickup', sequence: 0, appt: '2026-04-01T13:00:00.000Z', driverId: null, name: 'Acme Dock 4', city: 'Chicago, IL' },
  { id: 'd1', type: 'delivery', sequence: 1, appt: '2026-04-02T13:00:00.000Z', driverId: null, name: 'Globex DC', city: 'Dallas, TX' },
]

const charges: LoadChargeRecord[] = [{
  id: 'ch-1', shipmentId: 'shp-1', side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT',
  rateCents: 200000, amountCents: 200000, isRate: true, sortOrder: 0,
  createdBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}]

function bundle(status: ShipmentStatus, over: Partial<ShipmentBundle> = {}): ShipmentBundle {
  const shipment: ShipmentRecord = {
    id: 'shp-1', number: 'S000001', status, customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL', originCity: 'Chicago, IL', destinationCity: 'Dallas, TX',
    revDivision: 'BROKERAGE', revTagSource: 'RULE', revRuleId: 'rule-seed-7',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const order: OrderRecord = {
    id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL', equipmentType: "53' Dry Van",
    arStatus: 'DOCS_NEEDED', references: [], freight: [],
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const load: ShipmentLoad = { id: 'load-1', stops, miles: 900, status: 'BOOKED', loadNumber: 'S000001-1', leg: 1 }
  return {
    shipment, orders: [order], loads: [load], loadCarriers: [], charges, financials: [], documents: [],
    ...over,
  }
}

function ownAssetLeg(): LoadCarrierRecord {
  return {
    id: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', kind: 'OWN_ASSET', status: 'ACTIVE',
    driverId: 'drv-1', driverName: 'Pavel Ivanov', truckNumber: '204', trailerNumber: 'T-19',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeActions(): ShipmentActions {
  return {
    busy: false,
    saveForm: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    stopAction: vi.fn(async () => {}),
    saveCharges: vi.fn(async () => {}),
    shipment: {
      onDuplicate: vi.fn(async () => {}), onSetStatus: vi.fn(async () => {}),
      onVoid: vi.fn(), onTenderRespond: vi.fn(async () => {}),
    },
    bookCarrier: vi.fn(async () => {}),
    setQuickPay: vi.fn(async () => {}),
    sendRateCon: vi.fn(async () => {}),
    voidRateCon: vi.fn(async () => {}),
    onSetRevTag: vi.fn(async () => {}),
    onClearRevTag: vi.fn(async () => {}),
    onSetSalesRep: vi.fn(async () => {}),
    setCustomer: vi.fn(async () => {}),
    dispatchLoad: vi.fn(async () => {}),
    load: {
      onSetLoadStatus: vi.fn(async () => {}), onAssignAsset: vi.fn(async () => {}), onAssignCarrier: vi.fn(async () => {}),
      onBookCarrier: vi.fn(async () => {}), onRemoveCarrier: vi.fn(async () => {}), onSetArStatus: vi.fn(async () => {}),
    },
    tracking: {
      logCheckCall: vi.fn(async () => {}), resolveIncident: vi.fn(async () => {}),
      setNextCheckCall: vi.fn(async () => {}), setEta: vi.fn(async () => {}),
    },
    reload: vi.fn(async () => {}),
  }
}

let actions = makeActions()

beforeEach(() => {
  vi.clearAllMocks()
  actions = makeActions()
  listOwnershipDivisions.mockResolvedValue([])
  listOwnershipRules.mockResolvedValue([])
  listAuditLogs.mockResolvedValue([])
  listIntegrations.mockResolvedValue([])
  listWorkflowRunsForShipment.mockResolvedValue([])
})

function renderDetail(
  status: ShipmentStatus = 'BOOKED',
  over: Partial<React.ComponentProps<typeof ShipmentDetail>> = {},
  bundleOver: Partial<ShipmentBundle> = {},
) {
  render(
    <MemoryRouter>
      <ShipmentDetail
        bundle={bundle(status, bundleOver)}
        customer={null}
        customers={[]}
        locations={[]}
        catalog={[]}
        pricing={null}
        marginFloorBps={null}
        requiredReferences={[]}
        credit={null}
        currentUser="ryne@bcatcorp.com"
        isAdmin={false}
        actions={actions}
        {...over}
      />
    </MemoryRouter>,
  )
}

/*
 * Step R — a shipment can exist on nothing but the operator's typed customer text. The
 * gates refuse it before the release gate ever runs, so the detail has to say why and
 * carry the only fix: linking a Customer record.
 */
describe('a shipment with no customer record', () => {
  const directDrive = {
    id: 'cust-9', name: 'Direct Drive Logistics', status: 'ACTIVE', active: true,
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as CustomerRecord

  function renderUnresolved(status: ShipmentStatus = 'BOOKED') {
    const base = bundle(status)
    renderDetail(status, { customers: [directDrive] }, {
      shipment: { ...base.shipment, customerId: null, customerName: 'DIRECT DRIVE LOGISTICS' },
    })
  }

  it('says what is blocked, and links a customer record when one is picked', async () => {
    renderUnresolved()
    const note = screen.getByTestId('unresolved-customer-note').textContent ?? ''
    expect(note).toContain('DIRECT DRIVE LOGISTICS')
    expect(note).toContain('Link a customer before submitting, invoicing or factoring it')

    fireEvent.change(screen.getByLabelText('Customer to link'), { target: { value: 'cust-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link customer' }))
    await waitFor(() => expect(actions.setCustomer).toHaveBeenCalledWith('cust-9'))
  })

  it('offers the same link above the draft editor, where it is commonest', () => {
    renderUnresolved('DRAFT')
    expect(screen.getByTestId('unresolved-customer-note')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Link customer' })).toBeTruthy()
  })

  it('says nothing of the sort once a customer is linked', () => {
    renderDetail('BOOKED', { customers: [directDrive] })
    expect(screen.queryByTestId('unresolved-customer-note')).toBeNull()
  })
})

describe('ShipmentDetail tabs', () => {
  it('opens on Overview with the facts the old Summary and Details tabs both held', () => {
    renderDetail()
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Acme Freight')).toBeTruthy()
    expect(screen.getByText('Chicago, IL')).toBeTruthy()
    expect(screen.getByText('$2000.00')).toBeTruthy()
    // Previously the Details tab: one record, one set of facts.
    expect(screen.getByText('S000001-1')).toBeTruthy()
    expect(screen.getByText("53' Dry Van")).toBeTruthy()
  })

  it('shows the nine tabs and switches between them', async () => {
    renderDetail()
    const names = [
      'Overview', 'Stops', 'Carrier/Driver', 'Tracking', 'Documents', 'Financials', 'Invoicing', 'Carrier Pay', 'History',
    ]
    for (const name of names) expect(screen.getByRole('tab', { name })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Stops' }))
    await waitFor(() => expect(screen.getByText('Acme Dock 4')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }))
    await waitFor(() => expect(screen.getByText('docs:POD')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: 'Financials' }))
    await waitFor(() => expect(screen.getByTestId('financial-totals')).toBeTruthy())
    expect(screen.getByTestId('lane-history')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Carrier/Driver' }))
    await waitFor(() => expect(screen.getByTestId('carrier-offers')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    await waitFor(() => expect(listAuditLogs).toHaveBeenCalled())
  })

  it('maps the pre-merge deep links onto Overview and keeps the new keys', () => {
    expect(normalizeDetailTab('summary')).toBe('overview')
    expect(normalizeDetailTab('details')).toBe('overview')
    expect(normalizeDetailTab('carrierPay')).toBe('carrierPay')
    expect(normalizeDetailTab('nonsense')).toBeUndefined()
  })

  it('opens on the tab a deep link asked for', async () => {
    renderDetail('BOOKED', { initialTab: 'carrierPay' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Carrier Pay' }).getAttribute('aria-selected')).toBe('true'))
  })

  it('never shows the user the word Order', () => {
    renderDetail()
    expect(screen.queryByText(/\bOrder\b/)).toBeNull()
  })

  it('shows the draft editor instead of tabs while the shipment is a draft', () => {
    renderDetail('DRAFT')
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Submit shipment' })).toBeTruthy()
  })

  it('refuses stop edits on a canceled shipment', async () => {
    renderDetail('CANCELED')
    fireEvent.click(screen.getByRole('tab', { name: 'Stops' }))
    await waitFor(() => expect((screen.getByLabelText('Stop 1 actions') as HTMLButtonElement).disabled).toBe(true))
  })

  it('freezes stop edits on a voided shipment', async () => {
    renderDetail('BOOKED', {}, {
      shipment: {
        ...bundle('BOOKED').shipment,
        voidedAt: '2026-04-04T10:00:00.000Z', voidedBy: 'ryne@bcatcorp.com', voidReason: 'Duplicate of S000002',
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Stops' }))
    await waitFor(() => expect((screen.getByLabelText('Stop 1 actions') as HTMLButtonElement).disabled).toBe(true))
  })
})

/*
 * Step K — an agent run is linked to a shipment, not to every shipment. The tab is drawn
 * only where one is, and the shortcut exists only where the tab does.
 */
describe('the AI Agent tab', () => {
  const run: WorkflowRunRecord = {
    id: 'wf:TENDER:9f2c', agent: 'TENDER', status: 'COMPLETED', outcome: 'APPLIED',
    sourceId: 'intake-1', shipmentId: 'shp-1', createdBy: 'workflow-agent', updatedBy: 'workflow-agent',
    createdAt: '2026-04-03T09:00:00.000Z', updatedAt: '2026-04-03T10:00:00.000Z',
  }

  it('is not in the strip while no run is linked to the shipment', async () => {
    renderDetail()
    await waitFor(() => expect(listWorkflowRunsForShipment).toHaveBeenCalledWith('shp-1'))
    expect(screen.queryByRole('tab', { name: 'AI Agent' })).toBeNull()
  })

  it('sends a ?tab=aiAgent deep link to Overview when there is no such tab', async () => {
    renderDetail('BOOKED', { initialTab: 'aiAgent' })
    await waitFor(() => expect(listWorkflowRunsForShipment).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('shipment-workflow-runs')).toBeNull()
  })

  it('lists the linked run and points it at the trace', async () => {
    listWorkflowRunsForShipment.mockResolvedValue([run])
    renderDetail()
    fireEvent.click(await screen.findByRole('tab', { name: 'AI Agent' }))
    const list = await screen.findByTestId('shipment-workflow-runs')
    expect(within(list).getByRole('link', { name: 'Tender' }).getAttribute('href')).toBe('/tms/workflows/runs/wf:TENDER:9f2c')
    expect(within(list).getByText('COMPLETED')).toBeTruthy()
    expect(within(list).getByText('APPLIED')).toBeTruthy()
  })

  it('opens on A pressed inside the detail', async () => {
    listWorkflowRunsForShipment.mockResolvedValue([run])
    renderDetail()
    await screen.findByRole('tab', { name: 'AI Agent' })

    fireEvent.keyDown(screen.getByTestId('shipment-detail'), { key: 'a' })
    await waitFor(() => expect(screen.getByTestId('shipment-workflow-runs')).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'AI Agent' }).getAttribute('aria-selected')).toBe('true')
  })

  it('leaves A alone while it is being typed into a field', async () => {
    listWorkflowRunsForShipment.mockResolvedValue([run])
    renderDetail()
    await screen.findByRole('tab', { name: 'AI Agent' })
    fireEvent.click(screen.getByRole('tab', { name: 'Financials' }))

    fireEvent.keyDown(await screen.findByLabelText('CUSTOMER count 1'), { key: 'a' })
    expect(screen.getByRole('tab', { name: 'Financials' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('shipment-workflow-runs')).toBeNull()
  })
})

describe('Overview division card', () => {
  const divisions = [
    {
      id: 'BROKERAGE', code: 'BROKERAGE', name: 'BCAT Logistics', brand: 'BCAT Logistics', parentId: null,
      color: '#f4c50c', sortOrder: 10, active: true, owners: null, flows: null,
      createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: '', updatedAt: '',
    },
    {
      id: 'ASSETS', code: 'ASSETS', name: 'Ivan Cartage', brand: 'Ivan Cartage', parentId: null,
      color: '#0a81ff', sortOrder: 20, active: true, owners: null, flows: null,
      createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: '', updatedAt: '',
    },
    {
      id: 'BOX_TRUCK', code: 'BOX_TRUCK', name: 'Box Trucks', brand: null, parentId: 'ASSETS',
      color: null, sortOrder: 10, active: true, owners: null, flows: null,
      createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: '', updatedAt: '',
    },
  ]
  const rules = [{
    id: 'rule-seed-7', name: 'Everything else is Brokerage', sortOrder: 70, active: true,
    condition: { kind: 'ALWAYS' as const }, divisionCode: 'BROKERAGE',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: '', updatedAt: '',
  }]

  it('names the rule that tagged the shipment', async () => {
    listOwnershipDivisions.mockResolvedValue(divisions)
    listOwnershipRules.mockResolvedValue(rules)
    renderDetail()
    await waitFor(() => expect(screen.getByTestId('division-chip').textContent).toBe('BCAT Logistics'))
    expect(screen.getByTestId('division-provenance').textContent).toBe('Tagged by rule Everything else is Brokerage')
  })

  it('hand-tags through the client and offers the way back to the rules', async () => {
    listOwnershipDivisions.mockResolvedValue(divisions)
    listOwnershipRules.mockResolvedValue(rules)
    renderDetail('BOOKED', { isAdmin: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Set tag…' }))
    fireEvent.change(await screen.findByLabelText('Division'), { target: { value: 'ASSETS' } })
    fireEvent.change(screen.getByLabelText('Subdivision'), { target: { value: 'BOX_TRUCK' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set tag' }))

    await waitFor(() => expect(actions.onSetRevTag).toHaveBeenCalledWith({
      divisionCode: 'ASSETS', subdivisionCode: 'BOX_TRUCK',
    }))
  })

  it('offers Back to rules only on a hand tag, and clears through the client', async () => {
    listOwnershipDivisions.mockResolvedValue(divisions)
    listOwnershipRules.mockResolvedValue(rules)
    renderDetail('BOOKED', { isAdmin: true }, {
      shipment: {
        ...bundle('BOOKED').shipment,
        revTagSource: 'HAND', revRuleId: null, revDivision: 'ASSETS', revTaggedBy: 'dennis@bcatcorp.com',
      },
    })

    await waitFor(() => expect(screen.getByTestId('division-provenance').textContent)
      .toBe('Hand-tagged by dennis@bcatcorp.com'))
    fireEvent.click(screen.getByRole('button', { name: 'Back to rules' }))
    await waitFor(() => expect(actions.onClearRevTag).toHaveBeenCalled())
  })

  it('hides the tag controls from a user who may not tag', async () => {
    listOwnershipDivisions.mockResolvedValue(divisions)
    renderDetail()
    await waitFor(() => expect(screen.getByTestId('division-card')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Set tag…' })).toBeNull()
  })
})

describe('Invoicing release gate', () => {
  it('lists every missing requirement the gate reported', async () => {
    previewInvoice.mockResolvedValue({
      readiness: { ready: false, reasons: [] },
      gate: { ok: false, required: [], present: [], missing: [] },
      releaseGate: {
        ok: false,
        missing: [
          { code: 'DOC_MISSING', detail: 'POD', message: 'Missing document: POD' },
          { code: 'REFERENCE_MISSING', detail: 'PO', message: 'Missing reference: PO number' },
        ],
      },
      snapshot: {},
      recipients: { to: [], cc: [] },
      attachments: [],
    })
    renderDetail('DELIVERED')
    fireEvent.click(screen.getByRole('tab', { name: 'Invoicing' }))

    const list = await screen.findByTestId('release-gate-missing')
    expect(list.textContent).toContain('Missing document: POD')
    expect(list.textContent).toContain('Missing reference: PO number')
  })

  it('says it is ready when the gate passes', async () => {
    previewInvoice.mockResolvedValue({
      readiness: { ready: true, reasons: [] },
      gate: { ok: true, required: [], present: [], missing: [] },
      releaseGate: { ok: true, missing: [] },
      snapshot: {},
      recipients: { to: [], cc: [] },
      attachments: [],
    })
    renderDetail('DELIVERED')
    fireEvent.click(screen.getByRole('tab', { name: 'Invoicing' }))

    expect((await screen.findByTestId('release-gate-ok')).textContent).toContain('Ready for accounting')
  })

  it('does not run the gate before the shipment is delivered', async () => {
    renderDetail('BOOKED')
    fireEvent.click(screen.getByRole('tab', { name: 'Invoicing' }))
    await waitFor(() => expect(screen.getByTestId('release-gate')).toBeTruthy())
    expect(previewInvoice).not.toHaveBeenCalled()
  })
})

describe('own fleet on the Carrier/Driver tab', () => {
  it('shows the driver, the truck, the trailer and where the load already is', async () => {
    renderDetail('BOOKED', {}, { loadCarriers: [ownAssetLeg()] })
    fireEvent.click(screen.getByRole('tab', { name: 'Carrier/Driver' }))

    await waitFor(() => expect(screen.getAllByText('Pavel Ivanov').length).toBeGreaterThan(0))
    expect(screen.getByText('204')).toBeTruthy()
    expect(screen.getByText('T-19')).toBeTruthy()

    const links = screen.getByTestId('own-fleet-links')
    expect(links.querySelector('a[href="/calendar"]')).toBeTruthy()
    expect(links.querySelector('a[href="/dispatch"]')).toBeTruthy()
    // No driver profile in the store, so the generic weekly settlement page.
    expect(screen.getByTestId('own-fleet-settlement').getAttribute('href')).toBe('/driver-pay')
  })
})

describe('the Overview Integrations card', () => {
  const otrRow = {
    id: 'OTR', provider: 'OTR', kind: 'PROVIDER' as const, mode: 'LIVE' as const,
    credentialSource: 'STACK' as const, status: 'CONNECTED' as const, health: 'OK' as const,
  }

  it('is hidden on a voided shipment', async () => {
    listIntegrations.mockResolvedValue([otrRow])
    const voided = { ...bundle('DELIVERED').shipment, voidedAt: '2026-02-01T00:00:00.000Z' }
    renderDetail('DELIVERED', { isAdmin: true }, { shipment: voided })

    await waitFor(() => expect(screen.getByText('Shipment')).toBeTruthy())
    expect(screen.queryByText('Integrations')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand integrations' })).toBeNull()
  })

  it('is not rendered — and the list is never asked for — for a non-admin viewer', async () => {
    renderDetail('BOOKED', { isAdmin: false })

    await waitFor(() => expect(screen.getByText('Shipment')).toBeTruthy())
    expect(screen.queryByText('Integrations')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand integrations' })).toBeNull()
    // LIST_INTEGRATIONS is owner/ADMIN only; a rep must not fire a refused call at all.
    expect(listIntegrations).not.toHaveBeenCalled()
  })

  it('offers a live link only for a connected live provider, and a stub run for the rest', async () => {
    listIntegrations.mockResolvedValue([otrRow])
    renderDetail('BOOKED', { isAdmin: true })

    const toggle = await screen.findByRole('button', { name: 'Expand integrations' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)

    // OTR is connected and live: the one factoring action that already exists, as a link
    // to where it lives. Step J adds no live action of its own.
    const otr = (await screen.findByText('OTR Solutions')).closest('li')
    expect(otr).toBeTruthy()
    expect(within(otr as HTMLElement).getByText('Connected')).toBeTruthy()
    expect(within(otr as HTMLElement).getByText('Send to Factor').getAttribute('href')).toBe('/tms/invoicing')
    expect(within(otr as HTMLElement).queryByText('Run stub')).toBeNull()

    // DAT has no row at all, so it is NOT_CONNECTED: a stub run and nothing live. It is
    // listed under Posting and again under Rating; Posting is the first section.
    const dat = screen.getAllByText('DAT')[0].closest('li')
    expect(dat).toBeTruthy()
    expect(within(dat as HTMLElement).getByText('Not connected')).toBeTruthy()
    expect(within(dat as HTMLElement).getByText('Run stub')).toBeTruthy()
    expect(within(dat as HTMLElement).queryByRole('link')).toBeNull()
    expect(within(dat as HTMLElement).queryByText('Open tracking')).toBeNull()
  })

  it('shows no live control for a connected provider whose check has not passed', async () => {
    listIntegrations.mockResolvedValue([{
      id: 'TRUCKER_TOOLS', provider: 'TRUCKER_TOOLS', kind: 'PROVIDER' as const, mode: 'LIVE' as const,
      credentialSource: 'PAGE' as const, status: 'CONNECTED' as const, health: 'UNABLE_TO_VERIFY' as const,
    }])
    renderDetail('BOOKED', { isAdmin: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Expand integrations' }))

    // Entered credentials are not a live integration: nothing in this repo tracks a load
    // through Trucker Tools, so the row offers the stub and says it is unverified.
    const row = screen.getByText('Trucker Tools').closest('li') as HTMLElement
    expect(within(row).getByText('Unable to verify')).toBeTruthy()
    expect(within(row).queryByText('Open tracking')).toBeNull()
    expect(within(row).getByText('Run stub')).toBeTruthy()
  })

  it('runs a stub without touching the shipment', async () => {
    listIntegrations.mockResolvedValue([])
    runIntegrationStub.mockResolvedValue({
      row: {}, result: { mode: 'STUB', ok: true, message: 'STUB — DAT post was not sent', externalId: 'stub:1' },
    })
    renderDetail('BOOKED', { isAdmin: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Expand integrations' }))
    const dat = screen.getAllByText('DAT')[0].closest('li') as HTMLElement
    fireEvent.click(within(dat).getByText('Run stub'))

    await waitFor(() => expect(screen.getByText('STUB — DAT post was not sent')).toBeTruthy())
    expect(runIntegrationStub).toHaveBeenCalledWith('DAT', 'post')
    expect(actions.reload).not.toHaveBeenCalled()
    expect(actions.load.onSetLoadStatus).not.toHaveBeenCalled()
  })
})
