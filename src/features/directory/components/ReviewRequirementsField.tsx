import {
  REVIEW_REQUIREMENTS,
  REVIEW_REQUIREMENT_LABELS,
  normalizeReviewRequirements,
  resolveReviewRequirements,
  type ReviewRequirement,
} from '@/lib/reviewRequirements'

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
      {REVIEW_REQUIREMENTS.map((key) => (
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
      </p>
    </fieldset>
  )
}
