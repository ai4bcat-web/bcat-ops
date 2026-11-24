/**
 * One pay-to's profile: its name, other spellings, remit address, remit e-mail and payment method, with the carriers
 * paid to it. Saved once and read by every carrier paid to that name, by the Pay to column, by the group payment match
 * and by the remittance e-mail. Bank numbers are not kept here: carriers' own methods hold those, and this dialog only
 * shows whether they are on file.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { graphqlErrorText, setCarrierPayTo, setPayToProfile } from '@/lib/apiClient'
import { isRemitEmail, linkedCarriers, MAX_PAY_TO_ALIASES, PAY_TO_METHODS, type FactorRemitMap, type PayeeSummary } from '@/lib/factorRemit'
import type { RemitMethod } from './remitDirectory'

const SELECT_STYLE = {
  height: 32, padding: '0 8px', background: 'var(--tms-field)', border: '1px solid var(--tms-input-border)',
  borderRadius: 'var(--tms-radius-sm)', color: 'var(--tms-text)', fontSize: 13, width: '100%',
} as const

export function PayToProfileDialog({ payee, carriers, methods, map, payees, canEdit, open, onOpenChange, onSaved }: {
  payee: PayeeSummary
  carriers: ReadonlyArray<{ id: string; name: string }>
  methods: readonly RemitMethod[]
  map: FactorRemitMap
  /** Every pay-to, so a carrier can be moved to any of them. */
  payees: readonly PayeeSummary[]
  canEdit: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const profile = payee.profile
  const [name, setName] = useState(profile?.name ?? payee.name)
  const [email, setEmail] = useState(payee.source === 'SET' ? payee.email : '')
  const [address, setAddress] = useState(profile?.remitAddress ?? '')
  const [method, setMethod] = useState(profile?.paymentMethod ?? '')
  const [aliases, setAliases] = useState<string[]>(profile?.aliases ?? [])
  const [newAlias, setNewAlias] = useState('')
  const [moveTo, setMoveTo] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linked = useMemo(() => linkedCarriers(payee.key, carriers, methods, map), [payee.key, carriers, methods, map])
  // Bank status is read off the linked carriers' own methods: on file or missing, and the last four. Never the numbers.
  const bank = useMemo(() => {
    const ids = new Set(linked.map((c) => c.id))
    const mine = methods.filter((m) => ids.has(m.carrierId) && m.status !== 'INACTIVE')
    const onFile = new Set(mine.filter((m) => m.bankDetailsOnFileAt).map((m) => m.carrierId))
    const last4 = [...new Set(mine.map((m) => (m.accountLast4 ?? '').trim()).filter(Boolean))]
    return { onFile: onFile.size, total: ids.size, last4 }
  }, [linked, methods])

  const emailOk = email.trim() === '' || isRemitEmail(email.trim())
  const nameOk = name.trim() !== ''

  function addAlias() {
    const value = newAlias.trim()
    if (!value || aliases.some((a) => a.toLowerCase() === value.toLowerCase()) || aliases.length >= MAX_PAY_TO_ALIASES) return
    setAliases([...aliases, value])
    setNewAlias('')
  }

  async function save() {
    if (!emailOk || !nameOk || saving) return
    setSaving(true)
    setError(null)
    try {
      await setPayToProfile({
        payeeName: payee.name,
        name: name.trim(),
        email: email.trim(),
        aliases,
        remitAddress: address.trim(),
        paymentMethod: method,
      })
      toast.success(`${name.trim()} saved. Every carrier paid to it uses this profile.`)
      onSaved()
    } catch (err) {
      setError(graphqlErrorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function move(carrierId: string) {
    const target = moveTo[carrierId]
    if (!target || saving) return
    setSaving(true)
    setError(null)
    try {
      await setCarrierPayTo({ carrierId, payToName: target })
      toast.success('Carrier moved. Its bank details were not changed.')
      onSaved()
    } catch (err) {
      setError(graphqlErrorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Pay to — ${payee.name}`}
      footer={(
        <>
          <TmsButton variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>{canEdit ? 'Cancel' : 'Close'}</TmsButton>
          {canEdit && <TmsButton variant="primary" disabled={saving || !emailOk || !nameOk} onClick={() => void save()}>Save profile</TmsButton>}
        </>
      )}
    >
      <p className="tms-muted mb-2">
        One profile for everyone paid to this name. The remit e-mail and address here win over any copy on a carrier, so carriers paid through the same pay-to cannot disagree.
      </p>

      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <TmsField label="Name">
          <TmsInput aria-label="Pay to name" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
        </TmsField>
        <TmsField label="Payment method">
          <select aria-label="Payment method" style={SELECT_STYLE} value={method} disabled={!canEdit} onChange={(e) => setMethod(e.target.value)}>
            <option value="">Not set (each carrier's own)</option>
            {PAY_TO_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </TmsField>
        <TmsField label="Remit e-mail">
          <TmsInput aria-label="Remit e-mail" type="email" value={email} disabled={!canEdit} placeholder="ap@company.com" onChange={(e) => setEmail(e.target.value)} />
        </TmsField>
        <TmsField label="Remit address">
          <TmsInput aria-label="Remit address" value={address} disabled={!canEdit} placeholder="Street, city, state ZIP" onChange={(e) => setAddress(e.target.value)} />
        </TmsField>
      </div>
      {!emailOk && <p className="mt-1 text-xs" style={{ color: 'var(--tms-badge-red)' }}>Enter one valid e-mail address.</p>}

      <div className="mt-3">
        <div className="text-xs font-semibold mb-1">Other spellings</div>
        <p className="tms-muted text-xs mb-1">A carrier or bill that uses one of these is paid to this profile. Nothing on the carrier changes.</p>
        <div className="flex flex-wrap gap-1 mb-1">
          {aliases.length === 0 && <span className="tms-muted text-xs">None</span>}
          {aliases.map((alias) => (
            <span key={alias} className="inline-flex items-center gap-1">
              <TmsBadge tone="gray">{alias}</TmsBadge>
              {canEdit && <button type="button" className="tms-link text-xs" aria-label={`Remove spelling ${alias}`} onClick={() => setAliases(aliases.filter((a) => a !== alias))}>Remove</button>}
            </span>
          ))}
        </div>
        {canEdit && (
          <div className="inline-flex flex-wrap items-center gap-1">
            <TmsInput
              aria-label="Add another spelling"
              value={newAlias}
              placeholder="Another spelling of this name"
              style={{ minWidth: 260 }}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addAlias() }}
            />
            <TmsButton size="sm" variant="ghost" disabled={!newAlias.trim()} onClick={addAlias}>Add spelling</TmsButton>
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="text-xs font-semibold mb-1">Bank details</div>
        {bank.total === 0 ? (
          <span className="tms-muted text-xs">No carriers are paid to this name yet.</span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2 text-sm">
            <TmsBadge tone={bank.onFile === bank.total ? 'green' : bank.onFile === 0 ? 'red' : 'orange'}>
              {bank.onFile === bank.total ? 'Complete' : bank.onFile === 0 ? 'Missing' : `${bank.onFile} of ${bank.total} on file`}
            </TmsBadge>
            {bank.last4.length > 0 && <span className="tms-muted text-xs">account ending {bank.last4.join(', ')}</span>}
            <span className="tms-muted text-xs">Numbers are entered on the carrier's payment info, never here.</span>
          </span>
        )}
      </div>

      <div className="mt-3">
        <div className="text-xs font-semibold mb-1">Linked carriers ({linked.length})</div>
        {linked.length === 0 ? (
          <span className="tms-muted text-xs">No carriers are paid to this name.</span>
        ) : (
          <div className="flex flex-col gap-1" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {linked.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span style={{ minWidth: 200 }}>{c.name}{c.via === 'DIRECT' && <span className="tms-muted"> · direct</span>}{c.via === 'FACTOR' && c.typedName.toLowerCase() !== payee.name.toLowerCase() && <span className="tms-muted"> · typed “{c.typedName}”</span>}</span>
                {canEdit && (
                  <>
                    <select
                      aria-label={`Move ${c.name} to another pay to`}
                      style={{ ...SELECT_STYLE, width: 220 }}
                      value={moveTo[c.id] ?? ''}
                      onChange={(e) => setMoveTo({ ...moveTo, [c.id]: e.target.value })}
                    >
                      <option value="">Move to…</option>
                      {payees.filter((p) => p.key !== payee.key).map((p) => <option key={p.key} value={p.name}>{p.name}</option>)}
                      {c.via === 'FACTOR' && <option value={c.name}>{c.name} (direct, paid as itself)</option>}
                    </select>
                    <TmsButton size="sm" variant="ghost" disabled={!moveTo[c.id] || saving} onClick={() => void move(c.id)}>Move</TmsButton>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
