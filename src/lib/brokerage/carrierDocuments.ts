/**
 * Carrier document templates (Step L) — rate confirmation and carrier agreement.
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */
import type { CarrierAgreementTemplate, RateConTemplate } from '../../types/tms'

const CARRIER_DOCUMENT_TYPES = [
  'AUTHORITY',
  'COI_AUTO',
  'COI_CARGO',
  'COI_GENERAL',
  'W9',
  'CARRIER_AGREEMENT',
  'FACTOR_NOA',
  'CDL',
  'RATE_CON',
  'OTHER',
] as const

const MAX_EXTRA_TERMS = 50
const MAX_EXTRA_TERM_TITLE = 120
const MAX_EXTRA_TERM_TEXT = 4000
const MAX_HTML = 20000
const MAX_MARKDOWN = 20000
const MAX_SIGNATURE_BLOCK = 2000
const MAX_DOCS = 50

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function optionalString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Text value must be a string.')
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error('Text value is too long.')
  return trimmed || null
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'boolean') throw new Error('Boolean value must be true or false.')
  return value
}

/**
 * Minimal server-side sanitization for rate-con terms HTML. Only a small
 * presentation tag whitelist is allowed; everything else is stripped.
 */
function sanitizeTermsHtml(raw: string): string {
  const allowed: Record<string, true> = {
    a: true, b: true, br: true, div: true, em: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
    i: true, li: true, ol: true, p: true, span: true, strong: true, table: true, tbody: true, td: true, th: true, thead: true, tr: true, ul: true,
  }
  // Strip tags that are not in the whitelist.
  return raw.replace(/<\/?([a-zA-Z0-9]+)(?:\s[^>]*)?>/g, (match, tag) => {
    const lower = tag.toLowerCase()
    if (allowed[lower]) return match
    return ''
  })
}

/**
 * Validate the rate confirmation template. requiredFields is stored but the
 * signing form still reads the org's rateConRequiredFields so the two cannot drift.
 */
export function validateRateConTemplate(value: unknown): RateConTemplate | null {
  if (value === null || value === undefined) return null
  const row = asRecord(value)
  if (!row) throw new Error('Rate confirmation template must be an object.')

  const extraTermsRaw = Array.isArray(row.extraTerms) ? row.extraTerms : []
  if (extraTermsRaw.length > MAX_EXTRA_TERMS) throw new Error(`At most ${MAX_EXTRA_TERMS} extra terms are allowed.`)
  const extraTerms: Array<{ title: string; text: string }> = []
  for (let i = 0; i < extraTermsRaw.length; i++) {
    const term = asRecord(extraTermsRaw[i])
    if (!term) throw new Error(`Extra term ${i + 1} must be an object.`)
    const title = optionalString(term.title, MAX_EXTRA_TERM_TITLE)
    if (!title) throw new Error(`Extra term ${i + 1} needs a title.`)
    const text = optionalString(term.text, MAX_EXTRA_TERM_TEXT)
    if (!text) throw new Error(`Extra term ${i + 1} needs text.`)
    extraTerms.push({ title, text })
  }

  const termsHtmlRaw = typeof row.termsHtml === 'string' ? row.termsHtml : ''
  const termsHtml = termsHtmlRaw ? sanitizeTermsHtml(termsHtmlRaw.slice(0, MAX_HTML)) : null

  const requiredDocs = Array.isArray(row.requiredDocs) ? row.requiredDocs : []
  if (requiredDocs.length > MAX_DOCS) throw new Error(`At most ${MAX_DOCS} required documents are allowed.`)
  for (const d of requiredDocs) {
    if (typeof d !== 'string' || !CARRIER_DOCUMENT_TYPES.includes(d as typeof CARRIER_DOCUMENT_TYPES[number])) {
      throw new Error(`"${d}" is not a carrier document type.`)
    }
  }

  const requiredFields = Array.isArray(row.requiredFields) ? row.requiredFields : []
  if (requiredFields.length > 50) throw new Error('At most 50 required fields are allowed.')
  for (const f of requiredFields) {
    if (typeof f !== 'string' || !f.trim()) throw new Error('Required field names must be non-empty strings.')
  }

  return {
    overrideDefaultTerms: optionalBoolean(row.overrideDefaultTerms) ?? false,
    extraTerms: extraTerms.length ? extraTerms : null,
    termsHtml,
    hideRep: optionalBoolean(row.hideRep) ?? false,
    legalPageBreak: optionalBoolean(row.legalPageBreak) ?? false,
    requiredDocs: requiredDocs.length ? (requiredDocs as string[]) : null,
    requiredFields: requiredFields.length ? requiredFields.map((f) => String(f).trim()) : null,
  }
}

/**
 * Validate the carrier agreement template. The version is bumped only when the
 * markdown body actually changes.
 */
export function validateCarrierAgreementTemplate(
  value: unknown,
  existing: CarrierAgreementTemplate | null | undefined,
  who: string,
  now: string,
): CarrierAgreementTemplate | null {
  if (value === null || value === undefined) return null
  const row = asRecord(value)
  if (!row) throw new Error('Carrier agreement template must be an object.')

  const bodyMarkdown = optionalString(row.bodyMarkdown, MAX_MARKDOWN)
  if (!bodyMarkdown) throw new Error('Carrier agreement body is required.')

  const requiredDocs = Array.isArray(row.requiredDocs) ? row.requiredDocs : []
  if (requiredDocs.length > MAX_DOCS) throw new Error(`At most ${MAX_DOCS} required documents are allowed.`)
  for (const d of requiredDocs) {
    if (typeof d !== 'string' || !CARRIER_DOCUMENT_TYPES.includes(d as typeof CARRIER_DOCUMENT_TYPES[number])) {
      throw new Error(`"${d}" is not a carrier document type.`)
    }
  }

  const signatureBlock = optionalString(row.signatureBlock, MAX_SIGNATURE_BLOCK)
  const existingBody = existing?.bodyMarkdown
  const bumpVersion = existingBody !== bodyMarkdown
  const priorVersion = typeof existing?.version === 'number' && Number.isFinite(existing.version) ? existing.version : 0

  return {
    bodyMarkdown,
    requiredDocs: requiredDocs.length ? (requiredDocs as string[]) : null,
    signatureBlock,
    version: bumpVersion ? priorVersion + 1 : priorVersion,
    updatedAt: now,
    updatedBy: who,
  }
}
