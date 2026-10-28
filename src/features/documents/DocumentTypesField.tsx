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
import { Label } from '@/components/ui/label'
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
      <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {options.map((type) => (
          <label key={type} className="flex items-center gap-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
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
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {unrecognised.map((entry) => (
            <span
              key={entry}
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
            >
              {entry}
              <span className="text-[10px] uppercase tracking-wider opacity-70">not recognised</span>
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                disabled={disabled}
                onClick={() => onChange([...types, ...unrecognised.filter((u) => u !== entry)])}
                className="opacity-70 hover:opacity-100"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <p className="w-full text-xs text-muted-foreground">
            Kept from before these lists had a vocabulary. They are shown to whoever works the
            shipment but cannot gate anything — pick the matching type above, then remove the chip.
          </p>
        </div>
      )}

      {help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
