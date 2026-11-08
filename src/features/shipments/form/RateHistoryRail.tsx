/**
 * Rate history in the summary rail (feedback 18), directly under the Money block. The SAME
 * `RateHistoryCard` body (same cache, same lane intelligence and DAT reads, same "Use" path and
 * `card-rateHistory-*` test ids) inside a collapsible block. Open/closed is remembered per user in
 * localStorage; below 1280 px the rail is a bottom sheet and the block starts collapsed there.
 */
import { ChevronDown } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { useAuthUser } from '@/hooks/useAuth'
import type { CardProps } from './cards/cardRegistry'
import { railOpenKey, readRailOpen } from './railOpen'

export function RateHistoryRail({ common, Body }: { common: CardProps; Body: ComponentType<CardProps> }) {
  const user = useAuthUser()?.email ?? ''
  const [open, setOpen] = useState(() => readRailOpen(user, typeof window === 'undefined' || window.innerWidth >= 1280))
  const toggle = () => {
    setOpen((o) => {
      try { localStorage.setItem(railOpenKey(user), o ? 'closed' : 'open') } catch { /* not remembered */ }
      return !o
    })
  }
  return (
    <section className="tms-rail-block tms-rail-rh" data-testid="rail-rate-history" aria-label="Rate history">
      <h2 className="tms-rail-h">
        <button type="button" className="tms-rail-rh-toggle" data-testid="rail-rate-history-toggle" aria-expanded={open} onClick={toggle}>
          Rate history <ChevronDown size={12} aria-hidden="true" data-open={open} />
        </button>
      </h2>
      {open ? <Body {...common} /> : null}
    </section>
  )
}
