/**
 * "Send packet invitation": pick one of the e-mails MyCarrierPackets has approved for the carrier,
 * or type another. The recipient is validated here and again on the server.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { validateInviteEmail } from '@/lib/integrations/mcpReview'

const TYPED = '__typed__'

export function InviteDialog({ carrierName, approved, stub, busy, onClose, onSend }: {
  carrierName: string
  approved: ReadonlyArray<{ email: string; description?: string }>
  stub: boolean
  busy: boolean
  onClose: () => void
  onSend: (email: string) => void
}) {
  const [choice, setChoice] = useState(approved[0]?.email ?? TYPED)
  const [typed, setTyped] = useState('')
  const raw = choice === TYPED ? typed : choice
  const check = validateInviteEmail(raw, approved)
  const [touched, setTouched] = useState(false)

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Send packet invitation"
      description={`MyCarrierPackets e-mails ${carrierName} a link to its packet.${stub ? ' STUB: nothing will actually be sent.' : ''}`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            data-testid="mcp-invite-send"
            disabled={busy}
            onClick={() => {
              setTouched(true)
              if (check.ok) onSend(check.email)
            }}
          >
            {busy ? 'Sending…' : 'Send invitation'}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TmsField label="Send to">
          <TmsSelect aria-label="Send to" value={choice} onChange={(e) => { setChoice(e.target.value); setTouched(false) }}>
            {approved.map((a) => (
              <option key={a.email} value={a.email}>{a.email}{a.description ? ` (${a.description})` : ''} · approved by MCP</option>
            ))}
            <option value={TYPED}>Another address…</option>
          </TmsSelect>
        </TmsField>
        {choice === TYPED && (
          <TmsField label="E-mail address" error={touched && !check.ok ? check.error : undefined}>
            <TmsInput
              type="email"
              aria-label="E-mail address"
              value={typed}
              placeholder="dispatch@carrier.com"
              onChange={(e) => { setTyped(e.target.value); setTouched(false) }}
            />
          </TmsField>
        )}
        {choice === TYPED && check.ok && !check.approved && (
          <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>This address is not on MyCarrierPackets’ approved list for the carrier.</p>
        )}
      </div>
    </TmsDialog>
  )
}
