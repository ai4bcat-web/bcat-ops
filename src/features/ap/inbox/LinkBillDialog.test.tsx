// @vitest-environment jsdom
/**
 * The link dialog is where a person decides what an e-mail may write. What it must get right:
 * blanks are ticked and conflicts are not, an amount the planner refused is disabled with its
 * reason, an uncertain match cannot be applied until the person says they checked, and Apply
 * sends exactly the ticks plus the version the preview was built on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CarrierBillRecord } from '@/types/tms'
import { inboxItem } from './inboxTestkit'

const api = vi.hoisted(() => ({
  listVendorPayables: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
const client = vi.hoisted(() => ({ apInboxPreviewLink: vi.fn(), apInboxLink: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('./apInboxClient', () => client)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { LinkBillDialog } from './LinkBillDialog'

const BILL = { id: 'b1', carrierId: 'c1', carrierName: 'Blue Line Trucking', shipmentNumber: 'S-100', billNumber: null } as CarrierBillRecord
const PLAN = {
  kind: 'CARRIER_BILL', mode: 'HUMAN', placeholder: true, set: {}, fields: [],
  changes: [
    { field: 'billNumber', current: null, incoming: 'INV-5521' },
    { field: 'billDate', current: '2026-10-30', incoming: '2026-11-01' },
  ],
  conflicts: [{ field: 'dueAt', current: '2026-11-15', incoming: '2026-12-01' }],
  skipped: [{ field: 'billedCents', reason: 'STATUS' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listVendorPayables.mockResolvedValue([])
  client.apInboxPreviewLink.mockResolvedValue({ plan: PLAN, target: { kind: 'CARRIER_BILL', id: 'b1', label: 'x' }, version: 7 })
  client.apInboxLink.mockResolvedValue({ item: inboxItem(), fields: ['billNumber', 'billDate'] })
})

const draw = (item = inboxItem(), onDone = vi.fn()) =>
  render(<LinkBillDialog item={item} bills={[BILL]} assignments={[]} onOpenChange={vi.fn()} onDone={onDone} />)

describe('LinkBillDialog', () => {
  it('previews the suggested bill: blanks ticked, the conflict unticked, the refused amount disabled with its reason', async () => {
    draw()
    expect(await screen.findByTestId('ap-inbox-pick-billNumber')).toBeChecked()
    expect(screen.getByTestId('ap-inbox-pick-billDate')).toBeChecked()
    expect(screen.getByTestId('ap-inbox-pick-dueAt')).not.toBeChecked()
    expect(screen.getByTestId('ap-inbox-skip-billedCents')).toHaveTextContent(/not allowed at this bill status/)
    expect(client.apInboxPreviewLink).toHaveBeenCalledWith('apin:m1', { kind: 'CARRIER_BILL', id: 'b1' })
  })

  it('will not apply an uncertain match until the person confirms, then sends the ticks and the previewed version', async () => {
    const onDone = vi.fn()
    draw(inboxItem(), onDone)
    const apply = await screen.findByTestId('ap-inbox-link-apply')
    await waitFor(() => expect(apply).toBeDisabled())
    fireEvent.click(screen.getByTestId('ap-inbox-pick-dueAt'))
    fireEvent.click(screen.getByTestId('ap-inbox-confirm'))
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(client.apInboxLink).toHaveBeenCalledWith(
      'apin:m1', { kind: 'CARRIER_BILL', id: 'b1' }, { billNumber: true, billDate: true, dueAt: true }, 7,
    )
  })

  it('shows the server’s refusal and stays open', async () => {
    client.apInboxLink.mockRejectedValue(new Error('The bill changed since the preview'))
    const onDone = vi.fn()
    draw(inboxItem({ reviewReason: 'CONFLICT' }), onDone)
    fireEvent.click(await screen.findByTestId('ap-inbox-link-apply'))
    expect(await screen.findByText('The bill changed since the preview')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })
})
