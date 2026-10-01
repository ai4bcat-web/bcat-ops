/**
 * Send a driver their driver-app sign-in invite, from the settlement page.
 *
 * Two things happen, in this order:
 *   1. An invite row is recorded, so there is a trail of who was invited when.
 *   2. An email goes out with a link to set a password, their email prefilled.
 *
 * The link lands on the signup page, NOT the hiring portal at /onboard/:token —
 * that portal collects employment paperwork, which an already-hired owner-operator
 * has long since done. What they are missing is a sign-in. The PreSignUp roster gate
 * is what decides who may create an account, so the link itself needs no secret.
 *
 * Once they set a password, Cognito's PostConfirmation trigger sends the second
 * email with the home-screen install link. Nothing here has to arrange that.
 *
 * Pressing again is safe: it records a fresh invite and re-sends, which is exactly
 * what someone wants when a driver says the email never arrived.
 */
import { useState } from 'react'
import { Loader2, Send, Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  createOnboardingInvite,
  generateInviteToken,
  inviteExpiry,
  sendDriverAppInvite,
} from '@/lib/complianceClient'
import type { Driver } from '@/types'

interface Props {
  driver: Pick<Driver, 'id' | 'name' | 'email' | 'driverType'>
  email: string
}

/** Where the driver goes to set a password. Email prefilled so it cannot be mistyped. */
function signupUrl(email: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/driver/signup?email=${encodeURIComponent(email)}`
}

export function SendDriverInvite({ driver, email }: Props) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  async function send() {
    const to = email.trim().toLowerCase()
    if (!to) {
      toast.error(`${driver.name} has no email address on file`)
      return
    }

    setSending(true)
    try {
      const invite = await createOnboardingInvite({
        driverId: driver.id,
        email: to,
        driverType: driver.driverType ?? 'OWNER_OPERATOR',
        token: generateInviteToken(),
        status: 'SENT',
        expiresAt: inviteExpiry(),
        sentAt: new Date().toISOString(),
      })

      const delivered = await sendDriverAppInvite(invite.id)

      // The link is a useful fallback when a driver says no email arrived, so put it
      // on the clipboard either way — staff can paste it into a text message.
      await navigator.clipboard?.writeText(signupUrl(to)).catch(() => undefined)

      if (delivered) {
        setSent(true)
        toast.success(`Sign-in invite emailed to ${to}`, {
          description: 'Link copied to your clipboard as a backup.',
        })
      } else {
        // Recorded but not delivered — say so rather than showing a green tick.
        toast.warning('Invite recorded, but the email did not send', {
          description: 'The sign-up link is on your clipboard — send it to them directly.',
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the invite')
    } finally {
      setSending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={sending}
      title={`Email ${driver.name} a link to set up their driver-app sign-in`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4,
        height: 26, padding: '0 9px', borderRadius: 6, fontSize: 12, fontWeight: 600,
        border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
        color: sent ? '#15803d' : 'var(--ds-t1)', cursor: sending ? 'default' : 'pointer',
      }}
    >
      {sending ? (
        <Loader2 size={12} className="animate-spin" />
      ) : sent ? (
        <Check size={12} />
      ) : (
        <Send size={12} />
      )}
      {sent ? 'Invite sent' : 'Send sign-in invite'}
    </button>
  )
}
