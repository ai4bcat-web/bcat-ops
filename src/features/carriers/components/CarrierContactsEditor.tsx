/**
 * The carrier's people. Unlike a customer's contacts these are their own rows written
 * through the Lambda, so every line saves on its own — the profile's Save button has
 * nothing to do with them.
 *
 * `Rate con` marks who the rate confirmation is emailed to; `Primary` is the one the
 * Lambda mirrors onto the carrier's dispatcher fields when the contact is a dispatcher.
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { TmsBadge, TmsButton, TmsField, TmsIconButton, TmsInput } from '@/features/tms/kit'
import type { CarrierContactRecord, CarrierContactType } from '@/types/tms'

const CONTACT_TYPES: CarrierContactType[] = [
  'ACCOUNTING', 'AFTER_HOURS', 'CLAIMS', 'DISPATCH', 'DRIVER', 'EMERGENCY', 'MANAGER', 'OWNER',
]

export interface CarrierContactDraft {
  id?: string
  expectedUpdatedAt?: string
  name: string
  types: CarrierContactType[]
  email: string | null
  phone: string | null
  isPrimary: boolean
  rateConRecipient: boolean
}

interface CarrierContactsEditorProps {
  contacts: CarrierContactRecord[]
  onSave: (draft: CarrierContactDraft) => Promise<void>
  onArchive: (contact: CarrierContactRecord) => Promise<void>
  disabled?: boolean
}

export function CarrierContactsEditor({ contacts, onSave, onArchive, disabled }: CarrierContactsEditorProps) {
  const [adding, setAdding] = useState(false)
  const active = contacts.filter((c) => c.active !== false)

  return (
    <div className="flex flex-col gap-3">
      {active.length === 0 && !adding && (
        <p className="tms-muted">No contacts yet. Add the dispatcher you book through.</p>
      )}

      {active.map((contact) => (
        <ContactRow
          key={contact.id}
          contact={contact}
          disabled={disabled}
          onSave={onSave}
          onArchive={() => onArchive(contact)}
        />
      ))}

      {adding && (
        <ContactRow
          contact={null}
          disabled={disabled}
          onSave={async (draft) => { await onSave(draft); setAdding(false) }}
          onCancel={() => setAdding(false)}
        />
      )}

      {!adding && (
        <div>
          <TmsButton size="sm" disabled={disabled} onClick={() => setAdding(true)}>
            <Plus size={14} /> Add contact
          </TmsButton>
        </div>
      )}
    </div>
  )
}

function ContactRow({ contact, disabled, onSave, onArchive, onCancel }: {
  contact: CarrierContactRecord | null
  disabled?: boolean
  onSave: (draft: CarrierContactDraft) => Promise<void>
  onArchive?: () => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(contact?.name ?? '')
  const [types, setTypes] = useState<CarrierContactType[]>([...(contact?.types ?? [])])
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary === true)
  const [rateConRecipient, setRateConRecipient] = useState(contact?.rateConRecipient === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) { setError('Name the contact.'); return }
    if (rateConRecipient && !email.trim()) { setError('A rate-con recipient needs an email.'); return }
    setBusy(true)
    setError(null)
    try {
      await onSave({
        id: contact?.id,
        expectedUpdatedAt: contact?.updatedAt,
        name: name.trim(),
        types,
        email: email.trim() || null,
        phone: phone.trim() || null,
        isPrimary,
        rateConRecipient,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-3" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
      <div className="tms-grid tms-grid-3">
        <TmsField label="Name">
          <TmsInput aria-label="Contact name" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        </TmsField>
        <TmsField label="Email">
          <TmsInput aria-label="Contact email" value={email} disabled={disabled} onChange={(e) => setEmail(e.target.value)} />
        </TmsField>
        <TmsField label="Phone">
          <TmsInput aria-label="Contact phone" value={phone} disabled={disabled} onChange={(e) => setPhone(e.target.value)} />
        </TmsField>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {CONTACT_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              aria-label={t}
              checked={types.includes(t)}
              disabled={disabled}
              onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))}
            />
            {t.replace(/_/g, ' ').toLowerCase()}
          </label>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" aria-label="Primary" checked={isPrimary} disabled={disabled} onChange={(e) => setIsPrimary(e.target.checked)} />
          Primary
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" aria-label="Rate con recipient" checked={rateConRecipient} disabled={disabled} onChange={(e) => setRateConRecipient(e.target.checked)} />
          Rate con recipient
        </label>
        {contact?.isPrimary && <TmsBadge tone="gray">primary on file</TmsBadge>}

        <div className="ml-auto flex items-center gap-2">
          {onCancel && <TmsButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</TmsButton>}
          <TmsButton variant="primary" size="sm" onClick={save} disabled={busy || disabled}>{busy ? 'Saving…' : 'Save'}</TmsButton>
          {onArchive && (
            <TmsIconButton
              aria-label={`Archive ${contact?.name ?? 'contact'}`}
              disabled={busy || disabled}
              onClick={() => { setBusy(true); onArchive().finally(() => setBusy(false)) }}
            >
              <Trash2 size={14} />
            </TmsIconButton>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </div>
  )
}
