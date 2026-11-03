/**
 * The bell's drawer: every condition that needs someone, one tab per kind that has any.
 * Rows are plain links to the record that fixes the condition and close the drawer on click.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  CalendarClock,
  ClipboardCheck,
  CreditCard,
  FileWarning,
  PhoneCall,
  Workflow,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { relativeTime } from '@/features/shipments/workstations/motion'
import { TmsDrawer } from '../kit/TmsDrawer'
import { TmsEmptyState } from '../kit/TmsEmptyState'
import { TmsSegmentedTabs } from '../kit/TmsSegmentedTabs'
import type {
  NotificationGroup,
  NotificationItem,
  NotificationKind,
  NotificationSeverity,
} from './collectNotifications'

const ICONS: Record<NotificationKind, LucideIcon> = {
  CHECK_CALLS: PhoneCall,
  PODS: FileWarning,
  DOCUMENTS: CalendarClock,
  CREDIT: CreditCard,
  REVIEW: ClipboardCheck,
  WORKFLOWS: Workflow,
}

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  critical: 'var(--tms-badge-red)',
  warn: 'var(--tms-badge-orange)',
  info: 'var(--tms-badge-blue)',
}

const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  critical: 'Critical',
  warn: 'Warning',
  info: 'Info',
}

const ALL = 'ALL'

export interface NotificationsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: NotificationGroup[]
}

function Row({ item, nowMs, onNavigate }: { item: NotificationItem; nowMs: number; onNavigate: () => void }) {
  const Icon = ICONS[item.kind]
  const age = relativeTime(item.at, nowMs)
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className="tms-notification-row"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 4px',
        borderBottom: '1px solid var(--tms-border)',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ marginTop: 2, flex: 'none' }} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 600 }}>{item.title}</span>
        <span className="tms-muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.detail}
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        <span
          role="img"
          aria-label={SEVERITY_LABEL[item.severity]}
          style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT[item.severity] }}
        />
        {age ? <span className="tms-muted">{age}</span> : null}
      </span>
    </Link>
  )
}

/** Mounted only while the drawer is open, so its clock is "when you looked". */
function Body({ groups, onNavigate }: { groups: NotificationGroup[]; onNavigate: () => void }) {
  const [nowMs] = useState(() => Date.now())
  const [tab, setTab] = useState(ALL)
  const total = groups.reduce((sum, g) => sum + g.total, 0)
  if (groups.length === 0) {
    return <TmsEmptyState compact title="You're all caught up." message="Nothing needs attention right now." />
  }
  const active = groups.some((g) => g.kind === tab) ? tab : ALL
  const shown = active === ALL ? groups : groups.filter((g) => g.kind === active)
  const sections: ReactNode[] = shown.map((g) => (
    <section key={g.kind} aria-label={g.label}>
      {active === ALL ? <h3 style={{ fontSize: 12, margin: '14px 0 2px' }} className="tms-muted">{g.label}</h3> : null}
      {g.items.map((item) => <Row key={item.id} item={item} nowMs={nowMs} onNavigate={onNavigate} />)}
      {g.total > g.items.length ? (
        <Link to={g.moreTo} onClick={onNavigate} style={{ display: 'block', padding: '8px 4px' }}>
          {g.moreLabel} — {g.total - g.items.length} more →
        </Link>
      ) : null}
    </section>
  ))
  return (
    <>
      <TmsSegmentedTabs
        aria-label="Notification kinds"
        tabs={[
          { key: ALL, label: 'All', count: total },
          ...groups.map((g) => ({ key: g.kind, label: g.label, count: g.total })),
        ]}
        active={active}
        onSelect={setTab}
      />
      {sections}
    </>
  )
}

export function NotificationsDrawer({ open, onOpenChange, groups }: NotificationsDrawerProps) {
  return (
    <TmsDrawer open={open} onOpenChange={onOpenChange} title="Notifications" size="md">
      <Body groups={groups} onNavigate={() => onOpenChange(false)} />
    </TmsDrawer>
  )
}
