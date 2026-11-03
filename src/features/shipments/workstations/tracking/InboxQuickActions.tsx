/**
 * Quick-action bar above the Inbox composer. Every chip calls an API the shipment
 * Tracking tab already calls; "Mark delivered…" only navigates to where stop actions live.
 */
import { useState } from 'react'
import { CheckCheck, FileImage, Loader2, PhoneCall, Send } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { requestPod, runCheckCallPlan } from '@/lib/apiClient'
import type { LoadCarrierRecord } from '@/types/tms'

export interface InboxQuickActionsProps {
  shipmentId: string
  leg: LoadCarrierRecord | null
  voided: boolean
  onRefresh: () => void | Promise<void>
  onSendTrackingLink: () => void
}

type Busy = 'check-call' | 'pod' | null

export function InboxQuickActions({ shipmentId, leg, voided, onRefresh, onSendTrackingLink }: InboxQuickActionsProps) {
  const [busy, setBusy] = useState<Busy>(null)

  const reason = voided ? 'This shipment is voided.' : !leg ? 'No active leg on this shipment.' : undefined

  async function run(key: Exclude<Busy, null>, call: () => Promise<unknown>, success: string) {
    setBusy(key)
    try {
      await call()
      toast.success(success)
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="tms-quick-actions" data-testid="inbox-quick-actions" role="toolbar" aria-label="Quick actions">
      <button
        type="button"
        className="tms-quick-chip"
        data-testid="quick-check-call"
        disabled={Boolean(reason) || busy != null}
        title={reason}
        onClick={() => void run('check-call', () => runCheckCallPlan({ shipmentId }), 'Check-call plan run')}
      >
        {busy === 'check-call' ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <PhoneCall size={13} aria-hidden />}
        Request check call
      </button>
      <button
        type="button"
        className="tms-quick-chip"
        data-testid="quick-send-link"
        disabled={Boolean(reason) || busy != null}
        title={reason}
        onClick={onSendTrackingLink}
      >
        <Send size={13} aria-hidden />
        Send tracking link
      </button>
      <button
        type="button"
        className="tms-quick-chip"
        data-testid="quick-pod"
        disabled={Boolean(reason) || busy != null}
        title={reason}
        onClick={() => void run('pod', () => requestPod({ shipmentId }), 'POD requested')}
      >
        {busy === 'pod' ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <FileImage size={13} aria-hidden />}
        Request POD
      </button>
      {voided ? (
        <span className="tms-quick-chip" aria-disabled="true" title={reason} data-testid="quick-delivered">
          <CheckCheck size={13} aria-hidden />
          Mark delivered…
        </span>
      ) : (
        <Link className="tms-quick-chip" data-testid="quick-delivered" to={`/tms/shipments/${shipmentId}?tab=stops`}>
          <CheckCheck size={13} aria-hidden />
          Mark delivered…
        </Link>
      )}
    </div>
  )
}
