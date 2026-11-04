/**
 * More Information (AH-plan §4.7): Instructions · Rate Confirmation Notes · Notes · Ref #'s ·
 * Items · Updates · Route. Body only; `FormSection` frames it.
 *
 * Route is derived from the stops, which this slice does not receive reactively, so the
 * list is read from `form.getValues()` each time the tab is opened (an event handler).
 */
import { memo, useState } from 'react'
import { TmsField, TmsTabs, TmsTextarea } from '@/features/tms/kit'
import { HistorySection } from '@/features/shipments/components/HistorySection'
import { FreightEditor, ReferenceEditor } from '@/features/shipments/components/DraftOrderEditor'
import { distanceMeters } from '@/lib/tmsDirectory'
import { MAX } from '../constants'
import { LABEL } from '../labels'
import { isLocked, lockReason, type FormStop } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { fieldAttrs } from './fieldAttrs'

const TABS = [
  { key: 'instructions', label: 'Instructions' },
  { key: 'rateCon', label: 'Rate Confirmation Notes' },
  { key: 'notes', label: 'Notes' },
  { key: 'refs', label: "Ref #'s" },
  { key: 'items', label: 'Items' },
  { key: 'updates', label: 'Updates' },
  { key: 'route', label: 'Route' },
] as const
type TabKey = (typeof TABS)[number]['key']

const MILES_PER_METER = 0.000621371

function Counter({ used, max, testId }: { used: number; max: number; testId: string }) {
  const left = max - used
  return (
    <span
      data-testid={testId}
      className="text-xs"
      style={{ color: left < 0 ? 'var(--tms-badge-red)' : 'var(--tms-muted)' }}
    >
      {left >= 0 ? `${left} characters remaining` : `${-left} over`}
    </span>
  )
}

function legMiles(a: FormStop, b: FormStop): number | null {
  if (a.geo?.lat == null || a.geo.lng == null || b.geo?.lat == null || b.geo.lng == null) return null
  return Math.round(distanceMeters({ lat: a.geo.lat, lng: a.geo.lng }, { lat: b.geo.lat, lng: b.geo.lng }) * MILES_PER_METER)
}

function RouteList({ stops, disableMileage, shipmentId }: { stops: FormStop[]; disableMileage: boolean; shipmentId: string | null }) {
  if (stops.length === 0) return <p className="tms-muted text-sm">No stops yet.</p>
  const legs = stops.map((s, i) => (i === 0 ? null : legMiles(stops[i - 1], s)))
  const known = legs.filter((m): m is number => m != null)
  const complete = stops.length > 1 && known.length === stops.length - 1
  const total = known.reduce((sum, m) => sum + m, 0)
  const lane = [stops[0], stops[stops.length - 1]].map((s) => [s.city, s.state].filter(Boolean).join(', ') || '—').join(' → ')
  return (
    <div className="space-y-1 text-sm" data-testid={LABEL.more.route.testId + '-list'}>
      <p className="tms-muted">Lane: {lane}</p>
      <ol className="space-y-1">
        {stops.map((s, i) => (
          <li key={s.id}>
            {i + 1}. {s.type === 'pickup' ? 'Pick' : 'Delivery'} · {s.name || '—'} · {[s.city, s.state].filter(Boolean).join(', ') || '—'}
            {s.appt || s.ready ? ` · ${(s.appt || s.ready).replace('T', ' ')}` : ''}
            {!disableMileage && legs[i] != null ? ` · +${legs[i]} mi` : ''}
          </li>
        ))}
      </ol>
      {!disableMileage && complete && <p data-testid={LABEL.more.route.testId + '-total'}>Total: {total} mi (straight line)</p>}
      {shipmentId && (
        <a className="text-xs underline" href={`/tms/shipments/${shipmentId}?tab=tracking`}>Open tracking map</a>
      )}
    </div>
  )
}

function MoreInformationSectionImpl({ value, onChange, ctx, form }: SliceSectionProps<'more'>) {
  const [tab, setTab] = useState<TabKey>('instructions')
  const [routeStops, setRouteStops] = useState<{ stops: FormStop[]; disableMileage: boolean }>({ stops: [], disableMileage: false })
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  const refsLocked = isLocked(ctx.locked, 'references')
  const itemsLocked = isLocked(ctx.locked, 'items')

  const select = (key: string) => {
    if (key === 'route') {
      const v = form.getValues()
      setRouteStops({ stops: v.stops, disableMileage: v.ship.disableMileage })
    }
    setTab(key as TabKey)
  }

  const bol = value.bolNotes
  return (
    <div className="space-y-2" data-testid="section-more-body">
      <TmsTabs tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} active={tab} onSelect={select} />

      {tab === 'instructions' && (
        <div className="grid gap-3 min-[1500px]:grid-cols-2">
          <TmsField label={LABEL.more.specialInstructions.text} hint={<Counter used={value.specialInstructions.length} max={MAX.specialInstructions} testId="more-special-counter" />}>
            <TmsTextarea
              {...fieldAttrs(LABEL.more.specialInstructions)}
              rows={4}
              maxLength={MAX.specialInstructions}
              value={value.specialInstructions}
              disabled={disabled}
              onChange={(e) => onChange({ specialInstructions: e.target.value })}
            />
          </TmsField>
          <TmsField label={LABEL.more.bolNotes.text} hint={<Counter used={bol.length} max={MAX.bolNotes} testId="more-bol-counter" />}>
            <TmsTextarea
              {...fieldAttrs(LABEL.more.bolNotes)}
              rows={4}
              value={bol}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.value
                // Stored text longer than the limit is never cut silently; it can only shrink.
                if (next.length > MAX.bolNotes && next.length > bol.length) return
                onChange({ bolNotes: next })
              }}
            />
          </TmsField>
        </div>
      )}

      {tab === 'rateCon' && (
        <TmsField label={LABEL.more.rateConNotes.text} hint={<Counter used={value.rateConNotes.length} max={MAX.rateConNotes} testId="more-ratecon-counter" />}>
          <TmsTextarea
            {...fieldAttrs(LABEL.more.rateConNotes)}
            rows={5}
            maxLength={MAX.rateConNotes}
            value={value.rateConNotes}
            disabled={disabled}
            onChange={(e) => onChange({ rateConNotes: e.target.value })}
          />
        </TmsField>
      )}

      {tab === 'notes' && (
        <TmsField label={LABEL.more.notes.text} hint="Never leaves the office">
          <TmsTextarea
            {...fieldAttrs(LABEL.more.notes)}
            rows={5}
            maxLength={MAX.notes}
            value={value.notes}
            disabled={disabled}
            onChange={(e) => onChange({ notes: e.target.value })}
          />
        </TmsField>
      )}

      {tab === 'refs' && (
        <div data-testid={LABEL.more.references.testId} aria-label={LABEL.more.references.text}>
          <p className="tms-muted mb-2 text-xs">
            Customer Ref #, Pick Up Ref # and Consignee Ref # are managed in the Customer, Pick Up and Consignee sections.
          </p>
          {refsLocked && <p className="tms-muted mb-2 text-xs">{lockReason(ctx.locked, 'references')}</p>}
          <fieldset disabled={disabled || refsLocked} className="m-0 min-w-0 border-0 p-0">
            <ReferenceEditor
              references={value.references}
              required={ctx.customer?.requiredReferences ?? []}
              onChange={(references) => onChange({ references })}
              onCommit={() => {}}
            />
          </fieldset>
        </div>
      )}

      {tab === 'items' && (
        <div data-testid={LABEL.more.items.testId} aria-label={LABEL.more.items.text}>
          <p className="tms-muted mb-2 text-xs">
            Line 1 (Description, Pieces, Weight, Freight Class) is edited in Shipping Requirements. Add further lines here.
          </p>
          {itemsLocked && <p className="tms-muted mb-2 text-xs">{lockReason(ctx.locked, 'items')}</p>}
          <fieldset disabled={disabled || itemsLocked} className="m-0 min-w-0 border-0 p-0">
            <FreightEditor freight={value.items} onChange={(items) => onChange({ items })} onCommit={() => {}} />
          </fieldset>
        </div>
      )}

      {tab === 'updates' && (
        <div data-testid={LABEL.more.updates.testId}>
          {ctx.bundle ? <HistorySection bundle={ctx.bundle} /> : <p className="tms-muted text-sm">Updates appear after the first save.</p>}
        </div>
      )}

      {tab === 'route' && (
        <div data-testid={LABEL.more.route.testId}>
          <RouteList stops={routeStops.stops} disableMileage={routeStops.disableMileage} shipmentId={ctx.bundle?.shipment.id ?? null} />
        </div>
      )}
    </div>
  )
}

export const MoreInformationSection = memo(MoreInformationSectionImpl)
