import { MessageSquare, Phone } from 'lucide-react'
import { useDriverProfile } from './useDriverProgram'
import { prettyPhone } from '@/lib/dispatch'

/**
 * Who to call, pinned above every driver screen so it is one tap away anywhere on the
 * route. A driver with their own dispatcher on file (Dispatch settings → dispatcher
 * contacts) sees that person first; the main dispatch line sits under it. Call and Text
 * open the phone's own apps; nothing here needs the network.
 */
export function DispatchBar() {
  const profile = useDriverProfile()
  const phone = profile?.dispatchPhone ?? null
  const own = profile?.dispatcher ?? null
  const work = profile?.workPhone ?? null
  if (!phone && !own && !work) return null
  return (
    <div className="shrink-0 border-b border-border bg-card">
      {work && <WorkPhoneLine number={work.number} label={work.label} truckNumber={work.truckNumber} />}
      {own && <Line label={`Your dispatcher · ${own.name}`} phone={own.phone} primary={!work} />}
      {phone && <Line label="Dispatch" phone={phone} primary={!own && !work} />}
    </div>
  )
}

/** Display only: the number dispatch reaches the driver on while they are in this truck. */
function WorkPhoneLine({ number, label, truckNumber }: { number: string; label: string | null; truckNumber: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-1.5" data-testid="driver-work-phone">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Work phone{truckNumber ? ` · truck ${truckNumber}` : ''}{label ? ` · ${label}` : ''}
        </div>
        <a href={`tel:${number}`} className="font-mono text-sm font-bold tabular-nums text-foreground">{prettyPhone(number)}</a>
      </div>
    </div>
  )
}

function Line({ label, phone, primary }: { label: string; phone: string; primary: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 px-4 ${primary ? 'py-2' : 'border-t border-border/60 py-1.5'}`}>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`font-mono font-bold tabular-nums text-foreground ${primary ? 'text-base' : 'text-sm'}`}>{prettyPhone(phone)}</div>
      </div>
      <div className="flex shrink-0 gap-2">
        <a href={`tel:${phone}`} className={`inline-flex items-center gap-1.5 rounded-lg px-3 text-sm font-semibold ${primary ? 'h-10 bg-primary text-primary-foreground' : 'h-8 border border-primary text-primary'}`}>
          <Phone className="h-4 w-4" aria-hidden="true" /> Call
        </a>
        <a href={`sms:${phone}`} className={`inline-flex items-center gap-1.5 rounded-lg border border-primary px-3 text-sm font-semibold text-primary ${primary ? 'h-10' : 'h-8'}`}>
          <MessageSquare className="h-4 w-4" aria-hidden="true" /> Text
        </a>
      </div>
    </div>
  )
}
