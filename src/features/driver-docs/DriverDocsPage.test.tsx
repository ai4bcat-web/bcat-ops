// @vitest-environment jsdom
import '@testing-library/jest-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
globalThis.DOMRect ??= class { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} } as never
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { mockGraphql } = vi.hoisted(() => ({ mockGraphql: vi.fn() }))
const { mockUploadData, mockGetUrl } = vi.hoisted(() => ({ mockUploadData: vi.fn(), mockGetUrl: vi.fn() }))

vi.mock('aws-amplify/data', () => ({
  generateClient: vi.fn(() => ({ graphql: mockGraphql })),
}))
vi.mock('aws-amplify/storage', () => ({
  uploadData: mockUploadData,
  getUrl: mockGetUrl,
}))

import { DriverDocsPage } from './DriverDocsPage'

type GraphQlCall = { query: string; variables: Record<string, unknown> }

function setupGraphql(calls: GraphQlCall[], responses: unknown[]) {
  mockGraphql.mockImplementation(async (_opts: { query: string; variables?: Record<string, unknown> }) => {
    const query = _opts.query
    const variables = _opts.variables ?? {}
    calls.push({ query, variables })
    return { data: responses.shift() }
  })
}

vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      drivers: [
        { id: 'drv-1', name: 'John Doe', active: true, email: 'john@example.com' },
        { id: 'drv-2', name: 'Jane Doe', active: true, email: 'jane@example.com' },
      ],
    }),
  ),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: { email: 'staff@bcatcorp.com' }, loading: false })),
}))

describe('DriverDocsPage', () => {
  let calls: GraphQlCall[] = []

  beforeEach(() => {
    calls = []
    vi.resetAllMocks()
    mockGraphql.mockReset()
    mockUploadData.mockReset()
    mockGetUrl.mockReset()
  })

  it('renders the page and opens the upload dialog', async () => {
    setupGraphql(calls, [
      { listDriverSubmissions: { items: [], nextToken: null } },
    ])

    render(<DriverDocsPage />)

    expect(await screen.findByText('Driver Documents')).toBeInTheDocument()
    expect(screen.getByText(/No driver submissions yet/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /upload/i }))
    expect(await screen.findByText('Upload driver document')).toBeInTheDocument()
  })

  it('lists submissions from PWA and staff sources', async () => {
    setupGraphql(calls, [
      {
        listDriverSubmissions: {
          items: [
            {
              id: 'sub-pwa',
              driverId: 'drv-1',
              driverName: 'John Doe',
              status: 'NEW',
              source: 'PWA',
              submittedByEmail: null,
              loadId: null,
              referenceNumber: 'REF-A',
              note: null,
              slackChannelId: null,
              slackMessageTs: null,
              emailMessageId: null,
              emailSubject: null,
              notifiedAt: null,
              createdAt: '2026-09-28T12:00:00.000Z',
              updatedAt: null,
            },
            {
              id: 'sub-staff',
              driverId: 'drv-2',
              driverName: 'Jane Doe',
              status: 'NEW',
              source: 'STAFF',
              submittedByEmail: 'staff@bcatcorp.com',
              loadId: null,
              referenceNumber: 'REF-B',
              note: 'uploaded by staff',
              slackChannelId: null,
              slackMessageTs: null,
              emailMessageId: null,
              emailSubject: null,
              notifiedAt: null,
              createdAt: '2026-09-29T12:00:00.000Z',
              updatedAt: null,
            },
          ],
          nextToken: null,
        },
      },
      { listDriverSubmissionDocs: { items: [] } },
      { listDriverSubmissionDocs: { items: [] } },
    ])

    render(<DriverDocsPage />)

    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument()
    })
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Staff (staff@bcatcorp.com)')).toBeInTheDocument()
    expect(screen.getByText('uploaded by staff')).toBeInTheDocument()
  })
})
