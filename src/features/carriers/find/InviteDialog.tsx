/**
 * "Send packet invitation": a checklist of every address MyCarrierPackets returns for the carrier, all
 * ticked by default, plus an "add another address" field. Typed addresses are additive: the default
 * is always MCP's own list. Each address is validated here and again on the server.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { validateInviteEmail } from '@/lib/integrations/mcpReview'
import { chosenRecipients } from '@/features/carriers/lookup/lookupModel'

export function InviteDialog({ carrierName, candidates, stub, busy, onClose, onSend }: {
  carrierName: string
  /** The addresses MyCarrierPackets returned. */
  candidates: ReadonlyArray<{ address: string; label: string }>
  stub: boolean
  busy: boolean
  onClose: () => void
  onSend: (emails: string[]) => void
}) {
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [typedList, setTypedList] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>()

  const known = new Set(candidates.map((c) => c.address))
  const ticked = [...candidates.map((c) => c.address), ...typedList].filter((a) => !unticked.has(a))
  const recipients = chosenRecipients(ticked, [])

  const toggle = (address: string) => setUnticked((prev) => {
    const next = new Set(prev)
    if (next.has(address)) next.delete(address)
    else next.add(address)
    return next
  })

  const add = () => {
    const check = validateInviteEmail(draft, [])
    if (!check.ok) { setError(check.error); return }
    if (!known.has(check.email) && !typedList.includes(check.email)) setTypedList((l) => [...l, check.email])
    setUnticked((prev) => { const next = new Set(prev); next.delete(check.email); return next })
    setDraft('')
    setError(undefined)
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Send packet invitation"
      description={`MyCarrierPackets e-mails ${carrierName} a link to its packet, to every address ticked below.${stub ? ' Stub, no MCP call: nothing will actually be sent.' : ''}`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            data-testid="mcp-invite-send"
            disabled={busy || recipients.length === 0}
            title={recipients.length === 0 ? 'Tick at least one address, or add one' : undefined}
            onClick={() => onSend(recipients)}
          >
            {busy ? 'Sending…' : `Send invitation${recipients.length > 1 ? ` to ${recipients.length} addresses` : ''}`}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="mcp-invite-recipients">
          {candidates.map((c) => (
            <li key={c.address}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!unticked.has(c.address)} onChange={() => toggle(c.address)} aria-label={c.address} />
                <span>{c.address}</span>
                <span className="tms-muted" style={{ fontSize: 12 }}>{c.label}</span>
              </label>
            </li>
          ))}
          {typedList.map((a) => (
            <li key={a}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!unticked.has(a)} onChange={() => toggle(a)} aria-label={a} />
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
