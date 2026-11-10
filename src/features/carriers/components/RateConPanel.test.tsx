// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

import { RateConPanel } from './RateConPanel'
import type { CarrierContactRecord, CarrierRecord, LoadCarrierRecord, ShipmentBundle } from '@/types/tms'

vi.mock('@/lib/apiClient', () => ({
  listUserProfiles: vi.fn(async () => []),
  getRateConfirmUrl: vi.fn(async () => ''),
  getTrackingMailbox: vi.fn(async () => ({ tracking: 'threads+tracking@bcatcorp.com', thread: 'threads+x@bcatcorp.com' })),
}))
vi.mock('@/lib/carrierRateCon', () => ({
  buildRateConPdf: vi.fn(async () => new Uint8Array([1, 2, 3])),
  rateConPdfBase64: vi.fn(() => 'AAAA'),
  rateConFilename: vi.fn(() => 'rate-con.pdf'),
  joinRateConNotes: vi.fn(() => ''),
  rateConRepOf: vi.fn(() => null),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuthUser: () => ({ email: 'dispatch@bcatcorp.com', userId: 'u1', groups: [] }),
}))

const bundle = { loads: [], orders: [], charges: [], loadCarriers: [] } as unknown as ShipmentBundle
const loadCarrier = { id: 'lc-1', carrierName: 'Swift', status: 'ACTIVE', rateConStatus: 'NOT_SENT' } as LoadCarrierRecord
const contact = (over: Partial<CarrierContactRecord>) => ({
  id: 'c', carrierId: 'car-1', name: 'Dana', active: true, ...over,
}) as CarrierContactRecord
const contacts = [
  contact({ id: 'c1', name: 'Dana', email: 'dana@swift.com', types: ['DISPATCH'] }),
  contact({ id: 'c2', name: 'Pat', email: 'pat@swift.com', types: ['ACCOUNTING'] }),
]
const carrier = (mcpStatus?: string | null) =>
  ({ id: 'car-1', name: 'Swift', status: 'ACTIVE', email: 'main@swift.com', mcpStatus }) as CarrierRecord

/** Renders inside async act so the divisions load lands before the assertions. */
async function setup(opts: { carrier?: CarrierRecord | null; rateConVersion?: number } = {}) {
  const onSend = vi.fn(async () => {})
  await act(async () => {
    render(
      <MemoryRouter>
        <RateConPanel
          bundle={bundle}
          loadCarrier={{ ...loadCarrier, rateConVersion: opts.rateConVersion } as LoadCarrierRecord}
          carrier={opts.carrier === undefined ? carrier('ACCEPTABLE') : opts.carrier}
          contacts={contacts}
          settings={null}
          busy={false}
          onSend={onSend}
          onVoid={vi.fn(async () => {})}
        />
      </MemoryRouter>,
    )
  })
  return onSend
}

const sendButton = () => screen.getByRole('button', { name: /^(Send|Re-send) for e-signature$/ })
const addBox = () => screen.getByLabelText('Add another address')

describe('RateConPanel recipients', () => {
  it('sends to the default recipient (the MCP / FMCSA e-mail on file) when the user just clicks Send', async () => {
    const onSend = await setup()
    fireEvent.click(sendButton())
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0].to).toEqual(['main@swift.com'])
  })

  it('sends only the addresses still ticked', async () => {
    const onSend = await setup()
    fireEvent.click(screen.getByLabelText(/pat@swift\.com/))
    fireEvent.click(screen.getByLabelText(/main@swift\.com/))
    fireEvent.click(sendButton())
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0].to).toEqual(['pat@swift.com'])
  })

  it('commits a valid pending address on Send', async () => {
    const onSend = await setup()
    fireEvent.change(addBox(), { target: { value: 'New@Carrier.com' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0].to).toEqual(['main@swift.com', 'New@Carrier.com'])
  })

  it('blocks the send when the pending address is invalid', async () => {
    const onSend = await setup()
    fireEvent.change(addBox(), { target: { value: 'bad@' } })
    fireEvent.click(sendButton())
    expect(await screen.findByText('"bad@" is not a valid email address.')).toBeInTheDocument()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('blocks the send on an invalid CC token and passes valid ones', async () => {
    const onSend = await setup()
    fireEvent.change(screen.getByLabelText('Rate con cc'), { target: { value: 'ok@x.com, nope' } })
    fireEvent.click(sendButton())
    expect(await screen.findByText('CC: "nope" is not a valid email address.')).toBeInTheDocument()
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Rate con cc'), { target: { value: 'ok@x.com; two@x.com' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0].cc).toEqual(['ok@x.com', 'two@x.com'])
  })

  it('disables Send when nothing is selected', async () => {
    await setup()
    fireEvent.click(screen.getByLabelText(/main@swift\.com/))
    expect(sendButton()).toBeDisabled()
  })

  it('tells the sender they are copied automatically', async () => {
    await setup()
    const routing = screen.getByTestId('rate-con-routing')
    expect(routing).toHaveTextContent('dispatch@bcatcorp.com')
    expect(routing).toHaveTextContent('Always on CC')
    expect(routing).toHaveTextContent('tracking@bcatcorp.com')
  })
})

describe('RateConPanel MyCarrierPackets gate', () => {
  it('an Active carrier can be sent the rate con whatever its MyCarrierPackets packet says (invited, not started)', async () => {
    await setup({ carrier: carrier('INVITED'), rateConVersion: 1 })
    expect(sendButton()).toHaveTextContent('Re-send for e-signature')
    expect(sendButton()).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('blocks Send and Re-send with a notice and a profile link when the carrier is not Active, but keeps Preview', async () => {
    const onSend = await setup({ carrier: { ...carrier('ACCEPTABLE'), status: 'PENDING' } as CarrierRecord, rateConVersion: 1 })
    expect(sendButton()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Swift')
    expect(screen.getByRole('link', { name: /open carrier profile/i })).toHaveAttribute('href', '/tms/carriers/car-1')
    expect(screen.getByRole('button', { name: /preview/i })).toBeEnabled()
    fireEvent.click(sendButton())
    expect(onSend).not.toHaveBeenCalled()
  })

  it('enables Send for a completed packet', async () => {
    await setup({ carrier: carrier('ACCEPTABLE') })
    expect(sendButton()).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('blocks Send for a carrier that is not Active even with a completed packet (MyCarrierPackets moved it out of compliance)', async () => {
    await setup({ carrier: { ...carrier('ACCEPTABLE'), status: 'INACTIVE' } as CarrierRecord })
    expect(sendButton()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('not Active')
  })

  it('does not pre-block while the carrier bundle has not loaded (the server decides)', async () => {
    await setup({ carrier: null })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
