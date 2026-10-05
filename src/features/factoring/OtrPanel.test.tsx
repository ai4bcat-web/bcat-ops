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
const uploadOtrDocs = vi.hoisted(() => vi.fn().mockResolvedValue({ documentErrors: [] }))

vi.mock('@/lib/apiClient', () => ({ setFactoringManualFields }))
vi.mock('@/lib/otrClient', () => ({
  assembleInvoice,
  setBrokerMc,
  checkBroker: vi.fn(),
  submitToOtr: vi.fn(),
  uploadOtrDocs,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@bcatcorp.com' }) }))
vi.mock('@/hooks/useLoadDriverDocs', () => ({
  useLoadDriverDocs: () => ({ pods: [], ratecons: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ loads: [], updateLoad: vi.fn() }),
}))

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
    fireEvent.click(screen.getByRole('button', { name: 'Save Destination ZIP for PRO 13364' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Save Destination ZIP for PRO 13364' }))

    await waitFor(() => expect(setFactoringManualFields).toHaveBeenCalledWith('13364', { ToZip: '48202' }))
  })

  it('pre-fills a value someone already typed so it can be corrected', () => {
    const r = readiness({ payload: ALL_FIELDS, sources: { ToZip: 'manual' } })
    render(<OtrPanel item={item({ otrReadiness: r, otrManualFields: { ToZip: '48201' } })} onChanged={vi.fn()} />)

    expect(screen.getByText('(entered)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change Destination ZIP for PRO 13364' }))
    expect(screen.getByLabelText('Destination ZIP for PRO 13364')).toHaveValue('48201')
  })

  it('takes the broker MC in the field grid, and saves it to the customer', async () => {
    // It sits with the other fields now rather than on a control of its own — but it still
    // saves onto the CUSTOMER. A per-row override would fix this invoice and leave the
    // broker's next one blank.
    const r = readiness({ payload: { ...ALL_FIELDS, BrokerMC: undefined }, missingFields: ['BrokerMC'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Broker MC for PRO 13364'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Broker MC for PRO 13364' }))

    await waitFor(() => expect(setBrokerMc).toHaveBeenCalledWith('13364', '123456'))
    expect(setFactoringManualFields).not.toHaveBeenCalled()
  })

  it('says where the customer name came from, rather than calling it confirmed', () => {
    /*
     * Nothing looks an MC up. A broker record's name comes from the load and its MC from
     * whoever typed one, so the two agreeing is not evidence of anything — and this row
     * used to report exactly that pairing as "from the MC".
     */
    const r = readiness({
      payload: ALL_FIELDS,
      customerName: 'AMERIFREIGHT SYSTEMS LLC',
      customerSource: 'directory',
    })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByText('AMERIFREIGHT SYSTEMS LLC')).toBeInTheDocument()
    expect(screen.getByText(/not checked against the MC/)).toBeInTheDocument()
  })

  it('does not let anyone type a customer name', () => {
    /*
     * The customer comes from the MC and nothing else. Typing a broker's name asserts it
     * without checking it, and the typed value then sat on the invoice looking exactly as
     * settled as a resolved one. Fixing a wrong name means fixing the Broker MC.
     */
    const r = readiness({ payload: ALL_FIELDS, customerName: 'AMERIFREIGHT SYSTEMS LLC', customerSource: 'directory' })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByText('AMERIFREIGHT SYSTEMS LLC')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Correct the customer/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save Customer/ })).not.toBeInTheDocument()
  })

  it('asks for the MC when no customer has been resolved', () => {
    const r = readiness({ payload: ALL_FIELDS, customerName: null, customerSource: null })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)
    expect(screen.getByText('Enter the Broker MC to name it')).toBeInTheDocument()
  })

  it('marks a missing field red, so the gaps stand out once the row is open', () => {
    /*
     * The green/red chips are on the COLLAPSED row — the one place nobody is looking once
     * they have opened it. An opened row used to show the four fields holding the invoice
     * up exactly like the seven that were already fine.
     */
    const r = readiness({ payload: { ...ALL_FIELDS, ToZip: undefined }, missingFields: ['ToZip'] })
    const { container } = render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    const label = screen.getByText('Destination ZIP')
    expect(label.className).toMatch(/text-red-700/)
    expect(container.querySelector('.bg-red-50')).not.toBeNull()
  })

  it('asks for the customer in red when the row has none', () => {
    const r = readiness({ payload: { ...ALL_FIELDS, BrokerMC: undefined }, missingFields: ['BrokerMC'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)
    expect(screen.getByLabelText('Customer for PRO 13364')).toBeInTheDocument()
  })

  it('marks a name that came off the load as exactly that', () => {
    // A tender often names a shipper or an agent rather than the broker being factored.
    const r = readiness({ payload: ALL_FIELDS, customerName: 'MILWOOD', customerSource: 'load' })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)
    expect(screen.getByText(/from the load, often a shipper/)).toBeInTheDocument()
  })

  it('will not submit while a document is missing, and says which', () => {
    const r = readiness({ payload: ALL_FIELDS, missingDocuments: ['POD'] })
    render(<OtrPanel item={item({ otrReadiness: r })} onChanged={vi.fn()} />)

    expect(screen.getByText(/will not take this invoice without the POD/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Submit to OTR/ })).toBeDisabled()
    // And the way to fix it is right there, rather than back on the collapsed row.
    expect(screen.getByRole('button', { name: /Upload the POD for PRO 13364/ })).toBeInTheDocument()
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


/**
 * Submitting creates the invoice and attaches the paperwork afterwards, and it refuses to
 * run twice — correctly, or a retry would mean a second invoice at a factoring company.
 * So a failed document upload left a real invoice at OTR with nothing on it and no way to
 * finish. PRO 14538 went over as invoice 16222565 with both documents rejected 500.
 */
describe('an invoice OTR has, whose documents did not land', () => {
  const submitted = () =>
    item({
      otrInvoiceId: '16222565',
      otrStatus: 'Pending',
      otrError: 'POD: Document upload failed (500); Rate confirmation: Document upload failed (500)',
    })

  it('offers to send the documents again, without creating a second invoice', async () => {
    render(<OtrPanel item={submitted()} onChanged={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Send the documents again/ }))
    await waitFor(() => expect(uploadOtrDocs).toHaveBeenCalledWith('13364'))
  })

  it('shows what OTR said, which is the only way anyone can act on it', () => {
    render(<OtrPanel item={submitted()} onChanged={vi.fn()} />)
    expect(screen.getByText(/Document upload failed \(500\)/)).toBeInTheDocument()
  })

  it('does not offer the retry on an invoice that went over cleanly', () => {
    render(<OtrPanel item={item({ otrInvoiceId: '16222565', otrStatus: 'Pending' })} onChanged={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Send the documents again/ })).not.toBeInTheDocument()
  })
})
