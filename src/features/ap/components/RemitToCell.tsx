/** The Remit to cell: the e-mail a payee's remittance goes to (or a link to add one), with the remit address under it when one is on file. */
export function RemitToCell({ email, label, onAdd, address }: { email: string; label: string; onAdd: () => void; address?: string }) {
  if (email) {
    return (
      <span title={address ? `Remittance advice goes here when this payee is paid. Remit address: ${address}` : 'Remittance advice goes here when this payee is paid'}>
        {email}
        {address ? <span className="tms-muted block" style={{ fontSize: 11 }} data-testid="remit-address">{address}</span> : null}
      </span>
    )
  }
  return (
    <span>
      <button
        type="button"
        className="tms-link whitespace-nowrap"
        aria-label={`Add remit e-mail for ${label}`}
        onClick={(event) => { event.stopPropagation(); onAdd() }}
      >
        Add remit e-mail
      </button>
      {address ? <span className="tms-muted block" style={{ fontSize: 11 }} data-testid="remit-address">{address}</span> : null}
    </span>
  )
}
