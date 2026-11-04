import { useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsField, TmsInput } from '@/features/tms/kit'
import type { CrmAccountView } from '@/lib/crm/types'

const ORIGIN_LABEL = { CRM: 'CRM', CUSTOMER_JSON: 'Account', BOTH: 'Account + CRM' } as const

interface ContactsUnionProps {
  view: CrmAccountView | null
  onAdd: (input: { email: string; name?: string; title?: string; phone?: string }) => Promise<unknown>
}

/**
 * Every person on the account: the operational contact list and the people met in mail,
 * de-duplicated by e-mail on the server, each with a source chip. Adds go through
 * `CRM_UPSERT_CONTACT`; the operational list (billing, notifications) is edited below.
 */
export function ContactsUnion({ view, onAdd }: ContactsUnionProps) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  if (!view?.visible) return null

  const add = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { toast.error('Enter a valid e-mail address'); return }
    setBusy(true)
    try {
      await onAdd({ email: email.trim().toLowerCase(), name: name.trim() || undefined })
      setEmail('')
      setName('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add contact')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="crm-contacts-union">
      {view.contacts.length === 0 ? (
        <p className="tms-muted" style={{ fontSize: 13 }}>No people on this account yet.</p>
      ) : view.contacts.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }} data-testid={`crm-contact-${c.id}`}>
          <span style={{ fontWeight: 600 }}>{c.name || c.id}</span>
          {c.name && <span className="tms-muted">{c.id}</span>}
          <TmsBadge>{ORIGIN_LABEL[c.origin]}</TmsBadge>
          {c.source === 'SPOT_REQUEST' && <TmsBadge tone="blue">From e-mail</TmsBadge>}
        </div>
      ))}
      <div className="tms-grid tms-grid-3" style={{ alignItems: 'end' }}>
        <TmsField label="Add contact — e-mail"><TmsInput value={email} onChange={(e) => setEmail(e.target.value)} data-testid="crm-contact-email" /></TmsField>
        <TmsField label="Name"><TmsInput value={name} onChange={(e) => setName(e.target.value)} data-testid="crm-contact-name" /></TmsField>
        <TmsButton onClick={() => void add()} disabled={busy || !email.trim()} data-testid="crm-contact-add">Add contact</TmsButton>
      </div>
    </div>
  )
}
