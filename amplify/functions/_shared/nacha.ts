/**
 * NACHA ACH file builder for Chase's "ACH file upload" (CCD/PPD credits only).
 *
 * Built from Chase's "NACHA File Specifications" (May 2024): 94-character fixed-width records,
 * record types 1/5/6/7/8/9, blocking factor 10, service class 220 (credits only, no offset
 * entry, no mixed batches), one batch, one entry per payment with a single 05 addenda.
 *
 * Pure: no I/O, no clock reads, nothing logged. A caller hands in already-validated rows; this
 * file only formats them and re-checks the arithmetic NACHA requires. Account numbers are
 * written into the file text and nowhere else.
 */

/** The Chase routing numbers the spec accepts for the immediate destination / ODFI. */
export const CHASE_ROUTING_NUMBERS = [
  '021000021', '044000037', '072000326', '083000137',
  '074000010', '072412927', '071000013', '075000019',
  '111000614', '102001017', '065400137', '122100024',
  '124001545', '103000648', '325070760', '322271627',
] as const

export type NachaSecCode = 'CCD' | 'PPD'
export type NachaAccountType = 'CHECKING' | 'SAVINGS'

export interface NachaOrigin {
  /** Your company name. Batch header takes 16 characters, file header 23. */
  companyName: string
  /** 10-digit company identification (batch header field 5, immediate origin). */
  companyId: string
  /** Any Chase routing number from the spec's list. Its first 8 digits are the ODFI id. */
  odfiRouting: string
  secCode: NachaSecCode
  /** 10 characters: "CARRIERPAY". Never "PAYROLL" or "REVERSAL" for a vendor batch. */
  entryDescription: string
}

export interface NachaEntry {
  /** Stable key the caller uses to map the entry back to a bill. */
  key: string
  routingNumber: string
  accountNumber: string
  accountType: NachaAccountType
  amountCents: number
  /** Up to 15 of A-Z / 0-9: the PRO. Mandatory for JPMC. */
  identification: string
  /** Receiving company name, 22 characters. */
  name: string
  /** Optional 80-character payment related information (addenda 05). */
  addenda?: string
}

export interface NachaFileInput {
  origin: NachaOrigin
  entries: NachaEntry[]
  /** YYYY-MM-DD, the day the file is made (Chicago). */
  fileDate: string
  /** HHMM, 24-hour. */
  fileTime: string
  /** YYYY-MM-DD, must be after fileDate. */
  effectiveDate: string
  /** A-Z or 0-9 (a second file on the same day moves to B, C…). */
  fileIdModifier?: string
}

export interface NachaFile {
  /** Records joined by CRLF, padded with 9-filled lines to a whole block of 10. */
  text: string
  fileName: string
  entryCount: number
  totalCreditCents: number
  hash: string
  lineCount: number
  blockCount: number
}

const RECORD_LENGTH = 94
const MAX_ENTRY_CENTS = 9_999_999_999
const DESTINATION_NAME = 'JPMORGAN CHASE'

/** ABA checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be a multiple of 10. */
export function isValidRoutingNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false
  const d = value.split('').map(Number)
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])
  return sum % 10 === 0
}

/** Letters, digits and the symbols NACHA names for free text; anything else becomes a space. */
export function nachaText(value: string, length: number): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9./()&'\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, length).padEnd(length, ' ')
}

/** Uppercase A-Z / 0-9 only (the individual identification number allows no symbols). */
export function nachaId(value: string, length: number): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length).padEnd(length, ' ')
}

function numeric(value: number | string, length: number): string {
  const digits = typeof value === 'number' ? String(Math.trunc(value)) : value
  if (!/^\d+$/.test(digits) || digits.length > length) throw new Error('NACHA numeric field out of range')
  return digits.padStart(length, '0')
}

function yymmdd(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('Date must be YYYY-MM-DD')
  return ymd.slice(2, 4) + ymd.slice(5, 7) + ymd.slice(8, 10)
}

function assertLength(record: string): string {
  if (record.length !== RECORD_LENGTH) throw new Error(`NACHA record is ${record.length} characters, not ${RECORD_LENGTH}`)
  return record
}

// ── Business days (the file's effective entry date must land on one) ───────────────────────────

/** Federal Reserve holidays (observed on the weekday; a Saturday holiday is not observed). 2026–2027. */
const BANK_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24',
])

function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`)
}

function formatYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function isBankBusinessDay(ymd: string): boolean {
  const day = parseYmd(ymd).getUTCDay()
  return day !== 0 && day !== 6 && !BANK_HOLIDAYS.has(ymd)
}

/** The first bank business day strictly after `ymd`. */
export function nextBankBusinessDay(ymd: string): string {
  const date = parseYmd(ymd)
  do date.setUTCDate(date.getUTCDate() + 1)
  while (!isBankBusinessDay(formatYmd(date)))
  return formatYmd(date)
}

// ── The file ────────────────────────────────────────────────────────────────────────────────────

export function validateOrigin(origin: NachaOrigin): string | null {
  if (!origin.companyName.trim()) return 'Company name is not set'
  if (!/^\d{10}$/.test(origin.companyId)) return 'Company ID must be exactly 10 digits'
  if (!(CHASE_ROUTING_NUMBERS as readonly string[]).includes(origin.odfiRouting) || !isValidRoutingNumber(origin.odfiRouting)) {
    return 'Chase routing number is not one of the numbers in Chase\'s specification'
  }
  if (origin.secCode !== 'CCD' && origin.secCode !== 'PPD') return 'Entry class must be CCD or PPD'
  const description = origin.entryDescription.trim().toUpperCase()
  if (!description || description.length > 10) return 'Entry description must be 1 to 10 characters'
  if (description === 'PAYROLL' || description === 'REVERSAL') return 'Entry description cannot be PAYROLL or REVERSAL'
  return null
}

/** The checks both file formats share; returns the file ID modifier to use. */
export function checkNachaInput(input: NachaFileInput): string {
  const originProblem = validateOrigin(input.origin)
  if (originProblem) throw new Error(originProblem)
  if (input.entries.length === 0) throw new Error('There are no payments to put in the file')
  if (!(input.effectiveDate > input.fileDate)) throw new Error('The effective date must be after the day the file is made')
  if (!isBankBusinessDay(input.effectiveDate)) throw new Error('The effective date must be a bank business day')
  const modifier = (input.fileIdModifier ?? 'A').toUpperCase()
  if (!/^[A-Z0-9]$/.test(modifier)) throw new Error('File ID modifier must be one letter or digit')
  if (!/^\d{4}$/.test(input.fileTime)) throw new Error('File time must be HHMM')
  for (const entry of input.entries) {
    if (!isValidRoutingNumber(entry.routingNumber)) throw new Error('An entry has an invalid routing number')
    if (!/^[0-9A-Za-z]{1,17}$/.test(entry.accountNumber)) throw new Error('An entry has an invalid account number')
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0 || entry.amountCents > MAX_ENTRY_CENTS) {
      throw new Error('An entry has an amount that cannot go in an ACH file')
    }
  }
  return modifier
}

export function buildNachaFile(input: NachaFileInput): NachaFile {
  const modifier = checkNachaInput(input)

  const { origin } = input
  const odfi8 = origin.odfiRouting.slice(0, 8)
  const description = origin.entryDescription.trim().toUpperCase()
  const lines: string[] = []

  lines.push(assertLength(
    '1' + '01' + ' ' + origin.odfiRouting + origin.companyId +
    yymmdd(input.fileDate) + input.fileTime + modifier + '094' + '10' + '1' +
    nachaText(DESTINATION_NAME, 23) + nachaText(origin.companyName, 23) + ' '.repeat(8),
  ))

  lines.push(assertLength(
    '5' + '220' + nachaText(origin.companyName, 16) + ' '.repeat(20) + origin.companyId +
    origin.secCode + nachaText(description, 10) + ' '.repeat(6) + yymmdd(input.effectiveDate) +
    ' '.repeat(3) + '1' + odfi8 + numeric(1, 7),
  ))

  let hash = 0
  let totalCents = 0
  let recordCount = 0
  input.entries.forEach((entry, index) => {
    if (!isValidRoutingNumber(entry.routingNumber)) throw new Error('An entry has an invalid routing number')
    if (!/^[0-9A-Za-z]{1,17}$/.test(entry.accountNumber)) throw new Error('An entry has an invalid account number')
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0 || entry.amountCents > MAX_ENTRY_CENTS) {
      throw new Error('An entry has an amount that cannot go in an ACH file')
    }
    const sequence = index + 1
    const hasAddenda = typeof entry.addenda === 'string' && entry.addenda.trim().length > 0
    const rdfi8 = entry.routingNumber.slice(0, 8)
    hash += Number(rdfi8)
    totalCents += entry.amountCents
    lines.push(assertLength(
      '6' + (entry.accountType === 'SAVINGS' ? '32' : '22') + rdfi8 + entry.routingNumber.slice(8) +
      entry.accountNumber.padEnd(17, ' ') + numeric(entry.amountCents, 10) +
      nachaId(entry.identification, 15) + nachaText(entry.name, 22) + '  ' + (hasAddenda ? '1' : '0') +
      odfi8 + numeric(sequence, 7),
    ))
    recordCount += 1
    if (hasAddenda) {
      lines.push(assertLength(
        '7' + '05' + nachaText(entry.addenda as string, 80) + '0001' + numeric(sequence, 7),
      ))
      recordCount += 1
    }
  })

  const hash10 = String(hash % 10_000_000_000).padStart(10, '0')
  lines.push(assertLength(
    '8' + '220' + numeric(recordCount, 6) + hash10 + numeric(0, 12) + numeric(totalCents, 12) +
    origin.companyId + ' '.repeat(19) + ' '.repeat(6) + odfi8 + numeric(1, 7),
  ))

  // File control counts every record, including the 9-filled padding the block rule requires.
  const recordsBeforeControl = lines.length + 1
  const blockCount = Math.ceil(recordsBeforeControl / 10)
  lines.push(assertLength(
    '9' + numeric(1, 6) + numeric(blockCount, 6) + numeric(recordCount, 8) + hash10 +
    numeric(0, 12) + numeric(totalCents, 12) + ' '.repeat(39),
  ))
  while (lines.length % 10 !== 0) lines.push('9'.repeat(RECORD_LENGTH))

  return {
    text: lines.join('\r\n') + '\r\n',
    fileName: `BCAT-ACH-${input.fileDate.replace(/-/g, '')}-${input.fileTime}${modifier}.ach`,
    entryCount: input.entries.length,
    totalCreditCents: totalCents,
    hash: hash10,
    lineCount: lines.length,
    blockCount,
  }
}
