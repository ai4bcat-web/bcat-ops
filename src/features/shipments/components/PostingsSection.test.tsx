// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { toast } from 'sonner'
import { PostingsSection } from './PostingsSection'
import type { ShipmentPostingRecord } from '@/types/tms'

const listShipmentPostings = vi.hoisted(() => vi.fn())
const postLoad = vi.hoisted(() => vi.fn())
const unpostLoad = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  listShipmentPostings,
  postLoad,
  unpostLoad,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const WHEN = '2026-04-03T12:00:00.000Z'

function posting(over: Partial<ShipmentPostingRecord>): ShipmentPostingRecord {
  return {
    id: 'post-1',
    shipmentId: 'shp-1',
    provider: 'DAT',
    status: 'POSTED',
    mode: 'LIVE',
    boardPostingId: 'dat-12345',
    message: 'Live on DAT',
    postedAt: WHEN,
    postedBy: 'a@b.c',
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  } as ShipmentPostingRecord
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PostingsSection', () => {
  it('labels a STUB posting beside its board id', async () => {
    listShipmentPostings.mockResolvedValue([posting({ mode: 'STUB', boardPostingId: 'stub-dat-99' })])
    render(<PostingsSection shipmentId="shp-1" />)
    await waitFor(() => expect(screen.getByText('stub-dat-99')).toBeInTheDocument())
    expect(screen.getByText('STUB')).toBeInTheDocument()
  })

  it('surfaces the server refusal when Post is refused while BUILDING', async () => {
    listShipmentPostings.mockResolvedValue([])
    postLoad.mockRejectedValue(new Error('Cannot post a load that is still BUILDING'))
    render(<PostingsSection shipmentId="shp-1" buildState="BUILDING" />)
    await waitFor(() => expect(screen.getByText('Not posted')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Post DAT/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot post a load that is still BUILDING'))
  })

  it('posts and refreshes when the Post button is pressed', async () => {
    listShipmentPostings.mockResolvedValue([])
    postLoad.mockResolvedValue({ postings: [posting({})] })
    render(<PostingsSection shipmentId="shp-1" />)
    await waitFor(() => expect(screen.getByText('Not posted')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Post DAT/i }))
    await waitFor(() => expect(postLoad).toHaveBeenCalledWith({ shipmentId: 'shp-1', loadId: undefined, providers: ['DAT'] }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Posted to DAT'))
  })
})
