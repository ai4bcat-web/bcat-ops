/**
 * Send a driver their sign-in invite, from the settlement page.
 *
 * The onboarding machinery already exists — `createOnboardingInvite` mints a
 * token, `buildPortalUrl` turns it into a link, and the emailer sends it. The
 * only thing missing was a way to do that from where an owner-operator's pay
 * is actually being worked, instead of navigating to the Files page.
 *
 * Issuing an invite is idempotent from the user's side: pressing it again mints
 * a fresh token and supersedes the old one, which is the behaviour someone
 * wants when a driver says the link expired.
 */
import { useState } from 'react'
import { Loader2, Send, Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  createOnboardingInvite,
  generateInviteToken,
  inviteExpiry,
  buildPortalUrl,
} from '@/lib/complianceClient'
import type { Driver } from '@/types'

interface Props {
  driver: Pick<Driver, 'id' | 'name' | 'email' | 'driverType'>
  email: string
}

export function SendDriverInvite({ driver, email }: Props) {
  const [sending, setSending] = useState(false)
  const [sentAt, setSentAt] = useState<string | null>(null)

  async function send() {
    setSending(true)
    try {
      const token = generateInviteToken()
      await createOnboardingInvite({
        driverId: driver.id,
        email: email.trim(),
        driverType: driver.driverType ?? 'OWNER_OPERATOR',
        token,
        status: 'SENT',
        expiresAt: inviteExpiry(),
        sentAt: new Date().toISOString(),
      })
      // The link is what the email carries; surface it so staff can paste it
      // into a text message when a driver says the email never arrived.
      const url = buildPortalUrl(token)
      await navigator.clipboard?.writeText(url).catch(() => undefined)
      setSentAt(new Date().toISOString())
      toast.success(`Invite sent to ${email}`, {
        description: 'Link copied to your clipboard as a backup.',
      })
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
      title={`Email ${driver.name} a link to set up their driver sign-in`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4,
        height: 26, padding: '0 9px', borderRadius: 6, fontSize: 12, fontWeight: 600,
        border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
        color: sentAt ? '#15803d' : 'var(--ds-t1)', cursor: sending ? 'default' : 'pointer',
      }}
    >
      {sending ? (
        <Loader2 size={12} className="animate-spin" />
      ) : sentAt ? (
        <Check size={12} />
      ) : (
        <Send size={12} />
      )}
      {sentAt ? 'Invite sent' : 'Send sign-in invite'}
    </button>
  )
}
