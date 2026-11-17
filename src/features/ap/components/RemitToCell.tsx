/** The Remit to cell: the e-mail a payee's remittance goes to, or a link to add one. */
export function RemitToCell({ email, label, onAdd }: { email: string; label: string; onAdd: () => void }) {
  if (email) return <span title="Remittance advice goes here when this payee is paid">{email}</span>
  return (
    <button
      type="button"
      className="tms-link whitespace-nowrap"
      aria-label={`Add remit e-mail for ${label}`}
      onClick={(event) => { event.stopPropagation(); onAdd() }}
    >
      Add remit e-mail
    </button>
  )
}
