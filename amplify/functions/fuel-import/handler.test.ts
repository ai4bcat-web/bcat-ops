import { describe, it, expect } from 'vitest'
import { extractUrls } from './handler'

const FLEET_ONE_URL =
  'https://manage.fleetone.com/cards/CardsJob.action?getJobFile&fileId=26fe5af7-6e95-48be-af7f-75a94598f866.1779257184919.jobdata'

describe('extractUrls — Fleet One CardsJob', () => {
  it('extracts the URL when followed by text with no whitespace delimiter', () => {
    // This is the exact problematic case: URL runs directly into "Please do not reply"
    const body =
      "Job: 'DAILY FUEL REPORT' completed. Download at: " +
      FLEET_ONE_URL +
      'Please do not reply to this email.'

    const urls = extractUrls(body)
    expect(urls).toContain(FLEET_ONE_URL)
  })

  it('does not capture trailing non-URL text as part of the URL', () => {
    const body = FLEET_ONE_URL + 'Please do not reply.'
    const [url] = extractUrls(body)
    expect(url).toBe(FLEET_ONE_URL)
    expect(url).not.toContain('Please')
  })

  it('handles URL followed by a newline (normal case still works)', () => {
    const body = 'Download at: ' + FLEET_ONE_URL + '\nPlease do not reply.'
    const urls = extractUrls(body)
    expect(urls).toContain(FLEET_ONE_URL)
  })

  it('handles URL with different fileId structure', () => {
    const altUrl =
      'https://manage.fleetone.com/cards/CardsJob.action?getJobFile&fileId=abc12345-0000-1111-2222-def678901234.9876543210.jobdata'
    const urls = extractUrls('Download: ' + altUrl + 'Please ignore.')
    expect(urls).toContain(altUrl)
  })

  it('still extracts generic https URLs from the same body', () => {
    const genericUrl = 'https://example.com/some-other-link'
    const body = FLEET_ONE_URL + 'Please ignore. Also see ' + genericUrl
    const urls = extractUrls(body)
    expect(urls).toContain(FLEET_ONE_URL)
    expect(urls).toContain(genericUrl)
  })

  it('deduplicates repeated occurrences of the same URL', () => {
    const body = FLEET_ONE_URL + 'text' + FLEET_ONE_URL + 'more'
    const urls = extractUrls(body)
    expect(urls.filter((u) => u === FLEET_ONE_URL)).toHaveLength(1)
  })

  it('returns empty array for body with no URLs', () => {
    expect(extractUrls('No URLs here at all.')).toHaveLength(0)
  })
})
