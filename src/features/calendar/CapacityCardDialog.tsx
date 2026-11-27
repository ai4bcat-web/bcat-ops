import { useId, useState } from 'react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { CityInput } from '@/features/tms/kit/CityInput'
import { EQUIPMENT_SUGGESTIONS } from '@/features/shipments/form/constants'
import { parseCapacityFields, CAPACITY_MAX_SPAN_DAYS, type CapacityCard } from '@/lib/capacityBoard'
import type { Driver } from '@/types'

const PHONE_KEY = 'bcat.capacity.lastPhone'

function lastPhone(): string {
  try { return window.localStorage.getItem(PHONE_KEY) ?? '' } catch { return '' }
}

/** The card's fields as the form holds them: everything text, so a half-typed number never fights the person. */
interface FormValues {
  availableFrom: string
  availableTo: string
  origin: string
  destination: string
  equipment: string
  loadType: string
  lengthFt: string
  weightLbs: string
  referenceId: string
  minRatePerMile: string
  contactPhone: string
  comments: string
  driverId: string
}

function initialValues(card: CapacityCard | null, day: string): FormValues {
  if (card) {
    return {
      availableFrom: card.availableFrom, availableTo: card.availableTo,
      origin: card.origin, destination: card.destination, equipment: card.equipment, loadType: card.loadType,
      lengthFt: String(card.lengthFt), weightLbs: card.weightLbs != null ? String(card.weightLbs) : '',
      referenceId: card.referenceId ?? '', minRatePerMile: card.minRatePerMileCents != null ? (card.minRatePerMileCents / 100).toFixed(2) : '',
      contactPhone: card.contactPhone ?? '', comments: card.comments ?? '', driverId: card.driverId ?? '',
    }
  }
  return {
    availableFrom: day, availableTo: day, origin: '', destination: '', equipment: '', loadType: 'FULL', lengthFt: '',
    weightLbs: '', referenceId: '', minRatePerMile: '', contactPhone: lastPhone(), comments: '', driverId: '',
  }
}

const inputStyle: React.CSSProperties = {
  height: 34, padding: '0 10px', borderRadius: 7, width: '100%', boxSizing: 'border-box',
  border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 13, fontFamily: 'inherit',
}
const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: 4, fontSize: 11, fontWeight: 600, color: 'var(--tms-text-2)', textTransform: 'uppercase', letterSpacing: '0.05em',
}

/**
 * New or edit form for a Capacity card, laid out like DAT's Post Truck form: when, where from, where to (empty = anywhere),
 * what equipment, how long, and the rate the office wants. Origin, equipment and length are required.
 */
export function CapacityCardDialog({ card, day, drivers, onSave, onClose }: {
  /** The card being edited, or null for a new one. */
  card: CapacityCard | null
  /** The day a new card starts on (the column's "+"). */
  day: string
  drivers: Driver[]
  onSave: (fields: Record<string, unknown>, id?: string) => Promise<CapacityCard | null>
  onClose: () => void
}) {
  const uid = useId()
  const [v, setV] = useState<FormValues>(() => initialValues(card, day))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (key: keyof FormValues) => (value: string) => setV((cur) => ({ ...cur, [key]: value }))
  const field = (key: keyof FormValues) => ({ value: v[key], onChange: (e: { target: { value: string } }) => set(key)(e.target.value) })
  const id = (name: string) => `${uid}-${name}`
  const activeDrivers = drivers.filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name))

  async function submit() {
    setError(null)
    // The same check the server runs, so a mistake is named before anything is sent.
    try {
      const fields = parseCapacityFields({ ...v, availableTo: v.availableTo || v.availableFrom })
      setSaving(true)
      const saved = await onSave({ ...v, availableTo: v.availableTo || v.availableFrom, lengthFt: fields.lengthFt }, card?.id)
      if (saved) {
        try { if (v.contactPhone) window.localStorage.setItem(PHONE_KEY, v.contactPhone) } catch { /* private mode */ }
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check the form')
    } finally {
      setSaving(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={card ? 'Edit capacity card' : 'New capacity card'}
      description="A truck we need to fill. Cards show on every day in the range."
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => void submit()} disabled={saving}>{saving ? 'Saving…' : card ? 'Save changes' : 'Add card'}</TmsButton>
        </>
      )}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); void submit() }}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}
      >
        <div>
          <label style={labelStyle} htmlFor={id('from')}>Available from *</label>
          <input id={id('from')} type="date" style={inputStyle} {...field('availableFrom')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('to')}>Available through</label>
          <input id={id('to')} type="date" min={v.availableFrom} style={inputStyle} {...field('availableTo')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('origin')}>Origin (city, ST or ZIP) *</label>
          <CityInput id={id('origin')} value={v.origin} onChange={set('origin')} onPick={(o) => set('origin')(`${o.city}, ${o.state}`)} placeholder="Chicago, IL" />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('dest')}>Destination (city, ST or zone)</label>
          <CityInput id={id('dest')} value={v.destination} onChange={set('destination')} onPick={(o) => set('destination')(`${o.city}, ${o.state}`)} placeholder="Leave empty to go anywhere" />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('equip')}>Equipment *</label>
          <input id={id('equip')} list={id('equip-list')} style={inputStyle} placeholder="Dry Van" {...field('equipment')} />
          <datalist id={id('equip-list')}>{EQUIPMENT_SUGGESTIONS.map((e) => <option key={e} value={e} />)}</datalist>
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('type')}>Load type</label>
          <select id={id('type')} style={inputStyle} {...field('loadType')}>
            <option value="FULL">Full</option>
            <option value="PARTIAL">Partial</option>
          </select>
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('len')}>Length (ft) *</label>
          <input id={id('len')} inputMode="numeric" style={inputStyle} placeholder="53" {...field('lengthFt')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('wt')}>Weight (lbs)</label>
          <input id={id('wt')} inputMode="numeric" style={inputStyle} placeholder="45,000" {...field('weightLbs')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('rate')}>Min. rate / mile ($)</label>
          <input id={id('rate')} inputMode="decimal" style={inputStyle} placeholder="2.50" {...field('minRatePerMile')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('ref')}>Reference ID</label>
          <input id={id('ref')} style={inputStyle} {...field('referenceId')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('phone')}>Contact phone</label>
          <input id={id('phone')} inputMode="tel" style={inputStyle} placeholder="(847) 555-0100" {...field('contactPhone')} />
        </div>
        <div>
          <label style={labelStyle} htmlFor={id('driver')}>Driver (optional)</label>
          <select id={id('driver')} style={inputStyle} {...field('driverId')}>
            <option value="">No driver linked</option>
            {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle} htmlFor={id('comments')}>Comments</label>
          <textarea id={id('comments')} rows={2} style={{ ...inputStyle, height: 'auto', padding: 8, resize: 'vertical' }} {...field('comments')} />
        </div>
        <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12, color: 'var(--tms-muted)' }}>
          A card can be offered for up to {CAPACITY_MAX_SPAN_DAYS} days.
        </p>
        {error && <p role="alert" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12.5, color: 'var(--tms-badge-red)' }}>{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </TmsDialog>
  )
}
