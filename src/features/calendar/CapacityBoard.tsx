import { useMemo, useState } from 'react'
import { Plus, Trash2, Pencil, Check, RotateCcw, CalendarRange, CircleDollarSign, Clock, User, Ban, History } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { CapacityCardDialog } from './CapacityCardDialog'
import { CapacityNoGoStrip } from './CapacityNoGoStrip'
import { CapacityTruckArt } from './CapacityTruckArt'
import { assignAccents, CAPACITY_ACCENTS, truckKindFor } from './capacityCardStyle'
import './capacityBoard.css'
import { useCapacityBoard } from './useCapacityBoard'
import {
  canonicalEquipment, capacityColumns, capacityHeadline, clampCapacityRange, formatCapacityTimes, formatMaxWeight, formatRatePerMile, rangeDays, readCapacityHistory,
  summarizeNoGoStates, todayChicagoYmd,
  type CapacityCard,
} from '@/lib/capacityBoard'
import { displayName } from '@/lib/roles'
import type { Driver } from '@/types'

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function dayParts(day: string): { weekday: string; date: string } {
  const d = new Date(`${day}T00:00:00Z`)
  return { weekday: WEEKDAY.format(d), date: MONTH_DAY.format(d) }
}

/** "Mon Nov 30 – Wed Dec 2" for a card offered on more than one day; '' for a single day. */
function spanLabel(c: Pick<CapacityCard, 'availableFrom' | 'availableTo'>): string {
  if (c.availableFrom === c.availableTo) return ''
  const a = dayParts(c.availableFrom)
  const b = dayParts(c.availableTo)
  return `${a.weekday} ${a.date} – ${b.weekday} ${b.date}`
}

const WHEN = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })

/** "Sat Nov 28, 2:15 PM" in Chicago time, the office's clock. */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : WHEN.format(d).replace(/^(\w{3}),/, '$1')
}

const EVENT_VERB = { created: 'Created', covered: 'Marked covered', reopened: 'Reopened' } as const

const DRAG_TYPE = 'application/x-bcat-capacity-card'

/** What a dragged card carries: its id and the day it was picked up from. Anything else dropped on a column is ignored. */
function readDragPayload(raw: string): { id: string; fromDay: string } | null {
  try {
    const v = JSON.parse(raw) as { id?: unknown; fromDay?: unknown }
    return typeof v.id === 'string' && typeof v.fromDay === 'string' && v.id && v.fromDay ? { id: v.id, fromDay: v.fromDay } : null
  } catch {
    return null
  }
}

/**
 * The Calendar's Capacity board: one column per day across the chosen range, a card for each truck the office needs to fill. A card
 * is dragged to another day to move it, marked Covered when a load is found (it stays, greyed, until its last day passes), and
 * deleted with an Undo. On a phone the days stack, one under another.
 */
export function CapacityBoard({ from, to, onRangeChange, drivers, phone, userEmail }: {
  from: string
  to: string
  onRangeChange: (from: string, to: string) => void
  drivers: Driver[]
  phone: boolean
  userEmail: string
}) {
  const { board, loading, error, save, move, cover, reopen, remove, setNoGoStates } = useCapacityBoard(true, userEmail)
  const [showCovered, setShowCovered] = useState(true)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ card: CapacityCard | null; day: string } | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const days = useMemo(() => rangeDays(from, to), [from, to])
  const columns = useMemo(() => capacityColumns(board, days, showCovered, query), [board, days, showCovered, query])
  // Colors are settled over the whole board, not the visible slice, so a card keeps its color whatever range or filter is on screen.
  const accents = useMemo(() => assignAccents(board.cards), [board.cards])
  const driverName = useMemo(() => new Map(drivers.map((d) => [d.id, d.name])), [drivers])
  const today = todayChicagoYmd()
  const totalOpen = columns.reduce((n, c) => n + c.open, 0)
  const noGoStates = board.noGoStates ?? []

  const inputStyle: React.CSSProperties = {
    height: 30, padding: '0 8px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)',
    color: 'var(--tms-text)', fontSize: 12.5, fontFamily: 'inherit',
  }

  function onDrop(e: React.DragEvent, toDay: string) {
    e.preventDefault()
    setDragOver(null)
    const payload = readDragPayload(e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain'))
    if (!payload || payload.fromDay === toDay) return
    void move(payload.id, payload.fromDay, toDay)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="capacity-board">
      {/* Controls: the range, the covered filter, a search, and the New card button. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: phone ? '8px' : '10px 14px', borderBottom: '1px solid var(--tms-border)', flexShrink: 0 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)' }}>
          From
          <input type="date" aria-label="Capacity range from" value={from} style={inputStyle}
            onChange={(e) => { if (e.target.value) { const r = clampCapacityRange(e.target.value, to); onRangeChange(r.from, r.to) } }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)' }}>
          Through
          <input type="date" aria-label="Capacity range through" value={to} min={from} style={inputStyle}
            onChange={(e) => { if (e.target.value) { const r = clampCapacityRange(from, e.target.value); onRangeChange(r.from, r.to) } }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showCovered} onChange={(e) => setShowCovered(e.target.checked)} />
          Show covered
        </label>
        <input
          type="search" aria-label="Search capacity cards" placeholder="Search origin, destination, equipment…" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ ...inputStyle, flex: '1 1 180px', minWidth: 140, maxWidth: 320 }}
        />
        <span style={{ fontSize: 12, color: 'var(--tms-muted)' }} aria-live="polite">{totalOpen} open in range</span>
        <TmsButton variant="primary" onClick={() => setDialog({ card: null, day: days[0] ?? today })} style={{ marginLeft: 'auto' }}>
          <Plus size={14} aria-hidden="true" /> New card
        </TmsButton>
      </div>

      <CapacityNoGoStrip states={noGoStates} onSave={setNoGoStates} phone={phone} />

      {error && <p role="alert" style={{ margin: 0, padding: '8px 14px', fontSize: 12.5, color: 'var(--tms-badge-red)' }}>{error}</p>}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: phone ? 8 : 12 }}>
        {loading ? (
          <p style={{ color: 'var(--tms-muted)', fontSize: 13 }}>Loading the capacity board…</p>
        ) : (
          <div
            style={{
              display: 'grid', gap: 10, alignItems: 'start',
              gridTemplateColumns: phone ? '1fr' : `repeat(${Math.max(columns.length, 1)}, minmax(220px, 1fr))`,
            }}
          >
            {columns.map((col) => {
              const { weekday, date } = dayParts(col.day)
              const isToday = col.day === today
              const isPast = col.day < today
              const over = dragOver === col.day
              return (
                <section
                  key={col.day}
                  aria-label={`${weekday} ${date}`}
                  data-day={col.day}
                  onDragOver={(e) => { e.preventDefault(); if (dragOver !== col.day) setDragOver(col.day) }}
                  onDragLeave={() => setDragOver((cur) => (cur === col.day ? null : cur))}
                  onDrop={(e) => onDrop(e, col.day)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 8, minHeight: phone ? 0 : 220, padding: 8, borderRadius: 10,
                    border: `1px solid ${over ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
                    background: over ? 'var(--tms-primary-tint)' : 'var(--tms-bg)', opacity: isPast ? 0.8 : 1,
                  }}
                >
                  <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)' }}>
                        {weekday} {date}{isToday && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--tms-primary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Today</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--tms-muted)' }} data-testid={`count-${col.day}`}>
                        {col.open} open{col.covered > 0 ? ` · ${col.covered} covered` : ''}
                      </div>
                    </div>
                    <button
                      type="button" aria-label={`Add a card on ${weekday} ${date}`} onClick={() => setDialog({ card: null, day: col.day })}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: phone ? 36 : 26, height: phone ? 36 : 26, borderRadius: 7, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-text-2)', cursor: 'pointer' }}
                    >
                      <Plus size={14} />
                    </button>
                  </header>
                  {col.cards.length === 0 && (
                    <p style={{ margin: 0, padding: '14px 4px', fontSize: 12, color: 'var(--tms-muted)', textAlign: 'center' }}>
                      {col.covered > 0 ? 'All covered' : 'No trucks to fill'}
                    </p>
                  )}
                  {col.cards.map((card) => (
                    <CapacityCardView
                      key={card.id} card={card} day={col.day} noGoStates={noGoStates} accent={CAPACITY_ACCENTS[accents.get(card.id) ?? 0].hex} driverName={card.driverId ? driverName.get(card.driverId) : undefined}
                      onEdit={() => setDialog({ card, day: col.day })}
                      onCover={() => void cover(card.id)} onReopen={() => void reopen(card.id)} onDelete={() => void remove(card.id)}
                    />
                  ))}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {dialog && (
        <CapacityCardDialog card={dialog.card} day={dialog.day} drivers={drivers} noGoStates={noGoStates} onSave={save} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}

function CapacityCardView({ card, day, noGoStates, accent, driverName, onEdit, onCover, onReopen, onDelete }: {
  card: CapacityCard
  day: string
  noGoStates: readonly string[]
  accent: string
  driverName: string | undefined
  onEdit: () => void
  onCover: () => void
  onReopen: () => void
  onDelete: () => void
}) {
  const covered = card.status === 'COVERED'
  const span = spanLabel(card)
  const rate = formatRatePerMile(card.minRatePerMileCents)
  const times = formatCapacityTimes(card)
  const kind = truckKindFor(card.equipment)
  const equipment = canonicalEquipment(card.equipment)
  const [historyOpen, setHistoryOpen] = useState(false)
  const history = readCapacityHistory(card)
  const coveredWhen = covered && card.coveredBy ? `Covered by ${displayName(card.coveredBy)}${card.coveredAt ? ` · ${formatWhen(card.coveredAt)}` : ''}` : ''
  const noGo = summarizeNoGoStates(noGoStates)
  const chips = [equipment, `${card.lengthFt} ft`, card.loadType === 'PARTIAL' ? 'Partial' : 'Full', formatMaxWeight(card.weightLbs)].filter(Boolean)
  return (
    <article
      className="cap-card"
      draggable
      data-testid="capacity-card"
      data-card-id={card.id}
      data-status={card.status}
      data-accent={accent}
      style={{ '--cap-accent': accent } as React.CSSProperties}
      onDragStart={(e) => {
        const payload = JSON.stringify({ id: card.id, fromDay: day })
        e.dataTransfer.setData(DRAG_TYPE, payload)
        e.dataTransfer.setData('text/plain', payload)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <div className="cap-art">
        <CapacityTruckArt kind={kind} accent={accent} label={`${equipment || 'Dry Van'} truck`} />
        {span && <span className="cap-span"><CalendarRange size={11} aria-hidden="true" />{span}</span>}
        <span className="cap-pill" title={coveredWhen || undefined}>{covered && <Check size={11} aria-hidden="true" />}{covered ? 'Covered' : 'Open'}</span>
      </div>
      <div className="cap-body">
        <div className="cap-route">{capacityHeadline(card)}</div>
        <div className="cap-chips">{chips.map((c, i) => <span key={`${c}-${i}`} className="cap-chip">{c}</span>)}</div>
        {rate && <div className="cap-line"><CircleDollarSign size={13} aria-hidden="true" /><span>{rate}</span></div>}
        {times && <div className="cap-line"><Clock size={13} aria-hidden="true" /><span>{times}</span></div>}
        {driverName && <div className="cap-line"><User size={13} aria-hidden="true" /><span>Driver {driverName}</span></div>}
        {card.comments && <div className="cap-note">{card.comments}</div>}
        {noGo.shown.length > 0 && (
          <div className="cap-line cap-line--nogo" data-testid="card-nogo" title={`We do not travel to: ${noGo.all}`}>
            <Ban size={13} aria-hidden="true" />
            <span>No-go: {noGo.shown.join(', ')}{noGo.more > 0 ? ` +${noGo.more}` : ''}</span>
          </div>
        )}
        {coveredWhen && <div className="cap-covered-by" data-testid="covered-by">{coveredWhen}</div>}
        {historyOpen && history.length > 0 && (
          <ul className="cap-history" aria-label="Card history" data-testid="card-history">
            {[...history].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`}><strong>{EVENT_VERB[e.action]}</strong> by {displayName(e.by)} · {formatWhen(e.at)}</li>
            ))}
          </ul>
        )}
        <div className="cap-actions">
          {covered ? (
            <button type="button" className="cap-btn cap-btn--reopen" onClick={onReopen} aria-label="Reopen" title="Move back to open"><RotateCcw size={13} aria-hidden="true" /> Reopen</button>
          ) : (
            <button type="button" className="cap-btn cap-btn--cover" onClick={onCover} aria-label="Mark as covered" title="Mark this truck as covered"><Check size={13} aria-hidden="true" /> Mark as covered</button>
          )}
          {history.length > 0 && (
            <button type="button" className="cap-btn" onClick={() => setHistoryOpen((o) => !o)} aria-label="History" aria-expanded={historyOpen} title="Who did what, and when"><History size={13} /></button>
          )}
          <button type="button" className="cap-btn" onClick={onEdit} aria-label="Edit card" title="Edit"><Pencil size={13} /></button>
          <button type="button" className="cap-btn cap-btn--danger" onClick={onDelete} aria-label="Delete card" title="Delete"><Trash2 size={13} /></button>
        </div>
      </div>
    </article>
  )
}
