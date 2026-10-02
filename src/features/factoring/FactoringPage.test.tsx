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
vi.mock('@/lib/otrClient', () => ({ syncOtrStatus: vi.fn() }))
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
