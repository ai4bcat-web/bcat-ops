import { useState } from 'react'
import { TmsButton, TmsInput } from '@/features/tms/kit'
import { formatPhone } from '@/lib/utils'
import { useTruckConfigs } from '@/hooks/useTruckConfigs'
import { normalizeTruckPhone } from '@/lib/workPhone'

/** Masks US digits as they are typed: `3125550142` → `(312) 555-0142`. A leading `+` is left alone. */
function maskPhoneInput(raw: string): string {
  if (raw.trim().startsWith('+')) return raw
  let d = raw.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  d = d.slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/**
 * Inline editor for the work phone that rides in one truck (Step AK). Saves E.164 through the
 * shared `useTruckConfigs` cache, so Fleet and the Settings card update together.
 */
export function TruckPhoneEditor({
  truckId,
  unitNumber,
  phone,
  phoneLabel,
  onDone,
}: {
  truckId: string
  unitNumber: string
  phone?: string | null
  phoneLabel?: string | null
  onDone?: () => void
}) {
  const { upsert } = useTruckConfigs()
  const [phoneText, setPhoneText] = useState(phone ? formatPhone(phone) : '')
  const [label, setLabel] = useState(phoneLabel ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const write = async (next: { phone: string | null; phoneLabel: string | null }) => {
    setSaving(true)
    try {
      await upsert({ truckId, unitNumber, ...next })
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the phone')
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    const parsed = normalizeTruckPhone(phoneText)
    if (!parsed.ok) { setError(parsed.error); return }
    setError(null)
    await write({ phone: parsed.value, phoneLabel: label.trim() || null })
  }

  const clear = async () => {
    setError(null)
    setPhoneText('')
    setLabel('')
    await write({ phone: null, phoneLabel: null })
  }

  return (
    <div
      style={{ display: 'grid', gap: 6 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <TmsInput
          aria-label={`Work phone, truck ${unitNumber}`}
          placeholder="(312) 555-0142"
          inputMode="tel"
          value={phoneText}
          onChange={(e) => { setPhoneText(maskPhoneInput(e.target.value)); setError(null) }}
          style={{ width: 150 }}
        />
        <TmsInput
          aria-label={`Phone label, truck ${unitNumber}`}
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: 130 }}
        />
        <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>Save</TmsButton>
        {(phone || phoneLabel) && <TmsButton size="sm" onClick={clear} disabled={saving}>Clear</TmsButton>}
      </div>
      {error && <span className="tms-field-error" role="alert">{error}</span>}
    </div>
  )
}
