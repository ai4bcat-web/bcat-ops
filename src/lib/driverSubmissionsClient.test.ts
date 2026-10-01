import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGraphql } = vi.hoisted(() => ({ mockGraphql: vi.fn() }))
const { mockUploadData, mockGetUrl } = vi.hoisted(() => ({ mockUploadData: vi.fn(), mockGetUrl: vi.fn() }))

vi.mock('aws-amplify/data', () => ({
  generateClient: vi.fn(() => ({ graphql: mockGraphql })),
}))
vi.mock('aws-amplify/storage', () => ({
  uploadData: mockUploadData,
  getUrl: mockGetUrl,
}))

import {
  staffUploadDriverDoc,
  staffAddPodToSubmission,
  listDriverSubmissions,
  pickSubmissionForPod,
  getDriverDocUrl,
  isDriverDocFile,
  DRIVER_DOC_MAX_BYTES,
  type StaffUploadDriverDocInput,
  type SubmissionWithDocs,
  type DriverSubmissionDocRecord,
} from './driverSubmissionsClient'


type GraphQlCall = { query: string; variables: Record<string, unknown> }

function setupGraphql(calls: GraphQlCall[], responses: unknown[]) {
  mockGraphql.mockImplementation(async (_opts: { query: string; variables?: Record<string, unknown> }) => {
    const query = _opts.query
    const variables = _opts.variables ?? {}
    calls.push({ query, variables })
    return { data: responses.shift() }
  })
}

function setupUpload() {
  mockUploadData.mockImplementation((input: { path: string; data: unknown }) => ({
    result: Promise.resolve({ path: input.path, data: input.data }),
  }) as never)
}

function makeFile(name: string, type: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('driverSubmissionsClient', () => {
  let calls: GraphQlCall[] = []

  beforeEach(() => {
    calls = []
    vi.resetAllMocks()
    mockGraphql.mockReset()
    mockUploadData.mockReset()
    mockGetUrl.mockReset()
  })

  describe('isDriverDocFile', () => {
    it('accepts PDFs and images under the size limit', () => {
      expect(isDriverDocFile(makeFile('a.pdf', 'application/pdf'))).toBe(true)
      expect(isDriverDocFile(makeFile('a.jpg', 'image/jpeg'))).toBe(true)
      expect(isDriverDocFile(makeFile('a.png', 'image/png'))).toBe(true)
      expect(isDriverDocFile(makeFile('a.webp', 'image/webp'))).toBe(true)
    })

    it('rejects empty or oversized files', () => {
      const empty = new File([], 'empty.pdf', { type: 'application/pdf' })
      expect(isDriverDocFile(empty)).toBe(false)

      const big = new File([new Uint8Array(DRIVER_DOC_MAX_BYTES + 1)], 'big.pdf', { type: 'application/pdf' })
      expect(isDriverDocFile(big)).toBe(false)
    })

    it('rejects unsupported types', () => {
      expect(isDriverDocFile(makeFile('a.txt', 'text/plain'))).toBe(false)
    })
  })

  describe('staffUploadDriverDoc', () => {
    it('creates a STAFF submission with one doc per page under the correct S3 key shape', async () => {
      setupUpload()
      setupGraphql(calls, [
        {
          createDriverSubmission: {
            id: 'sub-1',
            driverId: 'drv-1',
            driverName: 'John Doe',
            status: 'NEW',
            source: 'STAFF',
            submittedByEmail: 'staff@bcatcorp.com',
            loadId: null,
            referenceNumber: 'REF-123',
            note: 'note text',
            slackChannelId: null,
            slackMessageTs: null,
            emailMessageId: null,
            emailSubject: null,
            notifiedAt: null,
            createdAt: '2026-09-30T12:00:00.000Z',
            updatedAt: null,
          },
        },
        {
          createDriverSubmissionDoc: {
            id: 'doc-1',
            submissionId: 'sub-1',
            driverId: 'drv-1',
            kind: 'RATECON',
            s3Key: 'driver-docs/drv-1/sub-1/RATECON/1000-1.pdf',
            fileName: 'page1.pdf',
            contentType: 'application/pdf',
            byteSize: 100,
            pageNumber: 1,
            uploadedAt: '2026-09-30T12:00:00.000Z',
            notifiedAt: null,
          },
        },
        {
          createDriverSubmissionDoc: {
            id: 'doc-2',
            submissionId: 'sub-1',
            driverId: 'drv-1',
            kind: 'RATECON',
            s3Key: 'driver-docs/drv-1/sub-1/RATECON/1001-2.png',
            fileName: 'page2.png',
            contentType: 'image/png',
            byteSize: 100,
            pageNumber: 2,
            uploadedAt: '2026-09-30T12:00:00.000Z',
            notifiedAt: null,
          },
        },
      ])

      vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1001)

      const input: StaffUploadDriverDocInput = {
        driver: { id: 'drv-1', name: 'John Doe' },
        kind: 'RATECON',
        files: [makeFile('page1.pdf', 'application/pdf'), makeFile('page2.png', 'image/png')],
        submittedByEmail: 'staff@bcatcorp.com',
        referenceNumber: 'REF-123',
        note: 'note text',
      }

      const result = await staffUploadDriverDoc(input)

      const createSub = calls.find((c) => c.query.includes('createDriverSubmission('))
      expect(createSub).toBeDefined()
      expect(createSub!.variables.input).toMatchObject({
        driverId: 'drv-1',
        driverName: 'John Doe',
        status: 'NEW',
        source: 'STAFF',
        submittedByEmail: 'staff@bcatcorp.com',
        referenceNumber: 'REF-123',
        note: 'note text',
        loadId: null,
      })

      const createDocs = calls.filter((c) => c.query.includes('createDriverSubmissionDoc'))
      expect(createDocs).toHaveLength(2)
      expect(createDocs[0].variables.input).toMatchObject({
        submissionId: 'sub-1',
        driverId: 'drv-1',
        kind: 'RATECON',
        s3Key: expect.stringMatching(/^driver-docs\/drv-1\/sub-1\/RATECON\/\d+-1\.pdf$/),
        pageNumber: 1,
      })
      expect(createDocs[1].variables.input).toMatchObject({
        submissionId: 'sub-1',
        kind: 'RATECON',
        pageNumber: 2,
      })

      expect(result.docs).toHaveLength(2)
      expect(result.docs.every((d) => d.submissionId === 'sub-1')).toBe(true)
    })

    it('attaches a POD to the matching existing submission instead of creating a new one', async () => {
      setupUpload()
      setupGraphql(calls, [
        {
          listDriverSubmissions: {
            items: [
              {
                id: 'sub-existing',
                driverId: 'drv-1',
                driverName: 'John Doe',
                status: 'NEW',
                source: 'PWA',
                submittedByEmail: null,
                loadId: null,
                referenceNumber: 'REF-123',
                note: null,
                slackChannelId: null,
                slackMessageTs: null,
                emailMessageId: null,
                emailSubject: null,
                notifiedAt: null,
                createdAt: '2026-09-29T12:00:00.000Z',
                updatedAt: null,
              },
            ],
          },
        },
        {
          listDriverSubmissionDocs: {
            items: [
              {
                id: 'doc-ratecon',
                submissionId: 'sub-existing',
                driverId: 'drv-1',
                kind: 'RATECON',
                s3Key: 'driver-docs/drv-1/sub-existing/RATECON/old.pdf',
                fileName: 'ratecon.pdf',
                contentType: 'application/pdf',
                byteSize: 100,
                pageNumber: 1,
                uploadedAt: '2026-09-29T12:00:00.000Z',
                notifiedAt: null,
              },
            ],
          },
        },
        {
          getDriverSubmission: {
            id: 'sub-existing',
            driverId: 'drv-1',
            driverName: 'John Doe',
            status: 'NEW',
            source: 'PWA',
            submittedByEmail: null,
            loadId: null,
            referenceNumber: 'REF-123',
            note: null,
            slackChannelId: null,
            slackMessageTs: null,
            emailMessageId: null,
            emailSubject: null,
            notifiedAt: null,
            createdAt: '2026-09-29T12:00:00.000Z',
            updatedAt: null,
          },
        },
        {
          createDriverSubmissionDoc: {
            id: 'doc-pod',
            submissionId: 'sub-existing',
            driverId: 'drv-1',
            kind: 'POD',
            s3Key: 'driver-docs/drv-1/sub-existing/POD/2000-1.pdf',
            fileName: 'pod.pdf',
            contentType: 'application/pdf',
            byteSize: 100,
            pageNumber: 1,
            uploadedAt: '2026-09-30T12:00:00.000Z',
            notifiedAt: null,
          },
        },
      ])

      vi.spyOn(Date, 'now').mockReturnValueOnce(2000)

      const input: StaffUploadDriverDocInput = {
        driver: { id: 'drv-1', name: 'John Doe' },
        kind: 'POD',
        files: [makeFile('pod.pdf', 'application/pdf')],
        submittedByEmail: 'staff@bcatcorp.com',
        referenceNumber: 'REF-123',
      }

      const result = await staffUploadDriverDoc(input)

      expect(calls.some((c) => c.query.includes('createDriverSubmission('))).toBe(false)
      const podDoc = calls.find((c) => c.query.includes('createDriverSubmissionDoc'))
      expect(podDoc!.variables.input).toMatchObject({
        submissionId: 'sub-existing',
        kind: 'POD',
        s3Key: expect.stringMatching(/^driver-docs\/drv-1\/sub-existing\/POD\/\d+-1\.pdf$/),
      })
      expect(result.docs).toHaveLength(1)
      expect(result.id).toBe('sub-existing')
    })
  })

  describe('pickSubmissionForPod', () => {
    it('matches by referenceNumber first', () => {
      const existing: SubmissionWithDocs[] = [
        {
          id: 'older',
          driverId: 'drv-1',
          driverName: 'John',
          status: 'NEW',
          source: 'PWA',
          referenceNumber: 'REF-A',
          createdAt: '2026-09-28T12:00:00.000Z',
          docs: [{ kind: 'RATECON' } as DriverSubmissionDocRecord],
        },
        {
          id: 'match',
          driverId: 'drv-1',
          driverName: 'John',
          status: 'NEW',
          source: 'PWA',
          referenceNumber: 'REF-B',
          createdAt: '2026-09-27T12:00:00.000Z',
          docs: [],
        },
      ]
      expect(pickSubmissionForPod(existing, 'REF-B')?.id).toBe('match')
    })

    it('falls back to the newest RATECON-only submission', () => {
      const existing: SubmissionWithDocs[] = [
        {
          id: 'has-pod',
          driverId: 'drv-1',
          driverName: 'John',
          status: 'NEW',
          source: 'PWA',
          referenceNumber: 'REF-A',
          createdAt: '2026-09-30T12:00:00.000Z',
          docs: [
            { kind: 'RATECON' } as DriverSubmissionDocRecord,
            { kind: 'POD' } as DriverSubmissionDocRecord,
          ],
        },
        {
          id: 'ratecon-only',
          driverId: 'drv-1',
          driverName: 'John',
          status: 'NEW',
          source: 'PWA',
          referenceNumber: 'REF-B',
          createdAt: '2026-09-29T12:00:00.000Z',
          docs: [{ kind: 'RATECON' } as DriverSubmissionDocRecord],
        },
      ]
      expect(pickSubmissionForPod(existing)?.id).toBe('ratecon-only')
    })

    it('returns null when nothing matches', () => {
      expect(pickSubmissionForPod([], 'REF')).toBeNull()
    })
  })

  describe('listDriverSubmissions', () => {
    it('returns submissions mixed with PWA, EMAIL, and STAFF sources', async () => {
      setupGraphql(calls, [
        {
          listDriverSubmissions: {
            items: [
              { id: 'sub-pwa', driverId: 'drv-1', driverName: 'John', status: 'NEW', source: 'PWA', createdAt: '2026-09-28T12:00:00.000Z' },
              { id: 'sub-staff', driverId: 'drv-2', driverName: 'Jane', status: 'NEW', source: 'STAFF', submittedByEmail: 'staff@bcatcorp.com', createdAt: '2026-09-29T12:00:00.000Z' },
              { id: 'sub-email', driverId: 'drv-3', driverName: 'Jim', status: 'NEW', source: 'EMAIL', createdAt: '2026-09-30T12:00:00.000Z' },
            ],
          },
        },
        {
          listDriverSubmissionDocs: {
            items: [
              { id: 'doc-pwa', submissionId: 'sub-pwa', driverId: 'drv-1', kind: 'RATECON', s3Key: 'k1', uploadedAt: '2026-09-28T12:00:00.000Z' },
              { id: 'doc-staff', submissionId: 'sub-staff', driverId: 'drv-2', kind: 'POD', s3Key: 'k2', uploadedAt: '2026-09-29T12:00:00.000Z' },
              { id: 'doc-email', submissionId: 'sub-email', driverId: 'drv-3', kind: 'RATECON', s3Key: 'k3', uploadedAt: '2026-09-30T12:00:00.000Z' },
            ],
          },
        },
        { listDriverSubmissionDocs: { items: [] } },
        { listDriverSubmissionDocs: { items: [] } },
      ])

      const rows = await listDriverSubmissions(50)

      expect(rows).toHaveLength(3)
      const sources = rows.map((r) => r.source)
      expect(sources).toEqual(expect.arrayContaining(['PWA', 'STAFF', 'EMAIL']))
      expect(rows.find((r) => r.id === 'sub-staff')?.submittedByEmail).toBe('staff@bcatcorp.com')
      expect(rows.every((r) => Array.isArray(r.docs))).toBe(true)
      expect(rows.find((r) => r.id === 'sub-pwa')?.docs).toHaveLength(1)
    })
  })

  describe('staffAddPodToSubmission', () => {
    it('adds POD docs to an existing submission', async () => {
      setupUpload()
      setupGraphql(calls, [
        {
          getDriverSubmission: {
            id: 'sub-target',
            driverId: 'drv-1',
            driverName: 'John Doe',
            status: 'NEW',
            source: 'PWA',
            submittedByEmail: null,
            loadId: null,
            referenceNumber: null,
            note: null,
            slackChannelId: null,
            slackMessageTs: null,
            emailMessageId: null,
            emailSubject: null,
            notifiedAt: null,
            createdAt: '2026-09-28T12:00:00.000Z',
            updatedAt: null,
          },
        },
        {
          createDriverSubmissionDoc: {
            id: 'doc-pod',
            submissionId: 'sub-target',
            driverId: 'drv-1',
            kind: 'POD',
            s3Key: 'driver-docs/drv-1/sub-target/POD/3000-1.pdf',
            fileName: 'pod.pdf',
            contentType: 'application/pdf',
            byteSize: 100,
            pageNumber: 1,
            uploadedAt: '2026-09-30T12:00:00.000Z',
            notifiedAt: null,
          },
        },
      ])

      vi.spyOn(Date, 'now').mockReturnValueOnce(3000)

      const result = await staffAddPodToSubmission('sub-target', {
        driver: { id: 'drv-1', name: 'John Doe' },
        files: [makeFile('pod.pdf', 'application/pdf')],
        submittedByEmail: 'staff@bcatcorp.com',
      })

      expect(result.id).toBe('sub-target')
      expect(result.docs).toHaveLength(1)
      const podDoc = calls.find((c) => c.query.includes('createDriverSubmissionDoc'))
      expect(podDoc!.variables.input).toMatchObject({
        submissionId: 'sub-target',
        kind: 'POD',
        pageNumber: 1,
      })
    })
  })

  describe('getDriverDocUrl', () => {
    it('returns a signed URL for an S3 key', async () => {
      mockGetUrl.mockResolvedValueOnce({ url: new URL('https://example.com/signed') } as never)
      const url = await getDriverDocUrl('driver-docs/drv-1/sub-1/RATECON/x.pdf')
      expect(url).toBe('https://example.com/signed')
      expect(mockGetUrl).toHaveBeenCalledWith({ path: 'driver-docs/drv-1/sub-1/RATECON/x.pdf', options: { expiresIn: 3600 } })
    })
  })
})
