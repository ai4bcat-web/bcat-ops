/**
 * Chase ACH file for the AP Selected tab.
 *
 * PREVIEW_CHASE_ACH decrypts nothing into a response: it classifies each chosen bill and returns last fours
 * and reasons. EXPORT_CHASE_ACH does the same, marks the bills it puts in the file ("Exported to Chase"),
 * and returns the NACHA text. Neither posts a payment, sends a remittance, or calls a bank: Ryne uploads the
 * file to Chase himself, then posts payments through the existing step.
 *
 * The clear numbers exist only between `kms:Decrypt` (finance role only, `bankAccount` field only, see the
 * vault key policy in backend.ts) and the string this returns inside the file. Nothing here logs, audits or
 * throws one: errors are fixed sentences, audit rows carry counts, totals, last fours and who.
 */
import { randomUUID } from 'node:crypto'
import { assertArrayOf, assertString, optionalBoolean, optionalString, type Caller } from '../_shared/actionInputs'
import {
  BankVaultError,
  bankVaultDepsFromEnv,
  decryptBankDetails,
  type BankVaultDeps,
} from '../_shared/bankVault'
import {
  buildNachaFile,
  isBankBusinessDay,
  nextBankBusinessDay,
  validateOrigin,
  type NachaOrigin,
} from '../_shared/nacha'
import type { CarrierBillRecord, CarrierPaymentMethodRecord } from '../../../src/types/tms'
import { effectiveBillPayee } from '../../../src/lib/carrierBill'
import { chicagoDateStr } from '../../../src/lib/date'
import { classifyAchBill, type AchRowOutcome, type BankDetails, type AchPreviewRow } from './achRows'
import {
  CARRIER_BILL_TABLE_NAME,
  CARRIER_PAYMENT_METHOD_TABLE_NAME,
  CARRIER_TABLE_NAME,
  IDX_PAYMENT_METHODS_BY_CARRIER,
  SETTINGS_ID,
  SETTINGS_TABLE_NAME,
  getById,
  getSettings,
  nowIso,
  queryIndex,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'

const MAX_EXPORT_BILLS = 200
const DEFAULT_ENTRY_DESCRIPTION = 'CARRIERPAY'

let bankDeps: BankVaultDeps | null = null
const vault = (): BankVaultDeps => (bankDeps ??= bankVaultDepsFromEnv())

/** Test hook: the suite swaps the KMS client for a fake and never touches real keys. */
export function setBankVaultForTests(deps: BankVaultDeps | null): void {
  bankDeps = deps
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

export interface ChaseAchSettings {
  companyName: string
  companyId: string
  odfiRouting: string
  secCode: 'CCD' | 'PPD'
  entryDescription: string
  fileSeq?: { date: string; n: number }
}

function settingsFrom(row: Row): ChaseAchSettings | null {
  const raw = row.chaseAch
  const value = typeof raw === 'string' ? safeJson(raw) : raw
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  return {
    companyName: String(v.companyName ?? ''),
    companyId: String(v.companyId ?? ''),
    odfiRouting: String(v.odfiRouting ?? ''),
    secCode: v.secCode === 'PPD' ? 'PPD' : 'CCD',
    entryDescription: String(v.entryDescription ?? DEFAULT_ENTRY_DESCRIPTION),
    ...(v.fileSeq && typeof v.fileSeq === 'object' ? { fileSeq: v.fileSeq as { date: string; n: number } } : {}),
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

const originOf = (s: ChaseAchSettings): NachaOrigin => ({
  companyName: s.companyName,
  companyId: s.companyId,
  odfiRouting: s.odfiRouting,
  secCode: s.secCode,
  entryDescription: s.entryDescription,
})

/** Admin only (router): where the file comes from. None of this is a bank secret, but it is a bank setting. */
export async function saveChaseAchSettings(input: Row, caller: Caller): Promise<Row> {
  const current = settingsFrom(await getSettings())
  const next: ChaseAchSettings = {
    companyName: assertString(input.companyName, 'companyName').trim(),
    companyId: assertString(input.companyId, 'companyId').replace(/\s/g, ''),
    odfiRouting: assertString(input.odfiRouting, 'odfiRouting').replace(/[\s-]/g, ''),
    secCode: input.secCode === 'PPD' ? 'PPD' : 'CCD',
    entryDescription: (optionalString(input.entryDescription, 10) ?? DEFAULT_ENTRY_DESCRIPTION).toUpperCase(),
    ...(current?.fileSeq ? { fileSeq: current.fileSeq } : {}),
  }
  const problem = validateOrigin(originOf(next))
  if (problem) throw new Error(problem)
  const now = nowIso()
  await transact([updateTx(SETTINGS_TABLE_NAME, SETTINGS_ID, { __typename: 'TmsSettings', chaseAch: next, updatedAt: now, updatedBy: caller.email })], 'Chase ACH settings')
  await writeAudit('TmsSettings', SETTINGS_ID, 'SAVE_CHASE_ACH_SETTINGS', caller, {
    companyName: next.companyName, companyId: next.companyId, odfiRouting: next.odfiRouting, secCode: next.secCode, entryDescription: next.entryDescription,
  })
  return { chaseAch: next }
}

// ── Preview / export ────────────────────────────────────────────────────────────────────────────

interface Resolved {
  outcomes: AchRowOutcome[]
  settings: ChaseAchSettings | null
  settingsProblem: string | null
  effectiveDate: string
  today: string
}

function chicagoNow(): { date: string; hhmm: string } {
  const now = new Date()
  const date = chicagoDateStr(now)
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return { date, hhmm: `${hh}${mm}` }
}

function readIds(input: Row): string[] {
  const ids = assertArrayOf<string>(input.billIds, 'billIds', (item, index) => assertString(item, `billIds[${index}]`), MAX_EXPORT_BILLS)
  if (ids.length === 0) throw new Error('Choose at least one bill')
  return [...new Set(ids)]
}

async function detailsFor(method: CarrierPaymentMethodRecord | null, carrierId: string): Promise<BankDetails | null> {
  if (!method || method.method !== 'ACH') return null
  const row = await getById(CARRIER_PAYMENT_METHOD_TABLE_NAME, method.id)
  const cipher = row?.bankCipher
  if (!(cipher instanceof Uint8Array)) return null
  try {
    return await decryptBankDetails(vault(), { carrierId, methodId: method.id }, cipher)
  } catch (err) {
    if (err instanceof BankVaultError) return null
    throw err
  }
}

async function resolve(input: Row): Promise<Resolved> {
  const ids = readIds(input)
  const { date: today } = chicagoNow()
  const requested = optionalString(input.effectiveDate, 10)
  const effectiveDate = requested ?? nextBankBusinessDay(today)
  const settings = settingsFrom(await getSettings())
  const settingsProblem = settings ? validateOrigin(originOf(settings)) : 'Chase file settings are not set up yet (Settings > Accounts payable)'

  const methodsByCarrier = new Map<string, CarrierPaymentMethodRecord[]>()
  const carriers = new Map<string, Row | null>()
  const outcomes: AchRowOutcome[] = []
  for (const billId of ids) {
    const bill = await getById(CARRIER_BILL_TABLE_NAME, billId) as (CarrierBillRecord & { achExportedAt?: string }) | null
    if (!bill) {
      outcomes.push({ status: 'BLOCKED', billId, reason: 'Bill not found', preview: emptyPreview(billId) })
      continue
    }
    if (bill.selectedForPayment !== true) {
      outcomes.push({ status: 'SKIPPED', billId, reason: 'The bill is not on the Selected tab', preview: emptyPreview(billId, bill) })
      continue
    }
    if (!carriers.has(bill.carrierId)) carriers.set(bill.carrierId, await getById(CARRIER_TABLE_NAME, bill.carrierId))
    if (!methodsByCarrier.has(bill.carrierId)) {
      methodsByCarrier.set(bill.carrierId, await queryIndex(CARRIER_PAYMENT_METHOD_TABLE_NAME, IDX_PAYMENT_METHODS_BY_CARRIER, 'carrierId', bill.carrierId) as unknown as CarrierPaymentMethodRecord[])
    }
    const carrier = carriers.get(bill.carrierId) as Parameters<typeof effectiveBillPayee>[1]
    const methods = methodsByCarrier.get(bill.carrierId) ?? []
    const { payee } = effectiveBillPayee(bill, carrier, methods)
    const method = methods.find((item) => item.id === payee.paymentMethodId) ?? null
    const details = await detailsFor(method, bill.carrierId)
    outcomes.push(classifyAchBill(bill, carrier, methods, details))
  }
  return { outcomes, settings, settingsProblem, effectiveDate, today }
}

function emptyPreview(billId: string, bill?: Partial<CarrierBillRecord> & { achExportedAt?: string }): AchPreviewRow {
  return {
    billId, pro: String(bill?.shipmentNumber ?? '').split('-')[0], payeeName: bill?.carrierName ?? 'Unknown', payeeKind: 'CARRIER',
    method: 'NONE', last4: null, amountCents: Math.max(0, Math.trunc(bill?.balanceCents ?? 0)), alreadyExportedAt: bill?.achExportedAt ?? null,
  }
}

function summarize(outcomes: AchRowOutcome[]): Row[] {
  return outcomes.map((o) => ({
    status: o.status,
    ...(o.status === 'READY' ? { warnings: o.warnings } : { reason: o.reason }),
    ...o.preview,
  }))
}

function dateProblem(effectiveDate: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return 'The effective date must be a date'
  if (!(effectiveDate > today)) return 'The effective date must be after today'
  if (!isBankBusinessDay(effectiveDate)) return 'The effective date must be a bank business day'
  return null
}

export async function previewChaseAch(input: Row): Promise<Row> {
  const r = await resolve(input)
  const ready = r.outcomes.filter((o) => o.status === 'READY')
  return {
    settingsReady: r.settingsProblem == null,
    settingsProblem: r.settingsProblem,
    effectiveDate: r.effectiveDate,
    effectiveDateProblem: dateProblem(r.effectiveDate, r.today),
    rows: summarize(r.outcomes),
    readyCount: ready.length,
    readyTotalCents: ready.reduce((sum, o) => sum + (o.status === 'READY' ? o.entry.amountCents : 0), 0),
    blockedCount: r.outcomes.filter((o) => o.status === 'BLOCKED').length,
    skippedCount: r.outcomes.filter((o) => o.status === 'SKIPPED').length,
    alreadyExportedCount: ready.filter((o) => o.preview.alreadyExportedAt).length,
  }
}

function modifierFor(seq: { date: string; n: number } | undefined, today: string): { modifier: string; next: { date: string; n: number } } {
  const n = seq && seq.date === today ? seq.n : 0
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  if (n >= chars.length) throw new Error('That is more files than Chase allows in one day')
  return { modifier: chars[n], next: { date: today, n: n + 1 } }
}

export async function exportChaseAch(input: Row, caller: Caller): Promise<Row> {
  const includeAgain = optionalBoolean(input.includeAlreadyExported) === true
  const r = await resolve(input)
  if (r.settingsProblem || !r.settings) throw new Error(r.settingsProblem ?? 'Chase file settings are not set up yet')
  const dateIssue = dateProblem(r.effectiveDate, r.today)
  if (dateIssue) throw new Error(dateIssue)

  const wanted = r.outcomes.filter((o): o is Extract<AchRowOutcome, { status: 'READY' }> => o.status === 'READY' && (includeAgain || !o.preview.alreadyExportedAt))
  const heldBack = r.outcomes.filter((o) => o.status === 'READY' && !wanted.includes(o as never))
  if (wanted.length === 0) {
    throw new Error(heldBack.length > 0
      ? 'Every ready bill was already exported. Export again to include them.'
      : 'No bill is ready for an ACH file. Blocked bills show the reason in the preview.')
  }

  // Mark first. A bill somebody else just changed is left out of the file rather than half-recorded.
  const exportId = randomUUID()
  const now = nowIso()
  const marked: typeof wanted = []
  const notMarked: Row[] = []
  for (const row of wanted) {
    const bill = await getById(CARRIER_BILL_TABLE_NAME, row.billId) as CarrierBillRecord | null
    if (!bill) continue
    try {
      await transact([
        updateTx(
          CARRIER_BILL_TABLE_NAME,
          row.billId,
          { achExportedAt: now, achExportedBy: caller.email, achExportId: exportId, status: bill.status, updatedAt: now, updatedBy: caller.email, version: (bill.version ?? 1) + 1 },
          { condition: '#status = :status AND version = :expectedVersion', extraValues: { ':expectedVersion': { N: String(bill.version ?? 1) } } },
        ),
      ], 'ACH export mark')
      marked.push(row)
    } catch {
      notMarked.push({ billId: row.billId, reason: 'The bill changed while the file was being made; try again' })
    }
  }
  if (marked.length === 0) throw new Error('The bills changed while the file was being made; try again')

  const { date: fileDate, hhmm } = chicagoNow()
  const { modifier, next } = modifierFor(r.settings.fileSeq, fileDate)
  const file = buildNachaFile({
    origin: originOf(r.settings),
    entries: marked.map((row) => row.entry),
    fileDate,
    fileTime: hhmm,
    effectiveDate: r.effectiveDate,
    fileIdModifier: modifier,
  })
  await transact([updateTx(SETTINGS_TABLE_NAME, SETTINGS_ID, { __typename: 'TmsSettings', chaseAch: { ...r.settings, fileSeq: next }, updatedAt: now, updatedBy: caller.email })], 'Chase ACH file counter')

  await writeAudit('TmsSettings', SETTINGS_ID, 'EXPORT_CHASE_ACH', caller, {
    exportId, fileName: file.fileName, entryCount: file.entryCount, totalCents: file.totalCreditCents, effectiveDate: r.effectiveDate,
    bills: marked.map((row) => ({ billId: row.billId, pro: row.preview.pro, payee: row.preview.payeeName, last4: row.preview.last4, amountCents: row.entry.amountCents })),
  })
  for (const row of marked) {
    await writeAudit('CarrierBill', row.billId, 'EXPORT_CHASE_ACH', caller, { exportId, amountCents: row.entry.amountCents, last4: row.preview.last4, effectiveDate: r.effectiveDate })
  }

  return {
    exportId,
    fileName: file.fileName,
    fileText: file.text,
    entryCount: file.entryCount,
    totalCents: file.totalCreditCents,
    effectiveDate: r.effectiveDate,
    exportedBillIds: marked.map((row) => row.billId),
    notExported: [
      ...notMarked,
      ...r.outcomes.filter((o) => o.status !== 'READY').map((o) => ({ billId: o.billId, reason: (o as { reason: string }).reason })),
      ...heldBack.map((o) => ({ billId: o.billId, reason: `Already exported ${o.preview.alreadyExportedAt ?? ''}`.trim() })),
    ],
  }
}

/** The file was never uploaded: take the mark back so the bills read as not exported. */
export async function clearChaseAchMark(input: Row, caller: Caller): Promise<Row> {
  const cleared: string[] = []
  for (const billId of readIds(input)) {
    const bill = await getById(CARRIER_BILL_TABLE_NAME, billId) as (CarrierBillRecord & { achExportedAt?: string }) | null
    if (!bill || !bill.achExportedAt) continue
    const now = nowIso()
    await transact([
      updateTx(
        CARRIER_BILL_TABLE_NAME,
        billId,
        { status: bill.status, updatedAt: now, updatedBy: caller.email, version: (bill.version ?? 1) + 1 },
        {
          remove: ['achExportedAt', 'achExportedBy', 'achExportId'],
          condition: '#status = :status AND version = :expectedVersion',
          extraValues: { ':expectedVersion': { N: String(bill.version ?? 1) } },
        },
      ),
    ], 'ACH export mark')
    await writeAudit('CarrierBill', billId, 'CLEAR_CHASE_ACH_MARK', caller, { previousExportId: (bill as { achExportId?: string }).achExportId ?? null })
    cleared.push(billId)
  }
  return { cleared }
}
