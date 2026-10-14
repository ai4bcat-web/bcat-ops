import { describe, it, expect } from 'vitest'
import { afterOtrDocuments, failedDocuments, otrDocsErrorMessage, otrDocsIncomplete } from './otrSubmitOutcome'

describe('a submit whose documents did not all reach OTR', () => {
  it('keeps the row in Need to factor and says which document to upload again', () => {
    const r = afterOtrDocuments(['POD: nothing on file to send'])
    expect(r.status).toBe('NEED_TO_FACTOR')
    expect(r.otrError).toMatch(/^POD did not reach OTR\. Upload it again on this row, then press Resend documents\./)
  })
  it('names both when both failed, and moves on only when neither did', () => {
    expect(failedDocuments(['POD: Document upload failed (500)', 'Rate confirmation: nothing on file to send'])).toEqual(['POD', 'Rate confirmation'])
    expect(otrDocsErrorMessage(['POD: x', 'Rate confirmation: y'])).toMatch(/^POD and Rate confirmation did not reach OTR\. Upload them again/)
    expect(afterOtrDocuments([])).toEqual({ status: 'PENDING_WITH_OTR', otrError: null })
  })
  it('is recognisable on the row without a new field', () => {
    expect(otrDocsIncomplete({ otrInvoiceId: '25594544', status: 'NEED_TO_FACTOR' })).toBe(true)
    expect(otrDocsIncomplete({ otrInvoiceId: '25594544', status: 'PENDING_WITH_OTR' })).toBe(false)
    expect(otrDocsIncomplete({ otrInvoiceId: null, status: 'NEED_TO_FACTOR' })).toBe(false)
  })
})
