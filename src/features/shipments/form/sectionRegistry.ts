/**
 * The section registry (AH3): what `ShipmentFormPage` hands each of the twelve sections, and the
 * one place the page looks the components up (`defaultSections.tsx`). Section authors import the
 * prop types from here, never each other.
 *
 * Every section also receives `form`, a *stable* handle for the few things that cross sections
 * (reading the other values when a button is clicked, jumping to a field). It never changes
 * identity, so it does not defeat `React.memo`; render from `value`/`ctx`, call `form.*` from
 * event handlers only.
 */
import type { ComponentType } from 'react'
import type { FormMode, FormStop, ShipmentFormValues } from './model'
import type { FormCtx, SectionKey, SectionProps } from './sectionProps'

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

/** Pick Up (index 0) and Consignee (last index). Inserted stops are rendered by PicksAndStops itself. */
export interface StopSectionProps {
  kind: 'pickup' | 'consignee'
  /** Position in `values.stops`. */
  index: number
  stop: FormStop
  onChange: (patch: Partial<FormStop> | ((prev: FormStop) => FormStop)) => void
  ctx: FormCtx
  form: FormApi
}

/** Historical Rates is read-only: it recomputes from the lane (first pickup → last delivery) and equipment. */
export interface HistoricalRatesProps {
  stops: FormStop[]
  equipmentType: string
  ctx: FormCtx
  form: FormApi
}

/** Shipping Requirements also owns Mode, which lives outside `values.ship`. */
export type ShippingRequirementsProps = SliceSectionProps<'ship'> & { mode: FormMode; onModeChange: (mode: FormMode) => void; routeKey: string }

/** Rates also prices off Customer Miles / Weight, which live in Shipping Requirements. */
export type RatesSectionProps = SliceSectionProps<'rates'> & { ship: ShipmentFormValues['ship'] }

/** AH5's sections also read the WHOLE current values (read-only) for Route stops, financialPreview, etc. */
export type WithValues<P> = P & { values: ShipmentFormValues }

/** Component for each section key. `picks` edits the whole `stops` array. */
export interface SectionComponents {
  shipping: ComponentType<ShippingRequirementsProps>
  customer: ComponentType<SliceSectionProps<'customer'>>
  pickup: ComponentType<StopSectionProps>
  consignee: ComponentType<StopSectionProps>
  history: ComponentType<HistoricalRatesProps>
  roles: ComponentType<SliceSectionProps<'roles'>>
  more: ComponentType<WithValues<SliceSectionProps<'more'>>>
  rates: ComponentType<WithValues<RatesSectionProps>>
  carrier: ComponentType<WithValues<SliceSectionProps<'carrier'>>>
  picks: ComponentType<SliceSectionProps<'stops'>>
  documents: ComponentType<WithValues<SliceSectionProps<'docs'>>>
  checkCalls: ComponentType<WithValues<SliceSectionProps<'checkCall'>>>
}
