/**
 * The driver card shared by the Inbox info panel and the shipment Tracking tab:
 * avatar, name, load-status pill, a call button when a phone is on file, and the
 * dispatcher beneath. Presence is never claimed — only stored facts show.
 */
import { Mail, Phone } from 'lucide-react'
import { TmsAvatar, TmsBadge } from '@/features/tms/kit'
import type { LoadWorkflowStatus } from '@/types/tms'
import { driverStatusPill } from './statusTimeline'

export interface DriverCardParty {
  name?: string | null
  phone?: string | null
  email?: string | null
}

export interface DriverCardProps {
  driver: DriverCardParty | null
  dispatcher?: DriverCardParty | null
  loadStatus?: LoadWorkflowStatus | null
}

export function DriverCard({ driver, dispatcher, loadStatus }: DriverCardProps) {
  const name = driver?.name?.trim() || null
  const pill = driverStatusPill(loadStatus)
  const hasDispatcher = Boolean(dispatcher?.name || dispatcher?.phone || dispatcher?.email)
  return (
    <section className="tms-driver-card" data-testid="inbox-driver-card" aria-label="Driver">
      <div className="tms-driver-card-main">
        <TmsAvatar label={name ?? 'Driver'} size="md" />
        <div className="tms-driver-card-id">
          <span className="tms-driver-card-name">{name ?? 'No driver on file'}</span>
          {driver?.phone && <span className="tms-driver-card-sub">{driver.phone}</span>}
        </div>
        {pill && <TmsBadge tone={pill.tone} data-testid="driver-status-pill">{pill.label}</TmsBadge>}
        {driver?.phone && (
          <a className="tms-icon-link" href={`tel:${driver.phone}`} aria-label={`Call ${name ?? 'driver'}`} title={`Call ${driver.phone}`}>
            <Phone size={15} aria-hidden />
          </a>
        )}
      </div>
      {hasDispatcher && (
        <div className="tms-driver-card-dispatcher" data-testid="driver-dispatcher">
          <span className="tms-driver-card-label">Dispatcher</span>
          <span className="tms-driver-card-name">{dispatcher?.name ?? '—'}</span>
          <span className="tms-driver-card-contact">
            {dispatcher?.phone && (
              <a href={`tel:${dispatcher.phone}`} aria-label={`Call dispatcher ${dispatcher.name ?? ''}`.trim()}>
                <Phone size={12} aria-hidden /> {dispatcher.phone}
              </a>
            )}
            {dispatcher?.email && (
              <a href={`mailto:${dispatcher.email}`}>
                <Mail size={12} aria-hidden /> {dispatcher.email}
              </a>
            )}
          </span>
        </div>
      )}
    </section>
  )
}
