/**
 * What the Empty trucks view draws below its toolbar (Ryne 2026-11-18): a strip of big numbers,
 * a map-first hero with the top ranked trucks as numbered cards on either side, and the full
 * ranked list underneath with the open loads and the Assign button. It only draws: the page
 * supplies the computed rows, who may see money, and what Assign does.
 *
 * Money: customer rates and the dollar value of an idle truck only show when `canSeeMoney`.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, MapPin, Truck, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyTrucksMap, EmptyTrucksLegend } from './EmptyTrucksMap'
import {
  deadheadTier, urgencyOf, LONG_DEADHEAD_MILES,
  type EmptyTrucksResult, type EmptyTruckRow, type OpenLoadMatch,
} from './emptyTrucks'
import {
  TIER_COLOR, URGENCY_COLOR, URGENCY_TINT,
  cornerChip, dayText, dollars, emptyHeadline, idleText, runText, whenText,
} from './emptyTrucksStyle'

/** Trucks shown as cards beside the map; the list below has all of them. */
export const HERO_CARDS = 6

type Layout = 'wide' | 'medium' | 'narrow'

/** A PRO that opens its shipment when it has one. */
function ProLink({ shipmentId, pro, title }: { shipmentId: string | null; pro: string; title?: string }) {
  const text = `PRO ${pro}`
  return shipmentId
    ? <Link to={`/tms/shipments/${shipmentId}/edit`} style={{ fontWeight: 700, color: 'var(--tms-primary)', fontVariantNumeric: 'tabular-nums' }} title={title ?? 'Open the shipment'} onClick={(e) => e.stopPropagation()}>{text}</Link>
    : <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{text}</span>
}

function MatchLine({ match, canAssign, onAssign }: { match: OpenLoadMatch; canAssign: boolean; onAssign: () => void }) {
  const run = match.deadheadMiles
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5, padding: '4px 0', borderTop: '1px dashed var(--tms-border)' }}>
      <ProLink shipmentId={match.shipmentId} pro={match.pro} />
      <span style={{ color: 'var(--tms-text-2)', minWidth: 0 }}>{match.lane}</span>
      <span style={{ color: 'var(--tms-muted)' }}>picks up {whenText(match.pickupAt, match.pickupTimeKnown)}</span>
      {match.customer ? <span style={{ color: 'var(--tms-muted)' }}>{match.customer}</span> : null}
      {match.rateCents != null ? <span style={{ fontWeight: 600, color: 'var(--tms-text)' }}>{dollars(match.rateCents)}</span> : null}
      <span
        style={{ color: match.longDeadhead ? 'var(--tms-badge-orange)' : 'var(--tms-muted)', fontWeight: match.longDeadhead ? 700 : 500 }}
        title={`Empty run to the pickup: air miles from where the truck is empty times 1.15 for the road${match.approx ? '. One end is only placed to its state, so this is rough' : ''}.`}
      >
        {run == null ? 'distance unknown' : `${match.approx ? '≈ ' : 'about '}${run} mi empty${match.longDeadhead ? ` (over ${LONG_DEADHEAD_MILES})` : ''}`}
      </span>
      {canAssign ? <Button size="sm" variant="outline" className="h-6 px-2 text-xs ml-auto" onClick={onAssign}>Assign</Button> : null}
    </div>
  )
}

/** The number on a truck: the same circle on the map pin, the card and the list row. */
function RankBadge({ rank, color }: { rank: number; color: string }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 5px', borderRadius: 11,
      background: color, color: 'var(--tms-card)', fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', flexShrink: 0,
    }}>{rank}</span>
  )
}

function Tile({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone?: string; hint?: string }) {
  return (
    <div style={{ flex: '1 1 150px', minWidth: 0, border: '1px solid var(--tms-border)', borderRadius: 12, background: 'var(--tms-card)', padding: '10px 14px' }} title={hint}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>{label}</div>
      <div style={{ fontSize: 26, lineHeight: 1.15, fontWeight: 800, color: tone ?? 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function EmptyTruckCard({ row, rank, now, selected, canSeeMoney, canSetValue, onSelect }: {
  row: EmptyTruckRow
  rank: number
  now: number
  selected: boolean
  canSeeMoney: boolean
  canSetValue: boolean
  onSelect: () => void
}) {
  const urgency = urgencyOf(row, now)
  const color = URGENCY_COLOR[urgency]
  const best = row.kind === 'IDLE' ? row.matches[0] : undefined
  const tier = best ? deadheadTier(best.deadheadMiles) : null
  const footer = row.kind === 'BACK_TO_BACK'
    ? { text: 'Booked next', fg: 'var(--tms-badge-blue)', bg: 'var(--tms-badge-blue-tint)' }
    : best
      ? { text: 'Load matched', fg: 'var(--tms-badge-green)', bg: 'var(--tms-badge-green-tint)' }
      : { text: 'No load nearby', fg: 'var(--tms-badge-orange)', bg: 'var(--tms-badge-orange-tint)' }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Truck ${rank}: ${row.driverName}, empty in ${row.point.place ?? 'an unknown place'}. ${cornerChip(row, now)}`}
      data-testid="empty-truck-card"
      data-selected={selected ? 'true' : undefined}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      style={{
        display: 'grid', gap: 5, padding: '9px 11px', borderRadius: 12, cursor: 'pointer', background: 'var(--tms-card)',
        border: `1px solid ${selected ? color : 'var(--tms-border)'}`,
        boxShadow: selected ? `0 0 0 2px ${URGENCY_TINT[urgency]}, var(--tms-shadow-pop)` : 'var(--tms-shadow)',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <RankBadge rank={rank} color={color} />
        <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: URGENCY_TINT[urgency], color }}>
          {cornerChip(row, now)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--tms-text)' }}>
        <Truck className="size-3.5 shrink-0" aria-hidden="true" style={{ color }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.driverName}</span>
        <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--tms-muted)', whiteSpace: 'nowrap' }}>{row.truck ? `Truck ${row.truck}` : 'No truck'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--tms-text-2)', minWidth: 0 }}>
        <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.point.place ?? 'Place not on the stop'}</span>
        <span style={{ color: 'var(--tms-muted)', whiteSpace: 'nowrap' }}>· {row.kind === 'BACK_TO_BACK' ? 'next load follows' : row.openEnded ? `idle ${row.idleDays} d+` : `idle ${row.idleDays} d`}</span>
      </div>
      {best && tier ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, minWidth: 0 }}>
          <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" style={{ color: TIER_COLOR[tier] }} />
          <span style={{ fontWeight: 700, color: 'var(--tms-text)', whiteSpace: 'nowrap' }}>PRO {best.pro}</span>
          <span style={{ color: 'var(--tms-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{best.pickupPlace ?? best.lane}</span>
          <span style={{ marginLeft: 'auto', fontWeight: 700, color: TIER_COLOR[tier], whiteSpace: 'nowrap' }}>{runText(best.deadheadMiles, best.approx)}</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px 6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: footer.bg, color: footer.fg, whiteSpace: 'nowrap' }}>{footer.text}</span>
        {best && best.rateCents != null ? <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', background: 'var(--tms-surface-hover)', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{dollars(best.rateCents)} load</span> : null}
        {canSeeMoney && row.kind === 'IDLE' ? (
          row.idleValueCents != null
            ? <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: 'var(--tms-text)', whiteSpace: 'nowrap' }}>{dollars(row.idleValueCents)} idle</span>
            : <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--tms-muted)', whiteSpace: 'nowrap' }}>{canSetValue ? 'Set a daily value' : ''}</span>
        ) : null}
      </div>
    </div>
  )
}

export interface EmptyTrucksBoardProps {
  result: EmptyTrucksResult
  /** The trucks to show, after the back-to-back filter, in rank order. */
  rows: readonly EmptyTruckRow[]
  now: number
  ready: boolean
  horizonLabel: string
  canSeeMoney: boolean
  canSetValue: boolean
  canAssign: boolean
  selected: string | null
  onSelect: (key: string | null) => void
  onAssign: (match: OpenLoadMatch, driverId: string) => void
}

export function EmptyTrucksBoard({ result, rows, now, ready, horizonLabel, canSeeMoney, canSetValue, canAssign, selected, onSelect, onAssign }: EmptyTrucksBoardProps) {
  const heroRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(1200)
  useEffect(() => {
    const el = heroRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready, rows.length])
  const layout: Layout = width >= 1000 ? 'wide' : width >= 640 ? 'medium' : 'narrow'

  const idleRows = rows.filter((r) => r.kind === 'IDLE')
  const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    el?.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })
  }
  // A pin click shows its card: the card beside the map when it has one, else its row in the list.
  const pickFromMap = (key: string) => {
    onSelect(key)
    const idx = rows.findIndex((r) => r.key === key)
    scrollTo(idx >= 0 && idx < HERO_CARDS ? `et-card-${key}` : `et-row-${key}`)
  }

  const heroRows = rows.slice(0, HERO_CARDS)
  const card = (row: EmptyTruckRow) => {
    const rank = rows.indexOf(row) + 1
    return (
      <div key={row.key} id={`et-card-${row.key}`} style={{ minWidth: 0 }}>
        <EmptyTruckCard row={row} rank={rank} now={now} selected={selected === row.key} canSeeMoney={canSeeMoney} canSetValue={canSetValue} onSelect={() => onSelect(selected === row.key ? null : row.key)} />
      </div>
    )
  }
  const left = heroRows.filter((_, i) => i % 2 === 0)
  const right = heroRows.filter((_, i) => i % 2 === 1)

  const mapNode = (
    <div style={{ minWidth: 0 }}>
      <EmptyTrucksMap rows={rows} openLoads={result.openLoads} now={now} selectedKey={selected} onSelect={pickFromMap} />
      <EmptyTrucksLegend hasOpenLoads={result.openLoads.length > 0} />
    </div>
  )

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div data-testid="empty-trucks-summary" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Tile label="Trucks going empty" value={result.summary.trucks} hint={`Own-fleet trucks with a gap on the schedule in the next ${horizonLabel}`} />
        <Tile label="Empty now" value={result.summary.emptyNow} tone={result.summary.emptyNow > 0 ? 'var(--tms-badge-red)' : undefined} hint="Already delivered, or past the appointment and not marked left" />
        <Tile label="Idle truck-days" value={result.summary.idleTruckDays} hint="Days trucks sit with nothing booked, to the next pickup or the end of the window" />
        <Tile label="Open loads that fit" value={<>{result.summary.openLoadsCovering}<span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-muted)' }}> of {result.openLoads.length}</span></>} hint="Open loads with no driver that could cover a truck going empty" />
        {canSeeMoney ? (
          result.summary.valueCents != null
            ? <Tile label="Idle value" value={dollars(result.summary.valueCents)} hint="Idle days times the daily value, through the end of the window" />
            : <Tile label="Idle value" value={<span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-muted)', lineHeight: 1.4, display: 'block', paddingTop: 6 }}>{canSetValue ? 'Set a daily value to see dollars' : 'No daily value set yet'}</span>} />
        ) : null}
      </div>

      {!ready && rows.length === 0 ? <div style={{ color: 'var(--tms-muted)', fontSize: 13, padding: 12 }}>Loading the schedule…</div> : null}
      {ready && rows.length === 0 ? (
        <div style={{ color: 'var(--tms-muted)', fontSize: 13, padding: 16, border: '1px dashed var(--tms-border)', borderRadius: 10 }}>
          No own-fleet truck goes empty in the next {horizonLabel} on the schedule. Trucks booked back to back are hidden unless you tick Show back-to-back.
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div ref={heroRef} data-testid="empty-trucks-hero" data-layout={layout}>
          {layout === 'wide' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(230px, 280px) minmax(0, 1fr) minmax(230px, 280px)', gap: 12, alignItems: 'stretch' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'space-between' }}>{left.map(card)}</div>
              {mapNode}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'space-between' }}>{right.map(card)}</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {mapNode}
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: layout === 'medium' ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)' }}>{heroRows.map(card)}</div>
            </div>
          )}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
            All trucks going empty · {rows.length}
          </div>
          {rows.map((row, i) => {
            const urgency = urgencyOf(row, now)
            const color = URGENCY_COLOR[urgency]
            const isSel = selected === row.key
            return (
              <div
                key={row.key}
                id={`et-row-${row.key}`}
                data-testid="empty-truck-row"
                data-selected={isSel ? 'true' : undefined}
                onClick={() => onSelect(isSel ? null : row.key)}
                style={{ border: `1px solid ${isSel ? color : 'var(--tms-border)'}`, borderLeft: `4px solid ${color}`, borderRadius: 10, background: 'var(--tms-card)', padding: '10px 12px', cursor: 'pointer', opacity: row.kind === 'BACK_TO_BACK' ? 0.75 : 1 }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <RankBadge rank={i + 1} color={color} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tms-text)' }}>{row.driverName}</span>
                  <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{row.truck ? `Truck ${row.truck}` : 'No truck on file'}{row.trailer ? ` · Trailer ${row.trailer}` : ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color }}>{emptyHeadline(row, now)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 3, fontSize: 13, color: 'var(--tms-text-2)' }}>
                  <MapPin className="size-3.5" aria-hidden="true" />
                  <strong>{row.point.place ?? 'Place not on the stop'}</strong>
                  {row.point.approx ? <span style={{ fontSize: 11, color: 'var(--tms-muted)' }} title="The stop has no city on file the map knows, so it is placed at the middle of its state">(state centre on the map)</span> : null}
                  <span style={{ color: 'var(--tms-muted)' }}>after</span>
                  <ProLink shipmentId={row.endLoad.shipmentId} pro={row.endLoad.pro} />
                  <span style={{ color: 'var(--tms-muted)' }}>{row.endLoad.lane}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4, fontSize: 12.5 }}>
                  <span style={{ color: row.next ? 'var(--tms-text-2)' : 'var(--tms-badge-orange)', fontWeight: row.next ? 500 : 700 }}>
                    {row.next
                      ? <>Booked next: <ProLink shipmentId={row.next.shipmentId} pro={row.next.pro} /> {row.next.place ?? ''} · picks up {whenText(row.next.startAt, row.next.timeKnown)}</>
                      : 'Nothing booked'}
                  </span>
                  <span style={{ color: 'var(--tms-muted)' }}>{idleText(row, result.horizonEnd)}</span>
                  {canSeeMoney && row.kind === 'IDLE' ? (
                    row.idleValueCents != null
                      ? <span style={{ fontWeight: 700, color: 'var(--tms-text)' }}>{dollars(row.idleValueCents)} idle</span>
                      : <span style={{ color: 'var(--tms-muted)' }}>{canSetValue ? 'Set a daily value to see $' : 'No daily value set'}</span>
                  ) : null}
                </div>
                {row.kind === 'IDLE' ? (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>Open loads near here</div>
                    {row.matches.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--tms-muted)', padding: '4px 0' }}>None uncovered with a pickup after this truck is empty{row.next ? ' and before its next load' : ''}.</div>
                    ) : row.matches.map((m) => (
                      <MatchLine key={m.loadId} match={m} canAssign={canAssign} onAssign={() => onAssign(m, row.driverId)} />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
          {rows.some((r) => r.matches.some((m) => m.approx)) ? (
            <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', gap: 5, alignItems: 'center' }}>
              <AlertTriangle className="size-3" /> Distances marked ≈ are rough: one end is only placed to its state.
            </div>
          ) : null}
          <div style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>
            Empty means after the last stop on the schedule: the time it left if it has, else its appointment. Own-fleet (Ivan) drivers only. Times are Chicago.
            {idleRows.length > 0 && result.openLoads.length > 0 ? ` Open loads picking up through ${dayText(result.horizonEnd)} are drawn as diamonds on the map.` : ''}
          </div>
        </div>
      ) : null}
    </div>
  )
}
