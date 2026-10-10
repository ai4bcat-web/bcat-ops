import { MessageSquare, Phone } from 'lucide-react'
import { useDriverProfile } from './useDriverProgram'
import { prettyPhone } from '@/lib/dispatch'

/**
 * The dispatch number, pinned above every driver screen so it is one tap away anywhere
 * on the route. Call and Text open the phone's own apps; nothing here needs the network.
 */
export function DispatchBar() {
  const phone = useDriverProfile()?.dispatchPhone ?? null
  if (!phone) return null
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Dispatch</div>
        <div className="font-mono text-base font-bold tabular-nums text-foreground">{prettyPhone(phone)}</div>
      </div>
      <div className="flex shrink-0 gap-2">
        <a href={`tel:${phone}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
          <Phone className="h-4 w-4" aria-hidden="true" /> Call
        </a>
        <a href={`sms:${phone}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-primary px-3 text-sm font-semibold text-primary">
          <MessageSquare className="h-4 w-4" aria-hidden="true" /> Text
        </a>
      </div>
    </div>
  )
}
