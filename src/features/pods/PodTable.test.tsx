// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { Load } from '@/types'
import type { PodDocument } from '@/types/pods'

const podsClientMocks = vi.hoisted(() => ({
  getPodAssets: vi.fn(),
}))
vi.mock('@/lib/podsClient', () => podsClientMocks)

import { PodTable } from './PodTable'

const load: Load = {
  id: 'l1', aljexId: '55501', tmsId: 'PO-9', pickupNumber: 'PU-1', customer: 'Metz Logistics',
  originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN',
  pickupAppt: '2026-09-28T08:00:00Z', deliveryAppt: '2026-09-29T14:00:00Z',
  pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false,
  createdAt: '', updatedAt: '', createdBy: '', updatedBy: '',
}

function doc(over: Partial<PodDocument> = {}): PodDocument {
  return {
    id: 'p1', clientId: 'c1', companyName: 'Ivan Cartage', senderName: 'Zak Pace',
    senderContact: '+18472936704', receivedAt: '2026-09-28T12:00:00Z',
    processingStatus: 'READY', fileName: 'pod.jpg', contentType: 'image/jpeg',
    mediaIndex: 0, sourceMessageId: 'm1', isAllowed: true, version: 1,
    createdAt: '2026-09-28T12:00:00Z', updatedAt: '2026-09-28T12:00:00Z',
    ...over,
  } as PodDocument
}

function renderTable(docs: PodDocument[], onViewLoad = vi.fn()) {
  render(
    <PodTable
      docs={docs}
      loads={[load]}
      drivers={[]}
      mappings={[]}
      onPreview={vi.fn()}
      onAssign={vi.fn()}
      onUnassign={vi.fn()}
      onRetry={vi.fn()}
      onViewLoad={onViewLoad}
    />,
  )
  return onViewLoad
}

beforeEach(() => {
  vi.clearAllMocks()
  podsClientMocks.getPodAssets.mockResolvedValue({ originalUrl: '', enhancedUrl: '' })
})

describe('POD shipment column', () => {
  it('leads the row so assignment is the first thing read', () => {
    renderTable([doc({ loadId: 'l1' })])
    expect(screen.getAllByRole('columnheader')[0].textContent).toBe('Shipment')
  })

  it('opens the assigned shipment when its id is clicked', () => {
    const onViewLoad = renderTable([doc({ loadId: 'l1' })])
    fireEvent.click(screen.getByRole('button', { name: /Pro #55501/ }))
    expect(onViewLoad).toHaveBeenCalledWith('l1')
  })

  it('identifies the shipment by customer and route, not an opaque id', () => {
    renderTable([doc({ loadId: 'l1' })])
    const cell = screen.getAllByRole('row')[1].querySelectorAll('td')[0]
    expect(within(cell as HTMLElement).getByText('Metz Logistics')).toBeTruthy()
    expect(within(cell as HTMLElement).getByText('Chicago, IL → Indianapolis, IN')).toBeTruthy()
  })

  it('still names a shipment whose load has not loaded yet', () => {
    const onViewLoad = renderTable([doc({ loadId: 'gone-from-cache' })])
    fireEvent.click(screen.getByRole('button', { name: /#-cache/ }))
    expect(onViewLoad).toHaveBeenCalledWith('gone-from-cache')
  })

  it('marks assigned green and unassigned red', () => {
    renderTable([doc({ id: 'p1', loadId: 'l1' }), doc({ id: 'p2', loadId: undefined })])
    const rows = screen.getAllByRole('row').slice(1)
    const assigned = rows[0].querySelectorAll('td')[0].querySelector('button')
    const unassigned = rows[1].querySelectorAll('td')[0].querySelector('span')
    expect((assigned as HTMLElement).style.color).toBe('rgb(21, 128, 61)')
    expect(unassigned?.textContent).toContain('Unassigned')
    expect((unassigned as HTMLElement).style.color).toBe('rgb(185, 28, 28)')
  })

  it('offers no shipment link when nothing is assigned', () => {
    renderTable([doc({ loadId: undefined })])
    expect(screen.queryByRole('button', { name: /Pro #/ })).toBeNull()
  })
})
