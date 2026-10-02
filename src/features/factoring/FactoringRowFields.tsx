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
    return (
      <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
        Not prepared yet
      </span>
    )
  }

  const missing = new Set<OtrRequiredField>(readiness.missingFields)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, maxWidth: 300 }}>
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
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              border: '1px solid',
              ...(ok
                ? { background: '#dcfce7', color: '#15803d', borderColor: '#86efac' }
                : { background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' }),
            }}
          >
            {SHORT[field]}
          </span>
        )
      })}
    </div>
  )
}
