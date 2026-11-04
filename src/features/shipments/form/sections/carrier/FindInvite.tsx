/**
 * "Find & invite" (AH-plan §4.9, F14): an unvetted carrier gets a MyCarrierPackets setup
 * packet from here. Today's backend is `sendCarrierSetupPacket`; the Step AD lookup can
 * replace this one component without touching the section.
 */
import { useState } from 'react'
import { TmsButton, TmsInput } from '@/features/tms/kit'

export function FindInvite({ carrierId, defaultEmail, disabled, send }: {
  carrierId: string
  defaultEmail: string
  disabled: boolean
  send: (carrierId: string, email: string) => Promise<void>
}) {
  const [email, setEmail] = useState(defaultEmail)
  const [working, setWorking] = useState(false)
  const [sent, setSent] = useState(false)
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  const run = async () => {
    setWorking(true)
    try {
      await send(carrierId, email.trim())
      setSent(true)
    } catch {
      /* the action already reported the server's message */
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="carrier-find-invite">
      <TmsInput
        aria-label="Setup packet e-mail"
        type="email"
        value={email}
        placeholder="Carrier e-mail"
        onChange={(e) => { setEmail(e.target.value); setSent(false) }}
      />
      <TmsButton size="sm" data-testid="carrier-send-setup-packet" disabled={disabled || working || !valid} onClick={run}>
        {working ? 'Sending…' : sent ? 'Setup packet sent' : 'Send setup packet'}
      </TmsButton>
    </div>
  )
}
