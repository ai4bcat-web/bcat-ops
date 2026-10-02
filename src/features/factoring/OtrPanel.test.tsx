// @vitest-environment jsdom
/**
 * The panel's job is to let a person close the gap between what OTR needs and what we
 * know. These tests pin the two things that made it useless before: it could never
 * render at all, and there was no way to supply a missing field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OtrPanel } from './OtrPanel'
import type { OtrReadiness } from '@/lib/otrInvoice'
import type { FactoringItem } from '@/types'

const setFactoringManualFields = vi.hoisted(() => vi.fn())
const assembleInvoice = vi.hoisted(() => vi.fn())
const setBrokerMc = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({ setFactoringManualFields }))
vi.mock('@/lib/otrClient', () => ({
  assembleInvoice,
  setBrokerMc,
  checkBroker: vi.fn(),
  submitToOtr: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ALL_FIELDS = {
  InvoiceNo: '13364', PoNumber: 'PO-7', BrokerMC: '999999',
  InvoiceAmount: 1850, InvoiceDate: '2026-09-29',
  FromCity: 'CHICAGO', FromState: 'IL', FromZip: '60601',
  ToCity: 'DETROIT', ToState: 'MI', ToZip: '48201',
} as const

function readiness(over: Partial<OtrReadiness> = {}): OtrReadiness {
  return { ready: false, payload: {}, sources: {}, missingFields: [], missingDocuments: [], warnings: [], ...over }
}

function item(over: Partial<FactoringItem> = {}): FactoringItem {
  return {
    id: '13364',
    proNumber: '13364',
    status: 'NEED_TO_FACTOR',
    subject: 'Invoice for PRO #13364',
    fromEmail: 'billing@example.com',
    receivedAt: '2026-09-29T10:00:00Z',
    messageId: 'm1',
    createdAt: '2026-09-29T10:00:00Z',
    updatedAt: '2026-09-29T10:00:00Z',
    ...over,
  } as FactoringItem
}

beforeEach(() => {
  vi.clearAllMocks()
  setFactoringManualFields.mockResolvedValue(undefined)
  assembleInvoice.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('OtrPanel', () => {
  it('renders the cached readiness instead of asking to prepare again', () => {
    // The row's readiness is cached by the Lambda. The panel used to miss it because
    // the query never selected the column, so it always offered "Prepare".
    render(<OtrPanel item={item({ otrReadiness: readiness({ payload: ALL_FIELDS }) })} onChanged={vi.fn()} />)

    expect(screen.queryByText('Not yet prepared for OTR.')).not.toBeInTheDocument()
    expect(screen.getByText('13364')).toBeInTheDocument()
    expect(screen.getByText('60601')).toBeInTheDocument()
  })

  it('offers an input for a field OTR needs and nobody has supplied', () => {
    render(
      <OtrPanel
        item={item({ otrReadiness: readiness({ payload: { ...ALL_FIELDS, ToZip: undefined }, missingFields: ['ToZip'] }) })}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Destination ZIP for PRO 13364')).toBeInTheDocument()
  })

  it('saves a typed field and re-derives readiness from it', async () => {
    const onChanged = vi.fn()
    const r = readiness({ payload: { ...ALL_FIELDS, ToZip: undefined }, missingFields: ['ToZip'] })
    render(<OtrPanel item={item({ otrReadiness: r, otrManualFields: { FromZip: '60601' } })} onChanged={onChanged} />)

    fireEvent.change(screen.getByLabelText('Destination ZIP for PRO 13364'), { target: { value: '48201' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(setFactoringManualFields).toHaveBeenCalledTimes(1))
    // Existing overrides are preserved — a save is a merge, not a replacement.
    expect(setFactoringManualFields).toHaveBeenCalledWith('13364', { FromZip: '60601', ToZip: '48201' })
    // Typing a value is not enough; the payload has to be reassembled from it.
    await waitFor(() => expect(assembleInvoice).toHaveBeenCalledWith('13364'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('leaves a resolved value alone but allows an override', async () => {
    const r = readiness({ payload: ALL_FIELDS, sources: { ToZip: 'geocode' } })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByText('(geocoded)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Override Destination ZIP for PRO 13364' }))

    const input = screen.getByLabelText('Destination ZIP for PRO 13364')
    expect(input).toHaveValue('')  // an override starts empty, not pre-filled with the guess
    fireEvent.change(input, { target: { value: '48202' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(setFactoringManualFields).toHaveBeenCalledWith('13364', { ToZip: '48202' }))
  })

  it('pre-fills a value someone already typed so it can be corrected', () => {
    const r = readiness({ payload: ALL_FIELDS, sources: { ToZip: 'manual' } })
    render(<OtrPanel item={item({ otrReadiness: r, otrManualFields: { ToZip: '48201' } })} onChanged={vi.fn()} />)

    expect(screen.getByText('(entered)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change Destination ZIP for PRO 13364' }))
    expect(screen.getByLabelText('Destination ZIP for PRO 13364')).toHaveValue('48201')
  })

  it('keeps broker MC on its own control, because it saves to the customer', () => {
    // A per-row override would fix this invoice and leave the broker's next one blank.
    const r = readiness({ payload: { ...ALL_FIELDS, BrokerMC: undefined }, missingFields: ['BrokerMC'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Save MC' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Override Broker MC/ })).not.toBeInTheDocument()
  })

  it('will not submit while a document is missing, and says which', () => {
    const r = readiness({ payload: ALL_FIELDS, missingDocuments: ['POD'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByText(/Missing POD/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Submit to OTR/ })).toBeDisabled()
  })
})

describe('the submit guard', () => {
  it('refuses while any required field is red, even if the cached flag says ready', async () => {
    // `ready` and `missingFields` are two separate stored values. A stale `ready: true`
    // used to enable Submit while the row still showed red — the exact contradiction
    // someone reports as "it let me submit".
    const r = readiness({ ready: true, payload: ALL_FIELDS, missingFields: ['ToZip'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    const submit = screen.getByRole('button', { name: /Submit to OTR/ })
    expect(submit).toBeDisabled()
    expect(submit.title).toContain('Destination ZIP')
  })

  it('refuses while a document is missing', async () => {
    const r = readiness({ ready: true, payload: ALL_FIELDS, missingDocuments: ['POD'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    const submit = screen.getByRole('button', { name: /Submit to OTR/ })
    expect(submit).toBeDisabled()
    expect(submit.title).toContain('POD')
  })

  it('allows it once every field and both documents are in', async () => {
    const r = readiness({ ready: false, payload: ALL_FIELDS })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Submit to OTR/ })).toBeEnabled()
  })
})
