import { useState, useMemo } from 'react'
import { Copy, Check, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useAppStore } from '@/store/useAppStore'
import { chicagoDateStr, addDays, formatTime, needLabel } from '@/lib/date'
import { getColor } from '@/lib/driverColors'
import type { Load, Driver } from '@/types'
import {
  type StopAssignment,
  loadsForDriverOnDay, stopsForDriverOnDay, buildSmsText, buildStopSmsText,
} from './sms'

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return chicagoDateStr(new Date())
}

function formatShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d)
}

function getInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'
}

/** Appointment display matching the calendar day view (NEED / NEED HH:MM / FCFS / range / time). */
function apptText(appt: string, type?: string | null, apptEnd?: string | null): string {
  if (type === 'tbd')  return needLabel(appt)
  if (type === 'fcfs') return 'FCFS'
  if (type === 'range' && apptEnd) return `${formatTime(appt)}–${formatTime(apptEnd)}`
  return appt ? formatTime(appt) : '—'
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy', small }: { text: string; label?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
        height: small ? 26 : 32, padding: small ? '0 9px' : '0 12px',
        borderRadius: 8, border: '1px solid var(--ds-border)', cursor: 'pointer',
        background: copied ? '#f0fdf4' : 'var(--ds-surface)',
        color: copied ? '#15803d' : 'var(--ds-t2)',
        fontSize: small ? 11.5 : 13, fontWeight: 600, fontFamily: 'inherit',
      }}
    >
      {copied ? <Check size={small ? 13 : 14} /> : <Copy size={small ? 13 : 14} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

// ── PU / DE appt line (day-view style) ──────────────────────────────────────────

function ApptLine({ kind, time, location }: { kind: 'PU' | 'DE'; time: string; location: string }) {
  const isPickup = kind === 'PU'
  const need = time.startsWith('NEED')
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, lineHeight: 1.5 }}>
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', color: isPickup ? 'var(--ds-blue)' : '#7c3aed', width: 18, flexShrink: 0 }}>{kind}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{location || <span style={{ color: 'var(--ds-t3)' }}>TBD</span>}</span>
      <span style={{ flexShrink: 0, fontWeight: need ? 700 : 500, color: need ? '#dc2626' : 'var(--ds-t2)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
    </div>
  )
}

// ── Driver schedule card ──────────────────────────────────────────────────────

function DriverCard({ driver, dateStr, loads, assignments }: {
  driver: Driver; dateStr: string; loads?: Load[]; assignments?: StopAssignment[]
}) {
  const multiStop = !!assignments
  const sms = useMemo(
    () => (multiStop ? buildStopSmsText(driver, assignments!, dateStr) : buildSmsText(driver, loads!, dateStr)),
    [multiStop, driver, assignments, loads, dateStr],
  )
  const color = getColor(driver.colorKey)
  const isBroker = driver.type === 'broker'
  const count = multiStop ? assignments!.length : loads!.length
  const unit  = multiStop ? 'stop' : 'load'
  const hasHot = multiStop ? assignments!.some((a) => a.load.hot) : loads!.some((l) => l.hot)

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)', background: 'var(--ds-surface)' }}>
      {/* Header — circle avatar + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
        <Avatar src={driver.photoUrl} initials={getInitials(driver.name)} size="lg" style={{ background: color.avatarBg, color: '#fff' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{driver.name}</span>
            {hasHot && <span title="Has a hot load">🔥</span>}
            {isBroker && (
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ds-t3)', border: '1px solid var(--ds-border)', borderRadius: 5, padding: '1px 6px' }}>Broker</span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            {count} {unit}{count !== 1 ? 's' : ''} · {formatShortDate(dateStr)}
          </div>
        </div>
        <CopyButton text={sms} label="Copy SMS" />
      </div>

      {/* Day-view-style rows */}
      <div>
        {multiStop
          ? assignments!.map(({ load, stop }, i) => {
              const loc = [stop.name, stop.city].filter(Boolean).join(', ')
              const isPickup = stop.type === 'pickup'
              return (
                <ScheduleRow key={`${load.id}:${stop.id}`} index={i + 1} hot={!!load.hot} accent={color.border}
                  proId={load.aljexId} puNum={isPickup ? load.pickupNumber : undefined} tmsId={load.tmsId}>
                  <ApptLine kind={isPickup ? 'PU' : 'DE'} time={apptText(stop.appt, stop.apptType, stop.apptEnd)} location={loc} />
                </ScheduleRow>
              )
            })
          : loads!.map((load, i) => {
              const origin = [load.originName, load.originCity].filter(Boolean).join(', ')
              const dest   = [load.destinationName, load.destinationCity].filter(Boolean).join(', ')
              return (
                <ScheduleRow key={load.id} index={i + 1} hot={!!load.hot} accent={color.border}
                  proId={load.aljexId} puNum={load.pickupNumber} tmsId={load.tmsId}>
                  <ApptLine kind="PU" time={apptText(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)} location={origin} />
                  <ApptLine kind="DE" time={apptText(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)} location={dest} />
                </ScheduleRow>
              )
            })}
      </div>

      {/* SMS-ready caption */}
      <div style={{ borderTop: '1px solid var(--ds-border)', padding: '12px 16px', background: 'var(--ds-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ds-t3)' }}>
            <MessageSquare size={12} /> Text message
          </span>
          <CopyButton text={sms} label="Copy" small />
        </div>
        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, borderTopLeftRadius: 3, padding: '10px 12px' }}>
          <pre style={{ margin: 0, fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ds-t1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>{sms}</pre>
        </div>
      </div>
    </div>
  )
}

// ── A single load/stop row, styled like the calendar day view ───────────────────

function ScheduleRow({ index, hot, accent, proId, puNum, tmsId, children }: {
  index: number; hot: boolean; accent: string
  proId?: string; puNum?: string | null; tmsId?: string | null
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--ds-border)', borderLeft: `3px solid ${hot ? '#dc2626' : accent}`, background: hot ? 'rgba(220,38,38,0.04)' : undefined }}>
      <span style={{ width: 20, height: 20, borderRadius: 999, flexShrink: 0, marginTop: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: hot ? '#fee2e2' : 'var(--ds-bg)', color: hot ? '#b91c1c' : 'var(--ds-t2)', border: '1px solid var(--ds-border)' }}>{index}</span>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {hot && <span style={{ fontSize: 10, fontWeight: 700, color: '#b91c1c' }}>🔥 HOT</span>}
        {children}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: 'var(--ds-t3)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>
          {proId && <span>Pro# {proId}</span>}
          {tmsId && <span>TMS {tmsId}</span>}
          {puNum && <span>PU# {puNum}</span>}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface DriverWork {
  driver: Driver
  loads?: Load[]
  assignments?: StopAssignment[]
  count: number
  sms: string
}

export function SchedulePage() {
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const multiStopRender = useAppStore((s) => s.multiStopRender)
  const [dateStr, setDateStr] = useState(todayStr)

  const activeDrivers = drivers.filter((d) => d.active)

  const driversWithWork = useMemo<DriverWork[]>(() =>
    activeDrivers
      .map((d): DriverWork => {
        if (multiStopRender) {
          const assignments = stopsForDriverOnDay(loads, d.id, dateStr)
          return { driver: d, assignments, count: assignments.length, sms: buildStopSmsText(d, assignments, dateStr) }
        }
        const dl = loadsForDriverOnDay(loads, d.id, dateStr)
        return { driver: d, loads: dl, count: dl.length, sms: buildSmsText(d, dl, dateStr) }
      })
      .filter((w) => w.count > 0),
    [activeDrivers, loads, dateStr, multiStopRender]
  )

  const driversWithoutWork = useMemo(() =>
    activeDrivers.filter((d) => !driversWithWork.some((w) => w.driver.id === d.id)),
    [activeDrivers, driversWithWork]
  )

  const prevDay = () => setDateStr(chicagoDateStr(addDays(new Date(`${dateStr}T12:00:00Z`), -1)))
  const nextDay = () => setDateStr(chicagoDateStr(addDays(new Date(`${dateStr}T12:00:00Z`),  1)))
  const goToday = () => setDateStr(todayStr())
  const isToday = dateStr === todayStr()

  const allSms = driversWithWork.map((w) => w.sms).join('\n\n' + '─'.repeat(40) + '\n\n')

  const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '20px 32px 12px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Schedules</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Per-driver daily run sheets &amp; ready-to-send texts</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button style={navBtn} onClick={prevDay} aria-label="Previous day"><ChevronLeft size={16} /></button>
              <button onClick={goToday} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: isToday ? 'var(--ds-blue)' : 'var(--ds-surface)', color: isToday ? '#fff' : 'var(--ds-t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Today</button>
              <button style={navBtn} onClick={nextDay} aria-label="Next day"><ChevronRight size={16} /></button>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', minWidth: 140, textAlign: 'right' }}>{formatShortDate(dateStr)}</span>
            {driversWithWork.length > 0 && <CopyButton text={allSms} label="Copy all" />}
          </div>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div style={{ padding: '20px 32px 32px' }}>
        {driversWithWork.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '80px 0', color: 'var(--ds-t3)' }}>
            <MessageSquare size={40} style={{ opacity: 0.2 }} />
            <p style={{ fontSize: 14, fontWeight: 500 }}>No loads scheduled for {formatShortDate(dateStr)}</p>
          </div>
        ) : (
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>
              {driversWithWork.length} driver{driversWithWork.length !== 1 ? 's' : ''} scheduled
              {driversWithoutWork.length > 0 && ` · ${driversWithoutWork.map((d) => d.name.split(' ')[0]).join(', ')} off`}
            </p>
            {driversWithWork.map((w) => (
              <DriverCard key={w.driver.id} driver={w.driver} dateStr={dateStr} loads={w.loads} assignments={w.assignments} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
