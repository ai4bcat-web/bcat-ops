import {
  REVIEW_REQUIREMENTS,
  REVIEW_REQUIREMENT_LABELS,
  normalizeReviewRequirements,
  resolveReviewRequirements,
  type ReviewRequirement,
} from '@/lib/reviewRequirements'

const DOC_KEYS: { key: ReviewRequirement; label: string }[] = [
  { key: 'podReceived', label: 'POD' },
  { key: 'rateConReceived', label: 'RC' },
  { key: 'apEmail', label: 'AP e-mail' },
]

/**
 * What a shipment must show before it can be pushed to Load Review (and what the Load Review
 * gate re-checks). One field serves both editors: the customer's profile passes
 * `inheritFrom` and gets a "Use the organization default" switch (value null); the org
 * default editor does not, and always holds a list.
 */
export function ReviewRequirementsField({ value, onChange, inheritFrom, disabled }: {
  value: readonly string[] | null | undefined
  onChange: (next: ReviewRequirement[] | null) => void
  /** The org default list, when this is a per-customer override. Omit for the org editor itself. */
  inheritFrom?: readonly string[] | null
  disabled?: boolean
}) {
  const inherits = inheritFrom !== undefined && value == null
  const effective = resolveReviewRequirements(value, inheritFrom)
  return (
    <fieldset style={{ display: 'grid', gap: 6, border: 0, padding: 0, margin: 0 }} aria-label="Load Review requirements">
      {inheritFrom !== undefined && (
        <label style={{ display: 'flex', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={inherits}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? null : resolveReviewRequirements(null, inheritFrom))}
          />
          Use the organization default
        </label>
      )}
      {/* Ryne 2026-11-15/16: what this customer needs before it can be invoiced (AUTO SHIPPER needs no POD, RC or AP e-mail). */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }} role="group" aria-label="Required to invoice">
        <span>Required to invoice:</span>
        {DOC_KEYS.map(({ key, label }) => (
          <label key={key} style={{ display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={effective.includes(key)}
              disabled={disabled || inherits}
              onChange={(e) => onChange(normalizeReviewRequirements(e.target.checked ? [...effective, key] : effective.filter((k) => k !== key)))}
            />
            {label}
          </label>
        ))}
      </div>
      {REVIEW_REQUIREMENTS.filter((key) => !DOC_KEYS.some((d) => d.key === key)).map((key) => (
        <label key={key} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={effective.includes(key)}
            disabled={disabled || inherits}
            onChange={(e) =>
              onChange(normalizeReviewRequirements(e.target.checked ? [...effective, key] : effective.filter((k) => k !== key)))
            }
          />
          {REVIEW_REQUIREMENT_LABELS[key]}
        </label>
      ))}
      <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
        A shipment cannot be pushed to Load Review until every ticked item is met. Load Review checks the same list again before release.
        Unticking POD, RC or AP e-mail means this customer's loads can be invoiced without it; a factored customer still needs all
        three (OTR requires the documents, and the remit goes to the AP e-mail).
      </p>
    </fieldset>
  )
}
