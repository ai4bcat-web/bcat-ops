/**
 * Prop types for the section components the AR cards compose (Roles, Rates, Carrier). Authors
 * import them from here, never each other.
 *
 * Every section also receives `form`, a *stable* handle for the few things that cross sections
 * (reading the other values when a button is clicked, jumping to a field). It never changes
 * identity, so it does not defeat `React.memo`; render from `value`/`ctx`, call `form.*` from
 * event handlers only.
 */
import type { ShipmentFormValues } from './model'
import type { SectionKey, SectionProps } from './sectionProps'

export interface FormApi {
  /** The latest values (for event handlers: "Calculate totals", "Suggest miles", Cover…). Not reactive. */
  getValues(): ShipmentFormValues
  /** Functional update of the whole values object (cross-section writes only). */
  update(fn: (prev: ShipmentFormValues) => ShipmentFormValues): void
  /** Expand the section and focus the control whose `data-testid` is `fieldKey`. */
  focusField(fieldKey: string, section?: SectionKey): void
}

export type WithForm<P> = P & { form: FormApi }

/** Sections whose `value` is one slice of `ShipmentFormValues` (the plain `SectionProps<K>` contract + `form`). */
export type SliceSectionProps<K extends keyof ShipmentFormValues> = WithForm<SectionProps<K>>

/** Rates also prices off Customer Miles / Weight, which live in the Freight card's `ship` slice. */
export type RatesSectionProps = SliceSectionProps<'rates'> & { ship: ShipmentFormValues['ship'] }

/** Sections also read the WHOLE current values (read-only) for Route stops, financialPreview, etc. */
export type WithValues<P> = P & { values: ShipmentFormValues }
