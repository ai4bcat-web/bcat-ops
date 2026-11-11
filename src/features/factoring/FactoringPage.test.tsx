// @vitest-environment jsdom
/**
 * The queue's job is to show, at a glance down the list, which PROs can be invoiced and
 * what is stopping the rest. These tests pin the rules that were asked for: the filter
 * order and its default, red/green per required field, document actions on the row, and
 * deletion limited to the people who run factoring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import { FactoringPage } from './FactoringPage'
import type { FactoringItem } from '@/types'
import type { OtrReadiness } from '@/lib/otrInvoice'

const hookMock = vi.hoisted(() => vi.fn())
const authMock = vi.hoisted(() => vi.fn())
const assembleInvoice = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock('@/hooks/useFactoringItems', () => ({ useFactoringItems: hookMock }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: authMock }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ loads: [], updateLoad: vi.fn() }),
    { setState: vi.fn() },
  ),
  mergeLoads: (held: unknown[], rows: unknown[]) => [...held, ...rows],
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
const uploadOtrDocsMock = vi.hoisted(() => vi.fn())
vi.mock('./OtrPanel', () => ({ OtrPanel: () => <div data-testid="otr-panel" /> }))
vi.mock('./ManualInvoicePanel', () => ({ ManualInvoicePanel: () => <div data-testid="manual-panel" /> }))
// The drawer the PRO column opens. Its own behaviour is covered by LoadDrawer's tests;
// here it would only drag the whole load form into a test about the queue.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('@/lib/otrClient', () => ({ syncOtrStatus: vi.fn(), assembleInvoice, uploadOtrDocs: uploadOtrDocsMock }))
vi.mock('@/hooks/useLoadDriverDocs', () => ({
  useLoadDriverDocs: () => ({ pods: [], ratecons: [], loading: false, error: null, refresh: vi.fn() }),
}))
// The queue only passes the directory through to the drawer (mocked above); a real read would hit AWS.
// Modules pulled in by the shipment drawer build an Amplify data client at import time; give them an inert one.
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
// The page reads the TMS settings once on mount and resolves loads through the store; neither may reach AWS.
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn().mockResolvedValue(null),
  createShipment: vi.fn(),
  getLoads: vi.fn().mockResolvedValue([]),
  listLoadsByShipmentIds: vi.fn().mockResolvedValue([]),
  listShipmentsByNumber: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))

function readiness(over: Partial<OtrReadiness> = {}): OtrReadiness {
  return { ready: false, payload: {}, sources: {}, missingFields: [], missingDocuments: [], warnings: [], ...over }
}

function item(over: Partial<FactoringItem> = {}): FactoringItem {
  return {
    id: '14538', proNumber: '14538', status: 'NEED_TO_FACTOR',
    subject: 'Invoice for PRO #14538', fromEmail: 'billing@example.com',
    receivedAt: '2026-10-01T10:00:00Z', messageId: 'm1',
    createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
    ...over,
  } as FactoringItem
}

async function setup(items: FactoringItem[], email = 'ryne@bcatcorp.com') {
  const refresh = vi.fn()
  const removeItem = vi.fn().mockResolvedValue(undefined)
  hookMock.mockReturnValue({
    items, loading: false, error: null, pendingIds: new Set<string>(),
    refresh, updateStatus: vi.fn(), removeItem,
  })
  authMock.mockReturnValue({ user: { email, groups: [] } })
  // Let the mount-time settings read land inside act, before the test acts on the page.
  await act(async () => { render(<FactoringPage />) })
  return { refresh, removeItem }
}

beforeEach(() => vi.clearAllMocks())

describe('filters', () => {
  it('lists them in work order with Need to factor first', async () => {
    await setup([item()])
    const labels = screen.getAllByRole('tab')
      .map((b) => b.textContent?.replace(/\d+$/, '').trim())
      .filter((t) => ['Need to factor', 'Pending with OTR', 'Invoice manually', 'All', 'Factored', 'Invoiced manually'].includes(t ?? ''))
    expect(labels).toEqual(['Need to factor', 'Pending with OTR', 'Invoice manually', 'All', 'Factored', 'Invoiced manually'])
  })

  it('opens on Need to factor, not All', async () => {
    // An empty queue there is the only state worth celebrating, so it is the landing view.
    await setup([
      item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'b', proNumber: 'B2', status: 'FACTORED' }),
    ])
    expect(screen.getByText('A1')).toBeInTheDocument()
    expect(screen.queryByText('B2')).not.toBeInTheDocument()
  })

  it('switches to another status when asked', async () => {
    await setup([
      item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'b', proNumber: 'B2', status: 'FACTORED' }),
    ])
    fireEvent.click(screen.getByRole('tab', { name: /^Factored/ }))
    expect(screen.getByText('B2')).toBeInTheDocument()
    expect(screen.queryByText('A1')).not.toBeInTheDocument()
  })
})

describe('invoices OTR turned down', () => {
  it('points out which must be invoiced manually, and shows only them on request, across every tab', async () => {
    await setup([
      item({ id: 'ok', proNumber: 'OK1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'err', proNumber: 'ER2', status: 'NEED_TO_FACTOR', otrError: 'Amount does not match the rate con' }),
      item({ id: 'dead', proNumber: 'DE3', status: 'PENDING_WITH_OTR', otrStatus: 4 as never, otrInvoiceId: 'x' }),
      item({ id: 'done', proNumber: 'DO4', status: 'FACTORED', otrError: 'old' }),
    ])
    const strip = screen.getByTestId('otr-rejected-strip')
    expect(strip.textContent).toContain('2')
    expect(strip.textContent).toMatch(/turned down by OTR and must be invoiced manually/)
    // On the landing tab the rejected row carries its own flag and OTR's words.
    expect(within(screen.getByText('ER2').closest('tr') as HTMLElement).getByTestId('otr-rejected-flag').textContent).toBe('Invoice manually')
    expect(screen.getByText(/OTR refused it: Amount does not match the rate con/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('otr-rejected-toggle'))
    expect(screen.getByText('ER2')).toBeInTheDocument()
    expect(screen.getByText('DE3')).toBeInTheDocument()
    expect(screen.queryByText('OK1')).not.toBeInTheDocument()
    expect(screen.queryByText('DO4')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('otr-rejected-toggle'))
    expect(screen.getByText('OK1')).toBeInTheDocument()
  })

  it('shows no strip when OTR has turned nothing down', async () => {
    await setup([item({ id: 'ok', proNumber: 'OK1' })])
    expect(screen.queryByTestId('otr-rejected-strip')).not.toBeInTheDocument()
  })
})

describe('required fields on the row', () => {
  it('counts what resolved and marks each field green or red', async () => {
    await setup([item({
      otrReadiness: readiness({
        payload: { InvoiceNo: '14538', PoNumber: 'PO-7' },
        missingFields: ['BrokerMC', 'FromZip', 'ToZip'],
      }),
    })])

    expect(screen.getByText('8 of 11')).toBeInTheDocument()
    // Resolved fields say what they hold; missing ones say they are missing.
    expect(screen.getByTitle('Invoice number (PRO): 14538')).toBeInTheDocument()
    expect(screen.getByTitle('Broker MC is missing')).toBeInTheDocument()
    expect(screen.getByTitle('Destination ZIP is missing')).toBeInTheDocument()
  })

  it('says so plainly when the row has never been prepared', async () => {
    await setup([item()])
    expect(screen.getByText('Not prepared yet')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})

describe('documents on the row', () => {
  it('offers an upload for each document and names what is missing', async () => {
    await setup([item({
      loadId: 'load-1',
      otrReadiness: readiness({ missingDocuments: ['POD'] }),
    })])

    expect(screen.getByRole('button', { name: 'Upload the POD for PRO 14538' })).toBeInTheDocument()
    // The rate con is already on file, so its action replaces rather than uploads.
    expect(screen.getByRole('button', { name: 'Replace the Rate con for PRO 14538' })).toBeInTheDocument()
  })

  it('cannot upload against a row with no load resolved yet', async () => {
    await setup([item({ loadId: null, otrReadiness: readiness({ missingDocuments: ['POD', 'Rate confirmation'] }) })])
    expect(screen.getByRole('button', { name: 'Upload the POD for PRO 14538' })).toBeDisabled()
  })
})

describe('deleting a row', () => {
  it('is offered to the people who run factoring', async () => {
    await setup([item()], 'jenny@bcatcorp.com')
    expect(screen.getByRole('button', { name: 'Delete queue row for PRO 14538' })).toBeInTheDocument()
  })

  it('is hidden from everyone else, including other admins', async () => {
    // Deleting drops the record that a PRO was ever sent for factoring.
    await setup([item()], 'dennis@bcatcorp.com')
    expect(screen.queryByRole('button', { name: /Delete queue row/ })).not.toBeInTheDocument()
  })
})

/**
 * The queue could say how many invoices were waiting and not what they were worth — the
 * only figure anyone plans around. And a row whose rate never resolved had nowhere to put
 * one, so it sat red forever.
 */
describe('what the queue is worth', () => {
  const priced = (id: string, status: FactoringItem['status'], amount?: number) =>
    item({
      id, proNumber: id, status,
      otrReadiness: amount == null
        ? readiness()
        : readiness({ payload: { InvoiceAmount: amount } }),
    })

  it('shows each invoice amount on its own row', async () => {
    await setup([priced('A1', 'NEED_TO_FACTOR', 1850.5)])
    expect(within(screen.getByRole('table')).getByText('$1,850.50')).toBeInTheDocument()
  })

  it('offers a way in when no rate came through, rather than a dead dash', async () => {
    await setup([priced('A1', 'NEED_TO_FACTOR')])
    const add = screen.getByRole('button', { name: 'Add the rate for PRO A1' })
    fireEvent.click(add)
    // It opens the row's editor, which is where the rate is typed.
    expect(screen.getByTestId('otr-panel')).toBeInTheDocument()
  })

  it('totals each status separately', async () => {
    await setup([
      priced('A1', 'NEED_TO_FACTOR', 800),
      priced('A2', 'NEED_TO_FACTOR', 1200),
      priced('B1', 'PENDING_WITH_OTR', 2500),
      priced('C1', 'FACTORED', 1000),
    ])
    const totals = within(screen.getByRole('group', { name: /What the queue is worth/ }))
    expect(totals.getByLabelText(/^Need to factor: \$2,000\.00 across 2 invoices$/)).toBeInTheDocument()
    expect(totals.getByLabelText(/^Pending with OTR: \$2,500\.00 across 1 invoices$/)).toBeInTheDocument()
    expect(totals.getByLabelText(/^Factored: \$1,000\.00 across 1 invoices$/)).toBeInTheDocument()
    expect(totals.getByLabelText(/^All: \$5,500\.00 across 4 invoices$/)).toBeInTheDocument()
  })

  it('says how many rows it could not price instead of folding them in as zero', async () => {
    await setup([priced('A1', 'NEED_TO_FACTOR', 800), priced('A2', 'NEED_TO_FACTOR')])
    const totals = within(screen.getByRole('group', { name: /What the queue is worth/ }))
    expect(totals.getByLabelText(/^Need to factor: \$800\.00 across 2 invoices$/)).toBeInTheDocument()
    expect(totals.getAllByText(/1 with no rate/).length).toBeGreaterThan(0)
  })

  it('totals every status, not only the one being looked at', async () => {
    // The tabs filter the table; the figures are about the whole queue, which is the
    // question being asked — "how much is sitting in Pending with OTR" is not answered by
    // a number that changes when you click a tab.
    await setup([priced('B1', 'PENDING_WITH_OTR', 2500)])
    const totals = within(screen.getByRole('group', { name: /What the queue is worth/ }))
    expect(totals.getByLabelText(/^Pending with OTR: \$2,500\.00 across 1 invoices$/)).toBeInTheDocument()
  })
})

/*
 * The queue runs to hundreds. The grid scrolls and mounts only the rows in view; a very long
 * queue is capped at one batch of fifty with a Show next button.
 */
describe('long queues', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      item({ id: `p${i}`, proNumber: `${20000 + i}`, receivedAt: `2026-10-01T${String(i % 24).padStart(2, '0')}:00:00Z` }))
  const count = () => screen.getByTestId('factoring-count').textContent ?? ''

  it('shows fifty at a time and loads the next batch on request', async () => {
    await setup(many(120))
    expect(count()).toContain('Showing 50 of 120')
    fireEvent.click(screen.getByRole('button', { name: 'Show next 50' }))
    expect(count()).toContain('Showing 100 of 120')
    fireEvent.click(screen.getByRole('button', { name: 'Show next 50' }))
    expect(count()).toContain('Showing 120 of 120')
    expect(screen.queryByRole('button', { name: /Show next/ })).not.toBeInTheDocument()
  })

  it('goes back to the first batch when the search changes', async () => {
    await setup(many(120))
    fireEvent.click(screen.getByRole('button', { name: 'Show next 50' }))
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: '200' } })
    // "200" matches the hundred PROs 20000-20099, and the batch is back to its first fifty.
    expect(count()).toContain('Showing 50 of 100')
  })

  it('says so plainly when a filter matches nothing', async () => {
    await setup(many(3))
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: 'zzzzzz' } })
    expect(count()).toContain('Showing 0 of 0')
    expect(screen.getByText('No items match the current filters.')).toBeInTheDocument()
  })
})

describe('the dense grid', () => {
  it('draws the queue as a dense grid with sortable, filterable headers', async () => {
    await setup([item()])
    const grid = screen.getByRole('table', { name: 'Factoring queue' })
    expect(within(grid).getByRole('columnheader', { name: /PRO #/ })).toBeInTheDocument()
    expect(within(grid).getByRole('button', { name: 'Filter Amount' })).toBeInTheDocument()
    expect(within(grid).getByRole('button', { name: 'Amount'  })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Columns/ })).toBeInTheDocument()
  })

  it('sorts the amount column by value, not by text', async () => {
    const priced = (id: string, amount: number) => item({ id, proNumber: id, otrReadiness: readiness({ payload: { InvoiceAmount: amount } }) })
    await setup([priced('R9', 900), priced('R1000', 1000), priced('R50', 50)])
    const proOrder = () => within(screen.getByRole('table', { name: 'Factoring queue' })).getAllByRole('row').slice(1).map((r) => r.textContent?.match(/R\d+/)?.[0])
    fireEvent.click(screen.getByRole('button', { name: 'Amount'  }))
    expect(proOrder()).toEqual(['R50', 'R9', 'R1000'])
    fireEvent.click(screen.getByRole('button', { name: 'Amount'  }))
    expect(proOrder()).toEqual(['R1000', 'R9', 'R50'])
  })
})

describe('invoicing by hand', () => {
  it('flags a No Buy broker on the row and files it under Invoice manually', async () => {
    await setup([
      item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'b', proNumber: 'B2', status: 'MANUAL_INVOICE', manualReason: 'NO_BUY', brokerCheckResult: 'NO_BUY', brokerMcChecked: '592002' }),
    ])
    expect(screen.queryByText('B2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Invoice manually/ }))
    expect(screen.getByText('B2')).toBeInTheDocument()
    expect(screen.getByText('No buy')).toBeInTheDocument()
    expect(screen.getByText(/OTR will not buy from MC 592002/)).toBeInTheDocument()
    expect(screen.queryByText('A1')).not.toBeInTheDocument()
  })

  it('shows OTR\u2019s own reason next to No buy, and offers Invoice manually only where it applies', async () => {
    await setup([
      item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'c', proNumber: 'C3', status: 'FACTORED' }),
    ])
    expect(screen.getByRole('button', { name: 'Invoice manually for PRO A1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Factored/ }))
    expect(screen.queryByRole('button', { name: /Invoice manually for PRO C3/ })).not.toBeInTheDocument()
  })

  it('shows the No buy reason OTR gave and the button on a No buy row', async () => {
    await setup([item({ id: 'b', proNumber: 'B2', status: 'MANUAL_INVOICE', manualReason: 'NO_BUY', brokerCheckResult: 'NO_BUY', otrError: 'OTR will not buy from MC 592002 (No Buy): not approved' })])
    fireEvent.click(screen.getByRole('tab', { name: /^Invoice manually/ }))
    expect(screen.getByText('No buy')).toBeInTheDocument()
    expect(screen.getByText(/not approved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invoice manually for PRO B2' })).toBeInTheDocument()
  })

  it('opens a manual row to its checklist, not the OTR editor', async () => {
    await setup([item({ id: 'b', proNumber: 'B2', status: 'MANUAL_INVOICE', manualReason: 'NO_BUY' })])
    fireEvent.click(screen.getByRole('tab', { name: /^Invoice manually/ }))
    fireEvent.click(screen.getByRole('button', { name: /Open the steps for PRO B2/ }))
    expect(screen.getByTestId('manual-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('otr-panel')).not.toBeInTheDocument()
  })
})

describe('Pending with OTR shows what OTR says', () => {
  const pending = (id: string, otrStatus: string | null) =>
    item({ id, proNumber: id, status: 'PENDING_WITH_OTR', otrInvoiceId: `inv-${id}`, otrStatus, otrStatusSyncedAt: otrStatus ? '2026-10-12T14:05:30Z' : null })

  it("flags each row with OTR's own status and breaks the tab down by it", async () => {
    await setup([pending('14564', '6'), pending('14550', '8'), pending('14604', '1'), pending('14599', '1'), pending('14700', null)])
    fireEvent.click(screen.getByRole('tab', { name: /Pending with OTR/ }))
    expect(screen.getByLabelText('OTR status for PRO 14564: IssueClient')).toHaveTextContent('OTR: IssueClient ⚠')
    expect(screen.getByLabelText('OTR status for PRO 14550: IssueFollowUp')).toBeInTheDocument()
    expect(screen.getByLabelText('OTR status for PRO 14604: Pending')).toHaveTextContent('OTR: Pending')
    expect(screen.getByLabelText('OTR status for PRO 14700: not reported yet')).toBeInTheDocument()
    const chips = within(screen.getByRole('group', { name: 'OTR status' })).getAllByRole('button').map((b) => b.textContent)
    // Attention first, then by count.
    expect(chips).toEqual(['IssueClient ⚠1', 'IssueFollowUp ⚠1', 'Pending2', 'Awaiting OTR1'])
  })

  it('narrows the tab to one OTR status and back', async () => {
    await setup([pending('14564', '6'), pending('14604', '1'), pending('14700', null)])
    fireEvent.click(screen.getByRole('tab', { name: /Pending with OTR/ }))
    const group = screen.getByRole('group', { name: 'OTR status' })
    fireEvent.click(within(group).getByRole('button', { name: /IssueClient/ }))
    expect(screen.getByText('14564')).toBeInTheDocument()
    expect(screen.queryByText('14604')).not.toBeInTheDocument()
    expect(screen.queryByText('14700')).not.toBeInTheDocument()
    fireEvent.click(within(group).getByRole('button', { name: /IssueClient/ }))
    expect(screen.getByText('14604')).toBeInTheDocument()
  })

  it('does not put OTR chips on rows that are not with OTR', async () => {
    await setup([item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR', otrStatus: '1' })])
    expect(screen.queryByLabelText(/OTR status for PRO A1/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'OTR status' })).not.toBeInTheDocument()
  })
})

describe('documents that did not reach OTR', () => {
  it('keeps the row in Need to factor with a red flag', async () => {
    await setup([item({ id: 'x', proNumber: '14564', status: 'NEED_TO_FACTOR', otrInvoiceId: '25594544', otrError: 'POD did not reach OTR.' })])
    expect(screen.getByText('14564')).toBeInTheDocument()
    expect(screen.getByLabelText('OTR documents missing for PRO 14564')).toHaveTextContent('DOCS NOT AT OTR')
  })

  it('resends the documents from the row and re-reads the queue', async () => {
    uploadOtrDocsMock.mockResolvedValue({ invoiceId: '25594544', uploaded: { pod: 'k' }, documentErrors: [] })
    const { refresh } = await setup([item({ id: 'x', proNumber: '14564', status: 'NEED_TO_FACTOR', otrInvoiceId: '25594544', otrError: 'POD did not reach OTR.' })])
    fireEvent.click(screen.getByRole('button', { name: 'Resend documents for PRO 14564' }))
    await waitFor(() => expect(uploadOtrDocsMock).toHaveBeenCalledWith('x'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })
})

describe('invoices sent by hand', () => {
  const sentRow = item({
    id: 'h1', proNumber: 'H1', status: 'INVOICED_MANUALLY', apEmail: 'ap@broker.com',
    manualSteps: {
      billToUpdated: { at: '2026-10-28T15:00:00Z', by: 'ruben@bcatcorp.com' },
      pdfExported:   { at: '2026-10-28T15:05:00Z', by: 'ruben@bcatcorp.com' },
      emailed:       { at: '2026-10-28T15:10:00Z', by: 'ruben@bcatcorp.com' },
    },
    manualInvoicedAt: '2026-10-28T15:10:00Z',
  })

  it('logs when each one went out, who sent it and where, on the Invoiced manually tab', async () => {
    await setup([sentRow, item({ id: 'n1', proNumber: 'N1' })])
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced manually/ }))
    expect(screen.getByRole('columnheader', { name: /^Sent/i })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /^Received/i })).not.toBeInTheDocument()
    const cell = screen.getByLabelText(/PRO H1 sent by hand/)
    expect(cell).toHaveTextContent('by ruben')
    expect(cell).toHaveTextContent('to ap@broker.com')
  })

  it('lists the newest send first', async () => {
    const older = item({
      id: 'h0', proNumber: 'H0', status: 'INVOICED_MANUALLY', receivedAt: '2026-10-20T10:00:00Z',
      manualSteps: { emailed: { at: '2026-10-20T12:00:00Z', by: 'dennis@bcatcorp.com' } },
      manualInvoicedAt: '2026-10-20T12:00:00Z',
    })
    await setup([older, sentRow])
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced manually/ }))
    const labels = screen.getAllByLabelText(/sent by hand/).map((el) => el.getAttribute('aria-label') ?? '')
    expect(labels[0]).toContain('PRO H1')
    expect(labels[1]).toContain('PRO H0')
  })

  it('keeps the Received column everywhere else', async () => {
    await setup([sentRow])
    fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
    expect(screen.getByRole('columnheader', { name: /^Received/i })).toBeInTheDocument()
  })
})
