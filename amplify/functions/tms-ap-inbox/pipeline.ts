/**
 * Step AG §5.4 — what happens to ONE message. A funnel, cheapest first, and nothing is stored until
 * the model has said the mail is an invoice / credit memo:
 *
 *   0/1  headers + snippet (`prefilterApStage1`)      -> counted, nothing stored
 *   2    body + attachment list (`prefilterApStage2`)  -> counted, nothing stored
 *   3    ONE model call (classify + extract)          -> not an invoice: counted, bytes dropped
 *   then objects -> `putItemIfAbsent` the item -> (AUTO) `applyAuto` | (attach) `attachToTarget`
 *
 * Idempotent: a message already filed (`apin:<id>`) is recognised before any body or model work.
 */
import { createHash } from 'node:crypto'
import { addressOf } from '../../../src/lib/spot/prefilter'
import { redactForPrompt } from '../../../src/lib/workflows/memory'
import { AP_INBOX_ID_PREFIX, AP_INBOX_S3_PREFIX } from '../../../src/lib/apInbox/constants'
import { gmailMessageUrl } from '../../../src/lib/apInbox/links'
import { decide, rankCandidates } from '../../../src/lib/apInbox/match'
import { normalizeApExtraction, type RawApModelOutput } from '../../../src/lib/apInbox/normalize'
import { pickInvoiceAttachments, prefilterApStage1, prefilterApStage2 } from '../../../src/lib/apInbox/prefilter'
import type { ApExtraction } from '../../../src/lib/apInbox/types'
import type { MailboxPort } from '../../../src/lib/apInbox/mailbox'
import type { GmailMessageMeta } from '../../../src/lib/spot/port'
import type {
  ApInboxAttachmentRef,
  ApInboxConfig,
  ApInboxItemRecord,
  ApRunDigest,
  Ledger,
} from '../../../src/lib/apInbox/types'
import { applyAuto, targetFromCandidate } from './apply'
import { attachToTarget } from './attach'
import type { ApInboxDeps } from './contract'

export const MAX_BODY_CHARS = 8000
export const MAX_EMAIL_TEXT_CHARS = 20_000
export const MAX_SUBJECT_CHARS = 200

export type Counters = Pick<
  ApRunDigest,
  'listed' | 'reviewed' | 'stage1Rejected' | 'stage2Rejected' | 'modelCalls' | 'notInvoice' | 'invoices' | 'applied' | 'updatedBills' | 'needReview' | 'errors' | 'abandoned'
>

export const newCounters = (): Counters => ({
  listed: 0, reviewed: 0, stage1Rejected: 0, stage2Rejected: 0, modelCalls: 0, notInvoice: 0,
  invoices: 0, applied: 0, updatedBills: 0, needReview: 0, errors: 0, abandoned: 0,
})

/** A promise-chain mutex: `serial(fn)` runs after every earlier call settled. */
export function createSerial(): PipelineContext['serial'] {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }
}

export interface PipelineContext {
  deps: ApInboxDeps
  config: ApInboxConfig
  mailbox: MailboxPort
  ledger: Ledger
  runId: string
  counters: Counters
  ignoreSenders: string[]
  ignoreKeywords: string[]
  /** Runs `fn` after every earlier `serial` call has finished. */
  serial<T>(fn: () => Promise<T>): Promise<T>
}

/** `FILED` and `EXISTS` and the rejections are all "settled"; `MODEL_CAP` is not (the message stays after the cursor). */
export type MailOutcome = 'REJECTED' | 'NOT_INVOICE' | 'FILED' | 'EXISTS' | 'MODEL_CAP'

const sha20 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 20)
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file'
const isoOf = (internalDate: string): string => new Date(Number(internalDate)).toISOString()

export function itemIdFor(messageId: string, mode: ApInboxConfig['mode']): string {
  return mode === 'SIMULATED' ? `${AP_INBOX_ID_PREFIX}sim:${messageId}` : `${AP_INBOX_ID_PREFIX}${messageId}`
}

function fromName(header: string): string | null {
  const m = header.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)
  return m ? m[1].trim().slice(0, 120) || null : null
}

function emailText(meta: GmailMessageMeta, body: string): string {
  const head = [
    `From: ${meta.from}`,
    `To: ${meta.to.join(', ')}`,
    `Date: ${isoOf(meta.internalDate)}`,
    `Subject: ${meta.subject}`,
    `Message-ID: ${meta.messageId}`,
  ].join('\n')
  return redactForPrompt(`${head}\n\n${body}`).slice(0, MAX_EMAIL_TEXT_CHARS)
}

export async function processMessage(ctx: PipelineContext, meta: GmailMessageMeta): Promise<MailOutcome> {
  const { deps, config, mailbox, counters } = ctx
  const id = itemIdFor(meta.id, config.mode)

  const stage1 = prefilterApStage1(meta, { ignoreSenders: ctx.ignoreSenders, ignoreKeywords: ctx.ignoreKeywords })
  if (!stage1.pass) {
    counters.stage1Rejected += 1
    return 'REJECTED'
  }
  if (await deps.store.getItem(id)) return 'EXISTS'

  const body = await mailbox.getBody(meta.id)
  const stage2 = prefilterApStage2(body.text, body.attachments)
  if (!stage2.pass) {
    counters.stage2Rejected += 1
    return 'REJECTED'
  }

  // Stage 3. The dev bypass reads a classification the harness stored inside the simulated message
  // (never a Gmail header or field): it exists on the dev stack in SIMULATED mode only.
  const devRaw = deps.devStack && config.mode === 'SIMULATED' && deps.devExtraction ? await deps.devExtraction(meta.id) : null
  let raw: RawApModelOutput
  const picked = pickInvoiceAttachments(body.attachments)
  const files: { name: string; contentType: string; bytes: Buffer }[] = []
  for (const att of picked) {
    const bytes = await mailbox.getAttachment(meta.id, att)
    if (bytes) files.push({ name: att.name, contentType: att.contentType, bytes })
  }
  if (devRaw) {
    raw = devRaw as RawApModelOutput
  } else {
    if (counters.modelCalls >= config.maxModelCallsPerRun) return 'MODEL_CAP'
    counters.modelCalls += 1
    raw = await deps.model.extract({
      subject: meta.subject,
      from: meta.from,
      mailDate: isoOf(meta.internalDate).slice(0, 10),
      text: body.text.slice(0, MAX_BODY_CHARS),
      files,
    })
  }
  const ext = normalizeApExtraction(raw, { mailDate: isoOf(meta.internalDate).slice(0, 10) })
  if (ext.kind !== 'INVOICE' && ext.kind !== 'CREDIT_MEMO') {
    counters.notInvoice += 1
    return 'NOT_INVOICE'
  }
  counters.invoices += 1

  // Persist: objects first (a re-read after a crash rewrites the same keys), then the item.
  const base = `${AP_INBOX_S3_PREFIX}${sha20(meta.id)}/`
  const attachments: ApInboxAttachmentRef[] = []
  for (const [i, f] of files.entries()) {
    const key = `${base}${i + 1}-${safeName(f.name)}`
    await deps.objects.put(key, f.bytes, f.contentType)
    attachments.push({ key, name: f.name, contentType: f.contentType, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') })
  }
  const text = emailText(meta, body.text)
  await deps.objects.put(`${base}email.txt`, text, 'text/plain')
  attachments.push({ key: `${base}email.txt`, name: 'email.txt', contentType: 'text/plain', size: Buffer.byteLength(text) })

  // Matching, filing and the bill write run one message at a time: two mails for one PRO must not
  // both read the same placeholder, and the per-run auto-apply cap must not be overshot.
  return ctx.serial(() => fileAndApply(ctx, meta, ext, attachments))
}

async function fileAndApply(
  ctx: PipelineContext,
  meta: GmailMessageMeta,
  ext: ApExtraction,
  attachments: ApInboxAttachmentRef[],
): Promise<MailOutcome> {
  const { deps, config, counters } = ctx
  const id = itemIdFor(meta.id, config.mode)
  const candidates = rankCandidates(ext, ctx.ledger)
  const decision = decide(ext, candidates, ctx.ledger, config, { autoApplied: counters.applied })
  const top = decision.top
  const item: ApInboxItemRecord = {
    id,
    messageId: meta.id,
    threadId: meta.threadId,
    mailbox: config.mailbox,
    mode: config.mode,
    receivedAt: isoOf(meta.internalDate),
    fromEmail: addressOf(meta.from),
    fromName: fromName(meta.from),
    subject: meta.subject.slice(0, MAX_SUBJECT_CHARS),
    kind: ext.kind === 'CREDIT_MEMO' ? 'CREDIT_MEMO' : 'INVOICE',
    status: 'NEEDS_REVIEW',
    reviewReason: decision.outcome === 'REVIEW' ? decision.reason : null,
    extraction: ext,
    match: { top, candidates: decision.candidates, score: top?.score ?? 0, signals: top?.signals ?? [], vetoes: top?.vetoes ?? [] },
    attachments,
    sourceUrl: gmailMessageUrl(config.mailbox, meta.id),
    runId: ctx.runId,
    version: 1,
  }
  if (!(await deps.store.putItemIfAbsent(item))) return 'EXISTS'

  let needsReview = true
  try {
    if (decision.outcome === 'AUTO') {
      const res = await applyAuto(deps, item, decision, deps.now())
      if (res.status === 'APPLIED') {
        needsReview = false
        counters.applied += 1
        if (res.wroteFields) counters.updatedBills += 1
        await refreshLedger(ctx, top?.targetKind, top?.targetId)
      }
    } else if (decision.attach && top) {
      await attachToTarget(deps, item, targetFromCandidate(top))
    }
  } catch (err) {
    // The item is already filed and visible in the queue; the write is not retried blindly.
    counters.errors += 1
    console.warn('[tms-ap-inbox] apply failed:', meta.id, err instanceof Error ? err.name : 'error')
  }
  if (needsReview) counters.needReview += 1
  return 'FILED'
}

/** After a write the matcher must see the row as it is now (a placeholder is no longer one). */
async function refreshLedger(ctx: PipelineContext, kind: string | undefined, id: string | undefined): Promise<void> {
  if (!id) return
  const { store } = ctx.deps
  if (kind === 'CARRIER_BILL') {
    const bill = await store.getBill(id)
    ctx.ledger.bills = ctx.ledger.bills.flatMap((b) => (b.id !== id ? [b] : bill ? [bill] : []))
  } else if (kind === 'VENDOR_PAYABLE') {
    const vendor = await store.getVendorPayable(id)
    ctx.ledger.vendorPayables = ctx.ledger.vendorPayables.map((v) => (v.id === id && vendor ? vendor : v))
  }
}
