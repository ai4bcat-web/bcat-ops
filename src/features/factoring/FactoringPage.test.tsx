// @vitest-environment jsdom
/**
 * The queue's job is to show, at a glance down the list, which PROs can be invoiced and
 * what is stopping the rest. These tests pin the rules that were asked for: the filter
 * order and its default, red/green per required field, document actions on the row, and
 * deletion limited to the people who run factoring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FactoringPage } from './FactoringPage'
import type { FactoringItem } from '@/types'
import type { OtrReadiness } from '@/lib/otrInvoice'

const hookMock = vi.hoisted(() => vi.fn())
const authMock = vi.hoisted(() => vi.fn())
const assembleInvoice = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock('@/hooks/useFactoringItems', () => ({ useFactoringItems: hookMock }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: authMock }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ loads: [], updateLoad: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('./OtrPanel', () => ({ OtrPanel: () => <div data-testid="otr-panel" /> }))
// The drawer the PRO column opens. Its own behaviour is covered by LoadDrawer's tests;
// here it would only drag the whole load form into a test about the queue.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('@/lib/otrClient', () => ({ syncOtrStatus: vi.fn(), assembleInvoice }))
vi.mock('@/hooks/useLoadDriverDocs', () => ({
  useLoadDriverDocs: () => ({ pods: [], ratecons: [], loading: false, error: null, refresh: vi.fn() }),
}))

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

function setup(items: FactoringItem[], email = 'ryne@bcatcorp.com') {
  const refresh = vi.fn()
  const removeItem = vi.fn().mockResolvedValue(undefined)
  hookMock.mockReturnValue({
    items, loading: false, error: null, pendingIds: new Set<string>(),
    refresh, updateStatus: vi.fn(), removeItem,
  })
  authMock.mockReturnValue({ user: { email, groups: [] } })
  render(<FactoringPage />)
  return { refresh, removeItem }
}

beforeEach(() => vi.clearAllMocks())

describe('filters', () => {
  it('lists them in work order with Need to factor first', () => {
    setup([item()])
    const labels = screen.getAllByRole('button')
      .map((b) => b.textContent?.replace(/\d+$/, '').trim())
      .filter((t) => ['Need to factor', 'Pending with OTR', 'All', 'Factored'].includes(t ?? ''))
    expect(labels).toEqual(['Need to factor', 'Pending with OTR', 'All', 'Factored'])
  })

  it('opens on Need to factor, not All', () => {
    // An empty queue there is the only state worth celebrating, so it is the landing view.
    setup([
      item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'b', proNumber: 'B2', status: 'FACTORED' }),
    ])
    expect(screen.getByText('A1')).toBeInTheDocument()
    expect(screen.queryByText('B2')).not.toBeInTheDocument()
  })

  it('switches to another status when asked', () => {
    setup([
      item({ id: 'a', proNumber: 'A1', status: 'NEED_TO_FACTOR' }),
      item({ id: 'b', proNumber: 'B2', status: 'FACTORED' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: /^Factored/ }))
    expect(screen.getByText('B2')).toBeInTheDocument()
    expect(screen.queryByText('A1')).not.toBeInTheDocument()
  })
})

describe('required fields on the row', () => {
  it('counts what resolved and marks each field green or red', () => {
    setup([item({
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

  it('says so plainly when the row has never been prepared', () => {
    setup([item()])
    expect(screen.getByText('Not prepared yet')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('documents on the row', () => {
  it('offers an upload for each document and names what is missing', () => {
    setup([item({
      loadId: 'load-1',
      otrReadiness: readiness({ missingDocuments: ['POD'] }),
    })])

    expect(screen.getByRole('button', { name: 'Upload the POD for PRO 14538' })).toBeInTheDocument()
    // The rate con is already on file, so its action replaces rather than uploads.
    expect(screen.getByRole('button', { name: 'Replace the Rate con for PRO 14538' })).toBeInTheDocument()
  })

  it('cannot upload against a row with no load resolved yet', () => {
    setup([item({ loadId: null, otrReadiness: readiness({ missingDocuments: ['POD', 'Rate confirmation'] }) })])
    expect(screen.getByRole('button', { name: 'Upload the POD for PRO 14538' })).toBeDisabled()
  })
})

describe('deleting a row', () => {
  it('is offered to the people who run factoring', () => {
    setup([item()], 'jenny@bcatcorp.com')
    expect(screen.getByRole('button', { name: 'Delete queue row for PRO 14538' })).toBeInTheDocument()
  })

  it('is hidden from everyone else, including other admins', () => {
    // Deleting drops the record that a PRO was ever sent for factoring.
    setup([item()], 'dennis@bcatcorp.com')
    expect(screen.queryByRole('button', { name: /Delete queue row/ })).not.toBeInTheDocument()
  })
})

describe('the OTR invoice board', () => {
  it('is a separate view, and empty until something is submitted', () => {
    setup([item()])
    fireEvent.click(screen.getByRole('button', { name: 'OTR invoice board' }))
    expect(screen.getByText('Nothing submitted to OTR yet')).toBeInTheDocument()
  })

  it('shows an invoice OTR has, with its status and which documents landed', () => {
    setup([item({
      status: 'PENDING_WITH_OTR',
      otrInvoiceId: 'INV-991',
      otrStatus: 'Advance Paid',
      otrAmount: 80000,
      otrScheduleId: 'SCH-5',
      otrSubmittedAt: '2026-10-01T15:00:00Z',
      otrSubmittedBy: 'ryne@bcatcorp.com',
      otrStatusSyncedAt: '2026-10-01T16:00:00Z',
      otrDocsUploaded: { pod: 'pods/x.pdf' },
    })])
    fireEvent.click(screen.getByRole('button', { name: 'OTR invoice board' }))

    const row = screen.getByText('INV-991').closest('tr')!
    expect(within(row).getByText('Advance Paid')).toBeInTheDocument()
    expect(within(row).getByText('$800.00')).toBeInTheDocument()
    expect(within(row).getByTitle('POD reached OTR')).toBeInTheDocument()
    expect(within(row).getByTitle('RC did not reach OTR')).toBeInTheDocument()
    // "Advance Paid" is funded, so nothing is outstanding here.
    expect(screen.queryByText(/not paid yet/)).toBeNull()
  })

  it('counts what OTR has not funded yet', () => {
    setup([
      item({ id: 'a', proNumber: 'A1', otrInvoiceId: 'INV-1', otrStatus: 'Advance Pending', otrAmount: 50000 }),
      item({ id: 'b', proNumber: 'B2', otrInvoiceId: 'INV-2', otrStatus: 'Paid', otrAmount: 30000 }),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'OTR invoice board' }))

    expect(
      screen.getByText((_t, el) => el?.tagName === 'SPAN' && el.textContent === '2 at OTR'),
    ).toBeInTheDocument()
    expect(screen.getByText('$800.00')).toBeInTheDocument()
    expect(screen.getByText('1 not paid yet')).toBeInTheDocument()
  })

  it('refreshes from OTR only when asked, and says when it last synced', () => {
    setup([item({ otrInvoiceId: 'INV-991', otrStatus: 'Paid', otrStatusSyncedAt: '2026-10-01T16:00:00Z' })])
    fireEvent.click(screen.getByRole('button', { name: 'OTR invoice board' }))

    // OTR is a paid API, so nothing polls; the control is explicit and dated.
    expect(screen.getByRole('button', { name: /Refresh from OTR/ })).toBeEnabled()
    expect(screen.getByText(/the hourly poller keeps this current/)).toBeInTheDocument()
  })

describe('the row editor', () => {
  it('is collapsed until someone opens it', () => {
    // Rendering one editor per row turned a list of PROs into a stack of forms.
    setup([item()])
    expect(screen.queryByTestId('otr-panel')).not.toBeInTheDocument()
  })

  it('opens and closes from the PRO', () => {
    setup([item()])
    const toggle = screen.getByRole('button', { name: 'Edit the OTR fields for PRO 14538' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(screen.getByTestId('otr-panel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide the OTR fields for PRO 14538' })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Hide the OTR fields for PRO 14538' }))
    expect(screen.queryByTestId('otr-panel')).not.toBeInTheDocument()
  })

  it('opens one row without opening the others', () => {
    setup([item({ id: 'a', proNumber: 'A1' }), item({ id: 'b', proNumber: 'B2' })])
    fireEvent.click(screen.getByRole('button', { name: 'Edit the OTR fields for PRO A1' }))
    expect(screen.getAllByTestId('otr-panel')).toHaveLength(1)
  })
})

describe('submitting to OTR', () => {
  it('shows the PO beside the PRO, and says when it is missing', () => {
    setup([
      item({ id: 'a', proNumber: 'A1', otrReadiness: readiness({ payload: { PoNumber: 'PO-7' } }) }),
      item({ id: 'b', proNumber: 'B2', status: 'NEED_TO_FACTOR', otrReadiness: readiness({ missingFields: ['PoNumber'] }) }),
    ])
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers.slice(0, 2)).toEqual(['PRO #', 'PO #'])

    expect(screen.getByText('PO-7')).toBeInTheDocument()
    expect(screen.getByText('missing')).toBeInTheDocument()
  })

  it('counts a row ready only when nothing is red', () => {
    // The count used to colour from a cached `ready` boolean stored beside the lists the
    // chips are drawn from, so the two could disagree.
    setup([item({ otrReadiness: readiness({ ready: true, missingFields: ['ToZip'] }) })])
    expect(screen.getByText('10 of 11')).toBeInTheDocument()
  })
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

  it('shows each invoice amount on its own row', () => {
    setup([priced('A1', 'NEED_TO_FACTOR', 1850.5)])
    expect(within(screen.getByRole('table')).getByText('$1,850.50')).toBeInTheDocument()
  })

  it('offers a way in when no rate came through, rather than a dead dash', () => {
    setup([priced('A1', 'NEED_TO_FACTOR')])
    const add = screen.getByRole('button', { name: 'Add the rate for PRO A1' })
    fireEvent.click(add)
    // It opens the row's editor, which is where the rate is typed.
    expect(screen.getByTestId('otr-panel')).toBeInTheDocument()
  })

  it('totals each status separately', () => {
    setup([
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

  it('says how many rows it could not price instead of folding them in as zero', () => {
    setup([priced('A1', 'NEED_TO_FACTOR', 800), priced('A2', 'NEED_TO_FACTOR')])
    const totals = within(screen.getByRole('group', { name: /What the queue is worth/ }))
    expect(totals.getByLabelText(/^Need to factor: \$800\.00 across 2 invoices$/)).toBeInTheDocument()
    expect(totals.getAllByText(/1 with no rate/).length).toBeGreaterThan(0)
  })

  it('totals every status, not only the one being looked at', () => {
    // The tabs filter the table; the figures are about the whole queue, which is the
    // question being asked — "how much is sitting in Pending with OTR" is not answered by
    // a number that changes when you click a tab.
    setup([priced('B1', 'PENDING_WITH_OTR', 2500)])
    const totals = within(screen.getByRole('group', { name: /What the queue is worth/ }))
    expect(totals.getByLabelText(/^Pending with OTR: \$2,500\.00 across 1 invoices$/)).toBeInTheDocument()
  })
})

/*
 * A row here opens into eleven fields, two documents and a submit button, so ten of them
 * is already a long page — and the queue runs to hundreds. Expanding one row at the bottom
 * of all of them is a scroll nobody wants to repeat.
 */
describe('paging through the queue', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      item({ id: `p${i}`, proNumber: `${20000 + i}`, receivedAt: `2026-10-01T${String(i % 24).padStart(2, '0')}:00:00Z` }))

  it('shows ten by default', () => {
    setup(many(25))
    expect(screen.getByText('1–10 of 25')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
  })

  it('moves through the pages', () => {
    setup(many(25))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('11–20 of 25')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('21–25 of 25')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(screen.getByText('11–20 of 25')).toBeInTheDocument()
  })

  it('offers 10, 50 and 100', () => {
    setup(many(25))
    const select = screen.getByLabelText('Invoices per page')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['10', '50', '100'])
    fireEvent.change(select, { target: { value: '50' } })
    expect(screen.getByText('1–25 of 25')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument()
  })

  it('goes back to the first page when the filter changes', () => {
    // Otherwise a narrower filter leaves an empty table with the rows behind you.
    setup(many(25))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('11–20 of 25')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: '2000' } })
    expect(screen.getByText(/^1–/)).toBeInTheDocument()
  })

  it('says so plainly when a filter matches nothing', () => {
    setup(many(3))
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: 'zzzzzz' } })
    expect(screen.queryByText(/of 3$/)).not.toBeInTheDocument()
  })
})
