/**
 * Chase's CSV ACH template ("NachaCSVSampleFile.csv"): the same payments as the NACHA file in the
 * three-section layout Chase Business Online reads: a file row (indicator 1), a batch row (5) and one
 * entry row (6) per payment.
 *
 * Pure, like nacha.ts. The pay-from "Chase Acct" is left blank: that is a real account number of the
 * company's own, the app never holds it, and Chase asks for it at upload. Account numbers are written
 * into the text and nowhere else.
 */
import { checkNachaInput, nachaId, nachaText, type NachaFileInput } from './nacha'

export interface ChaseCsvFile {
  text: string
  fileName: string
  entryCount: number
  totalCreditCents: number
}

const FILE_HEADER = ['Indicator', 'File ID (Modifier)', 'File creation date', 'File creation time', 'Total trxn', 'Total ACH credit amount', 'Total ACH debit amount', 'Batch Count']
const BATCH_HEADER = ['Indicator', 'Service class code', 'Chase Acct', 'SEC Code', 'Entry description', 'Delivery by date', 'Batch credit amount', 'Batch debit amount', 'Batch number', 'Trxn in Batch']
const ENTRY_HEADER = ['Indicator', 'Trxn Code', 'Routing Num', 'Acct number', 'Trxn amount', 'ID Number', 'Payee name', 'Trxn ID', 'Addenda']

/** One CSV cell: quoted when it holds a comma, quote or line break; never starts with a spreadsheet formula character. */
export function csvCell(value: string): string {
  const safe = value.replace(/^[=+\-@\t\r]+/, '')
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const row = (cells: Array<string | number>): string => cells.map((c) => csvCell(String(c))).join(',')

const dollars = (cents: number): string => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

/** YYYY-MM-DD → MM/DD/YYYY. */
function usDate(ymd: string): string {
  return `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`
}

export function buildChaseCsv(input: NachaFileInput): ChaseCsvFile {
  const modifier = checkNachaInput(input)
  const { origin, entries } = input
  const description = nachaText(origin.entryDescription.trim().toUpperCase(), 10).trim()
  const total = entries.reduce((sum, e) => sum + e.amountCents, 0)

  const lines: string[] = [
    row(FILE_HEADER),
    row([1, modifier, usDate(input.fileDate), input.fileTime, entries.length, dollars(total), '0.00', 1]),
    row(BATCH_HEADER),
    row([5, 220, '', origin.secCode, description, usDate(input.effectiveDate), dollars(total), '0.00', 1, entries.length]),
    row(ENTRY_HEADER),
  ]
  entries.forEach((entry, index) => {
    lines.push(row([
      6,
      entry.accountType === 'SAVINGS' ? 32 : 22,
      entry.routingNumber,
      entry.accountNumber,
      dollars(entry.amountCents),
      nachaId(entry.identification, 15).trim(),
      nachaText(entry.name, 22).trim(),
      `${modifier}${String(index + 1).padStart(4, '0')}`,
      entry.addenda ? nachaText(entry.addenda, 80).trim() : '',
    ]))
  })

  return {
    text: lines.join('\r\n') + '\r\n',
    fileName: `BCAT-ACH-${input.fileDate.replace(/-/g, '')}-${input.fileTime}${modifier}.csv`,
    entryCount: entries.length,
    totalCreditCents: total,
  }
}
