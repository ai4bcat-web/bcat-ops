/**
 * Pick document types from the one vocabulary the gate understands.
 *
 * Before step E these lists were free text — "POD, ratecon, signed BOL" typed into a
 * box — so nothing could be gated on them. The vocabulary exists now, but the old text
 * is still on real customer records, and deleting an instruction nobody mapped would be
 * the system quietly overruling the person who wrote it. So anything
 * `normalizeRequiredDocTypes` cannot place is kept verbatim, shown as a chip marked
 * "not recognised", and removable only by a person who decides it is obsolete.
 *
 * One component for the customer profile, the org defaults and the carrier-upload
 * setting: three pickers over the same vocabulary would drift until they disagreed
 * about what a type is called.
 */
import { useMemo } from 'react'
import { X } from 'lucide-react'
import { DOCUMENT_TYPE_LABELS, SHIPMENT_DOCUMENT_TYPES, normalizeRequiredDocTypes } from '@/lib/shipmentDocuments'
import type { ShipmentDocumentType } from '@/types/tms'

export function DocumentTypesField({
  label, value, onChange, disabled, help, options = SHIPMENT_DOCUMENT_TYPES,
}: {
  label: string
  /** Raw stored strings — typed values and whatever predates the vocabulary. */
  value: readonly string[] | null | undefined
  onChange: (next: string[]) => void
  disabled?: boolean
  help?: string
  /** Narrowed where only part of the vocabulary applies, e.g. carrier uploads. */
  options?: readonly ShipmentDocumentType[]
}) {
  const { types, unrecognised } = useMemo(() => normalizeRequiredDocTypes(value), [value])

  /*
   * Saving writes the canonical types first and the unrecognised strings after, so an
   * alias somebody typed ("Rate confirmation") is rewritten to its type the first time
   * the record is saved, while the strings nobody could map survive untouched.
   */
  const toggle = (type: ShipmentDocumentType, on: boolean) => {
    const next = on ? [...types, type] : types.filter((t) => t !== type)
    onChange([...next, ...unrecognised])
  }

  return (
    <div>
      <div className="tms-field-label">{label}</div>
      <div className="tms-grid tms-grid-3" style={{ marginTop: 4, gap: 6 }}>
        {options.map((type) => (
          <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              aria-label={DOCUMENT_TYPE_LABELS[type]}
              checked={types.includes(type)}
              disabled={disabled}
              onChange={(e) => toggle(type, e.target.checked)}
            />
            {DOCUMENT_TYPE_LABELS[type]}
          </label>
        ))}
      </div>

      {unrecognised.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          {unrecognised.map((entry) => (
            <span key={entry} className="tms-badge tms-badge-orange" style={{ gap: 4 }}>
              {entry}
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.75 }}>not recognised</span>
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                disabled={disabled}
                onClick={() => onChange([...types, ...unrecognised.filter((u) => u !== entry)])}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'inline-flex' }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <p className="tms-muted" style={{ width: '100%', fontSize: 12 }}>
            Kept from before these lists had a vocabulary. They are shown to whoever works the
            shipment but cannot gate anything — pick the matching type above, then remove the chip.
          </p>
        </div>
      )}

      {help && <p className="tms-muted" style={{ marginTop: 4, fontSize: 12 }}>{help}</p>}
    </div>
  )
}
