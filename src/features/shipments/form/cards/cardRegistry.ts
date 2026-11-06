/**
 * The card registry (Step AR): what `ShipmentFormPage` hands each of the five numbered cards and
 * each "More" tab. Cards compose the existing section components (`../sections/*`, imported
 * directly) and read/write ONE shared values object through `update`. The page looks the
 * components up in `defaultSections.tsx` (`CARD_COMPONENTS`, `MORE_TAB_COMPONENTS`).
 *
 * Contract for card authors:
 *  - A card renders from `values` / `ctx` / `issues` and writes with `update(fn)` (functional,
 *    whole-values, stable identity). `sliceOf(update, 'ship')` gives the `onChange` a section wants.
 *  - Keep every field's `data-testid` (the rail's click-to-focus and the issue links find controls
 *    by `data-testid === issue.fieldKey`; `form.focusField` scrolls and focuses it).
 *  - The page owns the card chrome (border, number circle, title); a card component renders only
 *    the body and is always mounted and never collapsed by the page, so required fields stay in
 *    the DOM. CarrierCard owns its own "collapsed until set" presentation inside its body.
 *  - The header owns the Customer type-ahead and the Bill To chip / panel (Customer contact, Ref #);
 *    the rail owns Net/Profit, roles and the checklist. Division (first) and Shipment type are in Freight.
 *  - Cards are NOT given `form.values`; use `values`. `locked` is `ctx.locked` (convenience).
 */
import type { ComponentType } from 'react'
import type { LockSet, ShipmentFormValues } from '../model'
import type { FormCtx, FormIssue } from '../sectionProps'
import type { FormApi } from '../sectionRegistry'

export type CardKey = 'freight' | 'route' | 'rates' | 'carrier' | 'documents'

/** Page order = build order (numbers 1-5). Customer and Bill To live in the header strip, not here. */
export const CARD_ORDER: readonly CardKey[] = [
  'freight', 'route', 'rates', 'carrier', 'documents',
] as const

export const CARD_TITLE: Record<CardKey, string> = {
  freight: 'Freight', route: 'Route', rates: 'Rates', carrier: 'Carrier & Tracking', documents: 'Documents',
}

/** "More" strip tabs: the four free-text / list panes. Everything else is a card. */
export type MoreTabKey = 'instructions' | 'references' | 'items' | 'notes'

export const MORE_TAB_ORDER: readonly MoreTabKey[] = ['instructions', 'references', 'items', 'notes'] as const

export const MORE_TAB_TITLE: Record<MoreTabKey, string> = {
  instructions: 'Instructions', references: 'References', items: 'Items', notes: 'Notes',
}

export interface CardProps {
  values: ShipmentFormValues
  /** Functional update of the whole values object. Stable identity. */
  update: FormApi['update']
  ctx: FormCtx
  /** Stable handle: `getValues()`, `update`, `focusField(fieldKey)`. Call from event handlers only. */
  form: FormApi
  /** All current issues (empty until the first Save/Create attempt); filter by `section`. */
  issues: FormIssue[]
  mode: 'create' | 'edit'
  locked: LockSet
}

/** `props.issues` is the full list; filter by `section` (`customer`, `pickup`/`consignee`/`picks`, `shipping`, `rates`, `history`, `carrier`, `checkCalls`, `documents`). */
export type CardComponent = ComponentType<CardProps>

/** Every More tab receives the same props as a card. */
export type MoreTabComponent = ComponentType<CardProps>

export type CardComponents = Record<CardKey, CardComponent>
export type MoreTabComponents = Record<MoreTabKey, MoreTabComponent>

type Slice = 'ship' | 'customer' | 'roles' | 'more' | 'rates' | 'carrier' | 'checkCall' | 'docs'

/** The `onChange` a slice section expects (`SectionProps<K>['onChange']`), built over `update`. */
export function sliceOf<K extends Slice>(update: FormApi['update'], key: K) {
  return (patch: Partial<ShipmentFormValues[K]> | ((p: ShipmentFormValues[K]) => ShipmentFormValues[K])) =>
    update((p) => ({
      ...p,
      [key]: typeof patch === 'function' ? patch(p[key]) : { ...p[key], ...patch },
    }))
}

/** `onChange` for the whole `stops` array (PicksAndStops). */
export function stopsOf(update: FormApi['update']) {
  return (patch: ShipmentFormValues['stops'] | ((p: ShipmentFormValues['stops']) => ShipmentFormValues['stops'])) =>
    update((p) => ({ ...p, stops: typeof patch === 'function' ? patch(p.stops) : patch }))
}

/** `onChange` for the Pick Up (first) or Consignee (last) stop. */
export function edgeStopOf(update: FormApi['update'], which: 'first' | 'last') {
  return (patch: Partial<ShipmentFormValues['stops'][number]> | ((p: ShipmentFormValues['stops'][number]) => ShipmentFormValues['stops'][number])) =>
    update((p) => {
      const i = which === 'first' ? 0 : p.stops.length - 1
      const cur = p.stops[i]
      if (!cur) return p
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }
      return { ...p, stops: p.stops.map((s, j) => (j === i ? next : s)) }
    })
}
