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
  if (!phone && !own) return null
  return (
    <div className="shrink-0 border-b border-border bg-card">
      {own && <Line label={`Your dispatcher · ${own.name}`} phone={own.phone} primary />}
      {phone && <Line label="Dispatch" phone={phone} primary={!own} />}
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
