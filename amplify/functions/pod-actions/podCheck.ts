/**
 * The first pass over a driver's POD, before a person reviews it on the PODs page.
 *
 * A POD gets an invoice paid only if it is the right POD, all of it, and readable. Each of
 * those failed in practice, and each was found weeks later by a broker:
 *
 *  - the wrong delivery's paperwork (addresses that are not the rate confirmation's),
 *  - page 1 of 2 with page 2 never sent,
 *  - a photo nobody can read.
 *
 * So every POD from the driver apps is read once, as soon as its pages are merged, against
 * the load's rate confirmation. The answer is ADVICE stored on the submission: the
 * reviewer on the PODs page decides, and nothing here approves or rejects anything.
 */
import Anthropic from '@anthropic-ai/sdk'
import { PDFDocument } from 'pdf-lib'

export type CheckVerdict = 'PASS' | 'FAIL' | 'UNCLEAR'

/** Stored as JSON on DriverSubmission.podCheck. Mirrored in src/lib/podReview.ts. */
export interface PodCheckResult {
  checkedAt: string
  model: string
  addresses: {
    verdict: CheckVerdict
    pod: { shipper: string; consignee: string }
    rateCon: { pickup: string; delivery: string }
    /** True when there was no rate confirmation and the load's stops stood in for it. */
    fromLoadStops: boolean
    notes: string
  }
  pages: {
    verdict: CheckVerdict
    /** What the page itself says, e.g. "Page 1 of 2". Empty when nothing is printed. */
    markers: string
    /** The total the paperwork claims, or null when it does not say. */
    statedTotal: number | null
    /** Pages actually in the merged PDF. */
    received: number
    notes: string
  }
  legibility: {
    verdict: CheckVerdict
    notes: string
  }
  signed: CheckVerdict
  summary: string
}

const MODEL = 'claude-opus-5-5'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'podShipper', 'podConsignee', 'rateConPickup', 'rateConDelivery', 'addressVerdict', 'addressNotes',
    'pageMarkers', 'statedTotalPages', 'missingPagesNotes',
    'legibilityVerdict', 'legibilityNotes', 'signed', 'summary',
  ],
  properties: {
    podShipper:        { type: 'string', description: 'Shipper / pickup name and address as printed on the POD, or "" if not shown' },
    podConsignee:      { type: 'string', description: 'Consignee / delivery name and address as printed on the POD, or "" if not shown' },
    rateConPickup:     { type: 'string', description: 'Pickup name and address from the rate confirmation (or the load stops given in text)' },
    rateConDelivery:   { type: 'string', description: 'Delivery name and address from the rate confirmation (or the load stops given in text)' },
    addressVerdict:    { type: 'string', enum: ['PASS', 'FAIL', 'UNCLEAR'], description: 'PASS when the POD is for the same pickup and delivery as the rate confirmation; FAIL when it names a different place; UNCLEAR when the POD does not show enough to tell' },
    addressNotes:      { type: 'string', description: 'One sentence: what matched or what differed' },
    pageMarkers:       { type: 'string', description: 'Any page numbering printed on the pages, verbatim, e.g. "Page 1 of 2". "" if none' },
    statedTotalPages:  { type: 'number', description: 'The total page count the paperwork states (the 2 in "1 of 2"). 0 if it does not state one' },
    missingPagesNotes: { type: 'string', description: 'Which numbered pages are missing, or that the pages look complete, in one sentence' },
    legibilityVerdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNCLEAR'], description: 'PASS when a broker could read the delivery details, date and signature; FAIL when key parts are blurred, dark, cut off or unreadable' },
    legibilityNotes:   { type: 'string', description: 'What is hard to read and on which page, in words the driver can act on. "" when it all reads clearly' },
    signed:            { type: 'string', enum: ['PASS', 'FAIL', 'UNCLEAR'], description: 'PASS when the receiver signed the POD, FAIL when the signature line is blank' },
    summary:           { type: 'string', description: 'One sentence for the reviewer' },
  },
} as const

interface ModelAnswer {
  podShipper: string
  podConsignee: string
  rateConPickup: string
  rateConDelivery: string
  addressVerdict: CheckVerdict
  addressNotes: string
  pageMarkers: string
  statedTotalPages: number
  missingPagesNotes: string
  legibilityVerdict: CheckVerdict
  legibilityNotes: string
  signed: CheckVerdict
  summary: string
}

/** The load's stops in words, for when there is no rate confirmation file to compare with. */
export function stopsText(stops: Array<Record<string, unknown>> | null | undefined): string {
  const lines = (stops ?? []).map((s) => {
    const addr = (s.address ?? {}) as Record<string, unknown>
    const parts = [s.name, addr.line1 ?? addr.street, s.city ?? [addr.city, addr.state].filter(Boolean).join(', '), addr.zip]
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean)
    return `${s.type === 'pickup' ? 'Pickup' : 'Delivery'}: ${parts.join(', ') || 'not recorded'}`
  })
  return lines.join('\n')
}

/**
 * Pages complete or not, from numbers rather than the model's opinion where numbers exist.
 * "1 of 2" with two pages received is complete; with one, it is not.
 */
export function pagesVerdict(statedTotal: number | null, received: number, markers: string): CheckVerdict {
  if (statedTotal && statedTotal > 0) return received >= statedTotal ? 'PASS' : 'FAIL'
  // Nothing printed to count against: one page with no numbering is the usual single-page POD.
  return markers.trim() ? 'UNCLEAR' : 'PASS'
}

export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}

export async function checkPod(input: {
  apiKey: string
  podPdf: Uint8Array
  rateConPdf: Uint8Array | null
  stops: Array<Record<string, unknown>> | null
  pro: string
  now?: () => Date
}): Promise<PodCheckResult> {
  const received = await countPdfPages(input.podPdf)
  const client = new Anthropic({ apiKey: input.apiKey, timeout: 150_000, maxRetries: 1 })
  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  if (input.rateConPdf) {
    content.push({ type: 'text', text: 'Document 1 is the RATE CONFIRMATION for this load.' })
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(input.rateConPdf).toString('base64') } })
  }
  content.push({ type: 'text', text: `${input.rateConPdf ? 'Document 2' : 'This document'} is the POD (proof of delivery) the driver sent. It has ${received} page(s).` })
  content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(input.podPdf).toString('base64') } })
  content.push({
    type: 'text',
    text: [
      `Load PRO ${input.pro}.`,
      input.rateConPdf
        ? 'Compare the POD with the rate confirmation.'
        : `There is no rate confirmation file. Compare the POD with these stops from the load instead:\n${stopsText(input.stops) || 'none recorded'}`,
      '',
      'Check three things for the office reviewer:',
      '1. Addresses: is this POD for the same pickup and delivery as the rate confirmation? Small differences (suite numbers, abbreviations, a DC name vs the company name) still PASS. A different city or facility FAILS.',
      '2. Pages: copy any printed page numbering ("Page 1 of 2", "1/3") and the total it states. Note numbered pages that are not in the file.',
      '3. Legibility: could a broker read the delivery details, the date and the receiver signature? Say which page is the problem.',
      'Also say whether the receiver signed.',
      'Report what the documents show. If something cannot be seen, say UNCLEAR rather than guessing.',
    ].join('\n'),
  })

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  })
  const final = await stream.finalMessage()
  if (final.stop_reason === 'refusal') throw new Error('The POD check was declined by the model')
  const text = final.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
  const a = JSON.parse(text) as ModelAnswer

  const statedTotal = a.statedTotalPages > 0 ? Math.round(a.statedTotalPages) : null
  return {
    checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    model: final.model,
    addresses: {
      verdict: a.addressVerdict,
      pod: { shipper: a.podShipper, consignee: a.podConsignee },
      rateCon: { pickup: a.rateConPickup, delivery: a.rateConDelivery },
      fromLoadStops: !input.rateConPdf,
      notes: a.addressNotes,
    },
    pages: {
      verdict: pagesVerdict(statedTotal, received, a.pageMarkers),
      markers: a.pageMarkers,
      statedTotal,
      received,
      notes: a.missingPagesNotes,
    },
    legibility: { verdict: a.legibilityVerdict, notes: a.legibilityNotes },
    signed: a.signed,
    summary: a.summary,
  }
}
