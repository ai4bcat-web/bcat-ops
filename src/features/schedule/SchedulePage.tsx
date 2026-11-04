import { useState, useMemo } from 'react'
import { Copy, Check, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { Avatar } from '@/components/ui/avatar'
import { useLoads, useEnsureLoadRange } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { chicagoDateStr, addDays, apptTimeLabel } from '@/lib/date'
import { getColor } from '@/lib/driverColors'
import type { Load, Driver } from '@/types'
import {
  loadsForDriverOnDay, buildSmsText,
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

/** Appointment display — shared with the calendar so the two never disagree. */
const apptText = apptTimeLabel

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
        borderRadius: 8, border: '1px solid var(--tms-border)', cursor: 'pointer',
        background: copied ? 'var(--tms-badge-green-tint)' : 'var(--tms-card)',
        color: copied ? 'var(--tms-badge-green)' : 'var(--tms-text-2)',
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
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', color: isPickup ? 'var(--tms-primary)' : 'var(--tms-badge-purple)', width: 18, flexShrink: 0 }}>{kind}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--tms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{location || <span style={{ color: 'var(--tms-muted)' }}>TBD</span>}</span>
      <span style={{ flexShrink: 0, fontWeight: need ? 700 : 500, color: need ? 'var(--tms-badge-red)' : 'var(--tms-text-2)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
    </div>
  )
}

// ── Driver schedule card ──────────────────────────────────────────────────────

function DriverCard({ driver, dateStr, loads }: {
  driver: Driver; dateStr: string; loads: Load[]
}) {
  const sms = useMemo(
    () => buildSmsText(driver, loads, dateStr),
    [driver, loads, dateStr],
  )
  const color = getColor(driver.colorKey)
  const isBroker = driver.type === 'broker'
  const count = loads.length
  const hasHot = loads.some((l) => l.hot)

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--tms-border)', overflow: 'hidden', boxShadow: 'var(--tms-shadow)', background: 'var(--tms-card)' }}>
      {/* Header — circle avatar + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--tms-border)' }}>
        <Avatar src={driver.photoUrl} initials={getInitials(driver.name)} size="lg" style={{ background: color.avatarBg, color: 'var(--tms-on-primary)' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--tms-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{driver.name}</span>
            {hasHot && <span title="Has a hot load">🔥</span>}
            {isBroker && (
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--tms-muted)', border: '1px solid var(--tms-border)', borderRadius: 5, padding: '1px 6px' }}>Broker</span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--tms-muted)', marginTop: 2 }}>
            {count} load{count !== 1 ? 's' : ''} · {formatShortDate(dateStr)}
          </div>
        </div>
        <CopyButton text={sms} label="Copy SMS" />
      </div>

      {/* Day-view-style rows */}
      <div>
        {loads.map((load, i) => {
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
      <div style={{ borderTop: '1px solid var(--tms-border)', padding: '12px 16px', background: 'var(--tms-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--tms-muted)' }}>
            <MessageSquare size={12} /> Text message
          </span>
          <CopyButton text={sms} label="Copy" small />
        </div>
        <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, borderTopLeftRadius: 3, padding: '10px 12px' }}>
          <pre style={{ margin: 0, fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.55, color: 'var(--tms-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>{sms}</pre>
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
    <div style={{ display: 'flex', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--tms-border)', borderLeft: `3px solid ${hot ? 'var(--tms-badge-red)' : accent}`, background: hot ? 'var(--tms-badge-red-tint)' : undefined }}>
      <span style={{ width: 20, height: 20, borderRadius: 999, flexShrink: 0, marginTop: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: hot ? 'var(--tms-badge-red-tint)' : 'var(--tms-bg)', color: hot ? 'var(--tms-badge-red)' : 'var(--tms-text-2)', border: '1px solid var(--tms-border)' }}>{index}</span>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {hot && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--tms-badge-red)' }}>🔥 HOT</span>}
        {children}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: 'var(--tms-muted)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>
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
  loads: Load[]
  count: number
  sms: string
}

export function SchedulePage() {
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const [dateStr, setDateStr] = useState(todayStr)
  useEnsureLoadRange(dateStr, dateStr)

  const activeDrivers = drivers.filter((d) => d.active)

  const driversWithWork = useMemo<DriverWork[]>(() =>
    activeDrivers
      .map((d): DriverWork => {
        const dl = loadsForDriverOnDay(loads, d.id, dateStr)
        return { driver: d, loads: dl, count: dl.length, sms: buildSmsText(d, dl, dateStr) }
      })
      .filter((w) => w.count > 0),
    [activeDrivers, loads, dateStr]
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

  const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-text-2)', cursor: 'pointer' }

  return (
    <TmsScrollPage
      title="Schedules"
      subtitle="Per-driver daily run sheets & ready-to-send texts"
      stickyHead
      actions={
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button style={navBtn} onClick={prevDay} aria-label="Previous day"><ChevronLeft size={16} /></button>
            <button onClick={goToday} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--tms-border)', background: isToday ? 'var(--tms-primary)' : 'var(--tms-card)', color: isToday ? 'var(--tms-on-primary)' : 'var(--tms-text-2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Today</button>
            <button style={navBtn} onClick={nextDay} aria-label="Next day"><ChevronRight size={16} /></button>
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)', minWidth: 140, textAlign: 'right' }}>{formatShortDate(dateStr)}</span>
          {driversWithWork.length > 0 && <CopyButton text={allSms} label="Copy all" />}
        </>
      }
    >
      <div>
        {driversWithWork.length === 0 ? (
          <TmsEmptyState title={`No loads scheduled for ${formatShortDate(dateStr)}`} message={null} />
        ) : (
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 12.5, color: 'var(--tms-muted)' }}>
              {driversWithWork.length} driver{driversWithWork.length !== 1 ? 's' : ''} scheduled
              {driversWithoutWork.length > 0 && ` · ${driversWithoutWork.map((d) => d.name.split(' ')[0]).join(', ')} off`}
            </p>
            {driversWithWork.map((w) => (
              <DriverCard key={w.driver.id} driver={w.driver} dateStr={dateStr} loads={w.loads} />
            ))}
          </div>
        )}
      </div>
    </TmsScrollPage>
  )
}
