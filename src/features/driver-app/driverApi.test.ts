// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as DriverApiModule from './driverApi'
import type { PendingPage } from './driverApi'

const API_URL = 'https://driver-api.example'

function makePages(count: number): PendingPage[] {
  return Array.from({ length: count }, (_, i) => ({
    fileName: `page-${i + 1}.jpg`,
    contentType: 'image/jpeg',
    byteSize: 1000 + i,
    blob: new Blob(['x'], { type: 'image/jpeg' }),
  }))
}

describe('driverApi', () => {
  // The module reads DRIVER_API_URL from import.meta.env at load time, so we set the env var
  // and re-import it fresh for each test. Dynamic import is required here because the module
  // caches the resolved URL.
  let mod: typeof DriverApiModule
  const fetchMock = vi.fn()

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('fetch', fetchMock)
    vi.clearAllMocks()

    import.meta.env.VITE_DRIVER_API_URL = API_URL
    mod = await import('./driverApi')
    mod.setDriverTokenSupplier(async () => 'id-token')
  })

  it('submitRatecon creates one submission and completes after uploading every page', async () => {
    const pages = makePages(3)

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: 'sub-1',
            uploads: [
              { pageNumber: 1, url: 'https://s3.test/1', s3Key: 'k1' },
              { pageNumber: 2, url: 'https://s3.test/2', s3Key: 'k2' },
              { pageNumber: 3, url: 'https://s3.test/3', s3Key: 'k3' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await mod.submitRatecon({ pages, referenceNumber: 'REF-123', note: 'call first' })

    const calls = fetchMock.mock.calls as [string, RequestInit | undefined][]
    expect(calls.length).toBe(5)

    const [createUrl, createOpts] = calls[0]
    expect(createUrl).toContain('/submissions')
    expect(createOpts?.method).toBe('POST')
    const createBody = JSON.parse(createOpts?.body as string)
    expect(createBody.kind).toBe('RATECON')
    expect(createBody.referenceNumber).toBe('REF-123')
    expect(createBody.note).toBe('call first')
    expect(createBody.pages).toHaveLength(3)
    expect(createBody.pages[0]).toMatchObject({
      fileName: 'page-1.jpg',
      contentType: 'image/jpeg',
      byteSize: 1000,
    })

    expect(calls[1][0]).toBe('https://s3.test/1')
    expect(calls[2][0]).toBe('https://s3.test/2')
    expect(calls[3][0]).toBe('https://s3.test/3')

    const [completeUrl, completeOpts] = calls[4]
    expect(completeUrl).toContain('/submissions/sub-1/complete')
    expect(completeOpts?.method).toBe('POST')
    expect(JSON.parse(completeOpts?.body as string)).toEqual({ kind: 'RATECON' })
  })

  it('submitStandalonePod creates a POD submission and completes', async () => {
    const pages = makePages(2)

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: 'pod-sub',
            uploads: [
              { pageNumber: 1, url: 'https://s3.test/pod1', s3Key: 'pk1' },
              { pageNumber: 2, url: 'https://s3.test/pod2', s3Key: 'pk2' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await mod.submitStandalonePod({ pages, referenceNumber: 'LOAD-99' })

    const [createUrl, createOpts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(createUrl).toContain('/submissions')
    expect(JSON.parse(createOpts.body as string)).toMatchObject({
      kind: 'POD',
      referenceNumber: 'LOAD-99',
      pages: expect.any(Array),
    })

    const [, completeOpts] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect(JSON.parse(completeOpts.body as string)).toEqual({ kind: 'POD' })
  })

  it('resuming after a page upload failure does not create a second submission', async () => {
    const pages = makePages(2)

    // First attempt: create succeeds, first page upload fails.
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: 'resumable',
            uploads: [
              { pageNumber: 1, url: 'https://s3.test/a', s3Key: 'ka' },
              { pageNumber: 2, url: 'https://s3.test/b', s3Key: 'kb' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('Internal Error', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    let err: InstanceType<typeof mod.ResumableDriverApiError> | undefined
    try {
      await mod.submitRatecon({ pages })
    } catch (e) {
      err = e as InstanceType<typeof mod.ResumableDriverApiError>
    }

    expect(err).toBeInstanceOf(mod.ResumableDriverApiError)
    expect(err?.submissionId).toBe('resumable')
    expect(err?.kind).toBe('RATECON')
    // create + both page PUTs attempted; complete was never reached.
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Retry: fresh upload URLs for the existing submission, no new submission created.
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploads: [
              { pageNumber: 1, url: 'https://s3.test/a2', s3Key: 'ka' },
              { pageNumber: 2, url: 'https://s3.test/b2', s3Key: 'kb' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await mod.submitRatecon({ pages, resumeFromId: err!.submissionId })

    const postCalls = fetchMock.mock.calls.filter((call) => {
      const [url, opts] = call as [string, RequestInit | undefined]
      return opts?.method === 'POST' && url.includes('/submissions') && !url.includes('/complete')
    })
    expect(postCalls).toHaveLength(1)

    const getCalls = fetchMock.mock.calls.filter((call) => {
      const [url, opts] = call as [string, RequestInit | undefined]
      return (
        (opts?.method ?? 'GET') === 'GET' && url.includes('/submissions/resumable/uploads?kind=RATECON')
      )
    })
    expect(getCalls).toHaveLength(1)
  })
})
