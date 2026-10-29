/**
 * The eleven fields OTR requires, as a row of green and red chips.
 *
 * Eleven columns will not fit a table that also carries PRO, customer, amount, documents
 * and a status. So they become one column of small labelled chips: green where a value
 * resolved, red where it is still missing. The point is that a glance down the queue shows
 * which rows can be invoiced, without opening anything.
 *
 * Red is a to-do, not an error. Most gaps resolve the moment someone types the broker MC,
 * and the row's own editor is where that happens.
 */
import { OTR_FIELD_LABEL, OTR_REQUIRED_FIELDS, type OtrReadiness, type OtrRequiredField } from '@/lib/otrInvoice'

/** Short enough to sit in a chip; the full label is the tooltip. */
const SHORT: Record<OtrRequiredField, string> = {
  InvoiceNo: 'PRO',
  PoNumber: 'PO',
  BrokerMC: 'MC',
  InvoiceAmount: 'Amt',
  InvoiceDate: 'Date',
  FromCity: 'F.City',
  FromState: 'F.St',
  FromZip: 'F.Zip',
  ToCity: 'T.City',
  ToState: 'T.St',
  ToZip: 'T.Zip',
}

export function FactoringRowFields({ readiness }: { readiness: OtrReadiness | null }) {
  if (!readiness) {
    return <span className="text-[11.5px] tms-muted">Not prepared yet</span>
  }

  const missing = new Set<OtrRequiredField>(readiness.missingFields)

  return (
    <div className="flex max-w-[300px] flex-wrap gap-[3px]">
      {OTR_REQUIRED_FIELDS.map((field) => {
        const ok = !missing.has(field)
        const value = readiness.payload?.[field]
        return (
          <span
            key={field}
            title={
              ok
                ? `${OTR_FIELD_LABEL[field]}: ${String(value)}`
                : `${OTR_FIELD_LABEL[field]} is missing`
            }
            className="rounded px-1.5 text-[10px] font-bold"
            style={{
              whiteSpace: 'nowrap',
              border: '1px solid',
              color: ok ? 'var(--tms-badge-green)' : 'var(--tms-badge-red)',
              borderColor: ok ? 'var(--tms-badge-green)' : 'var(--tms-badge-red)',
            }}
          >
            {SHORT[field]}
          </span>
        )
      })}
    </div>
  )
}
