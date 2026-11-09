/**
 * "Send packet invitation": pick ONE of the addresses MyCarrierPackets returns for the carrier (nothing is pre-selected), or add
 * another address and pick that. The invitation goes to the chosen address only. Each address is validated here and again on the server.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { validateInviteEmail } from '@/lib/integrations/mcpReview'

export function InviteDialog({ carrierName, candidates, stub, busy, onClose, onSend }: {
  carrierName: string
  /** The addresses MyCarrierPackets returned. */
  candidates: ReadonlyArray<{ address: string; label: string }>
  stub: boolean
  busy: boolean
  onClose: () => void
  onSend: (emails: string[]) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [typedList, setTypedList] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>()

  const known = new Set(candidates.map((c) => c.address))

  const add = () => {
    const check = validateInviteEmail(draft, [])
    if (!check.ok) { setError(check.error); return }
    if (!known.has(check.email) && !typedList.includes(check.email)) setTypedList((l) => [...l, check.email])
    setSelected(check.email)
    setDraft('')
    setError(undefined)
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Send packet invitation"
      description={`MyCarrierPackets e-mails ${carrierName} a link to its packet, to the one address you pick below.${stub ? ' Stub, no MCP call: nothing will actually be sent.' : ''}`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            data-testid="mcp-invite-send"
            disabled={busy || selected == null}
            title={selected == null ? 'Pick the address to send to, or add one' : undefined}
            onClick={() => { if (selected) onSend([selected]) }}
          >
            {busy ? 'Sending…' : selected ? `Send invitation to ${selected}` : 'Send invitation'}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="mcp-invite-recipients" role="radiogroup" aria-label="Send the invitation to">
          {candidates.map((c) => (
            <li key={c.address}>
              <label className="flex items-center gap-2">
                <input type="radio" name="mcp-invite-recipient" checked={selected === c.address} onChange={() => setSelected(c.address)} aria-label={c.address} />
                <span>{c.address}</span>
                <span className="tms-muted" style={{ fontSize: 12 }}>{c.label}</span>
              </label>
            </li>
          ))}
          {typedList.map((a) => (
            <li key={a}>
              <label className="flex items-center gap-2">
                <input type="radio" name="mcp-invite-recipient" checked={selected === a} onChange={() => setSelected(a)} aria-label={a} />
                <span>{a}</span>
                <span className="tms-muted" style={{ fontSize: 12 }}>Added by you</span>
              </label>
            </li>
          ))}
          {candidates.length === 0 && typedList.length === 0 && (
            <li className="tms-muted">MyCarrierPackets returned no e-mail address for this carrier: add one below.</li>
          )}
        </ul>
        <TmsField label="Add another address" error={error}>
          <div className="flex gap-2">
            <TmsInput
              type="email"
              aria-label="Add another address"
              value={draft}
              placeholder="dispatch@carrier.com"
              onChange={(e) => { setDraft(e.target.value); setError(undefined) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            />
            <TmsButton type="button" onClick={add} data-testid="mcp-invite-add">Add</TmsButton>
          </div>
        </TmsField>
      </div>
    </TmsDialog>
  )
}
