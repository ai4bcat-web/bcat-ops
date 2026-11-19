/**
 * The payees that need a pay-to: every carrier with open bills that cannot be approved or paid because the carrier
 * has no payment method (or several, none preferred). Biggest balance first, with a button that opens the pay-to
 * editor for that carrier. The Payable banner opens this; the same rule flags the PAY TO column.
 */
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { PAY_TO_STATUS_LABEL, PAY_TO_STATUS_TITLE, type PayToWorkRow } from '../apViews'

export function PayToWorklistDialog({ rows, open, onOpenChange, onAdd }: {
  rows: readonly PayToWorkRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (row: PayToWorkRow) => void
}) {
  const bills = rows.reduce((sum, row) => sum + row.bills, 0)
  const cents = rows.reduce((sum, row) => sum + row.cents, 0)
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Payees missing payment info"
      footer={<TmsButton variant="ghost" onClick={() => onOpenChange(false)}>Close</TmsButton>}
    >
      {rows.length === 0 ? (
        <p className="tms-muted">Every open bill has a payee with what it needs to be paid.</p>
      ) : (
        <>
          <p className="tms-muted">
            {rows.length} {rows.length === 1 ? 'payee' : 'payees'}, {bills} open {bills === 1 ? 'bill' : 'bills'},{' '}
            {formatCents(cents)} that cannot be paid until each payee has a pay-to and the bank info (or address) its method needs. Fix it here and the flag clears.
          </p>
          <table className="tms-aging-inv" aria-label="Payees missing payment info">
            <thead>
              <tr>
                <th scope="col">Carrier</th>
                <th scope="col">What is missing</th>
                <th scope="col" className="tms-dg-right">Open bills</th>
                <th scope="col" className="tms-dg-right">Waiting</th>
                <th scope="col"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.carrierId} data-testid="payto-worklist-row">
                  <td>{row.carrierName}</td>
                  <td><TmsBadge tone="orange" title={PAY_TO_STATUS_TITLE[row.status]}>{PAY_TO_STATUS_LABEL[row.status]}</TmsBadge></td>
                  <td className="tms-dg-right">{row.bills}</td>
                  <td className="tms-dg-right"><strong>{formatCents(row.cents)}</strong></td>
                  <td>
                    <button type="button" className="tms-link whitespace-nowrap" aria-label={`${row.status === 'NEEDED' || row.status === 'CHOOSE' ? 'Add pay-to' : 'Fix payment info'} for ${row.carrierName}`} onClick={() => onAdd(row)}>
                      {row.status === 'NEEDED' ? 'Add pay-to' : row.status === 'CHOOSE' ? 'Choose pay-to' : 'Fix payment info'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </TmsDialog>
  )
}
