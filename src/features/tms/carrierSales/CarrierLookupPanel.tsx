/**
 * Step AS — the MC / DOT lookup result on Carrier Sales: MyCarrierPackets' PreviewCarrier matched against
 * our directory, rendered as the shared CarrierLookupCard. Used for the page-level lookup and for an
 * offer's carrier in the Offers hub. Sending the setup packet goes to the addresses MCP returns (ticked
 * in the card's recipient checklist) and is logged on the Carrier row, the audit and the load's thread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CarrierLookupCard } from '@/features/carriers/lookup/CarrierLookupCard'
import { useCarriers } from '@/hooks/useCarriers'
import { mcpAddCarrier, mcpPreviewCarrier, mcpSendInvite } from '@/lib/apiClient'
import type { McpLookupResult } from '@/lib/apiClient'
import { matchDirectoryCarrier } from '@/lib/integrations/mcpReview'
import type { LookupDirectoryRow } from '@/features/carriers/lookup/lookupModel'

export interface LookupRef { mcNumber?: string; dotNumber?: string }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

export function CarrierLookupPanel({ lookup, shipmentId, loadId, carrierName, onCover, onChanged, nowIso }: {
  lookup: LookupRef
  shipmentId?: string
  loadId?: string
  /** Heading when MCP has no record and the directory has none either. */
  carrierName?: string
  onCover?: (carrier: LookupDirectoryRow) => void
  onChanged?: () => void
  /** Pin "now" (tests). Defaults to the time the panel mounted. */
  nowIso?: string
}) {
  const { carriers, loading: carriersLoading, error: carriersError, refresh } = useCarriers()
  const [result, setResult] = useState<McpLookupResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mountedAt] = useState(() => new Date().toISOString())
  const key = `${lookup.mcNumber ?? ''}|${lookup.dotNumber ?? ''}`
  const asked = useRef<string | null>(null)

  const load = useCallback(() => {
    mcpPreviewCarrier(lookup)
      .then((r) => { setResult(r); setFailure(null) })
      .catch((e: unknown) => setFailure(messageOf(e)))
  // The ref is identified by `key`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (asked.current === key) return
    asked.current = key
    void Promise.resolve().then(load)
  }, [key, load])

  const carrier = useMemo(() => {
    const identity = result?.card?.identity ?? { mcNumber: lookup.mcNumber, dotNumber: lookup.dotNumber }
    const hit = matchDirectoryCarrier(carriers, { identity })
    return hit && hit.by !== 'NAME' ? hit.carrier : null
  }, [carriers, result, lookup.mcNumber, lookup.dotNumber])

  const send = async (emails: string[]) => {
    setBusy(true)
    try {
      const card = result?.card
      const out = await mcpSendInvite({
        ...lookup,
        emails,
        carrierId: carrier?.id,
        carrierName: card?.identity.legalName ?? carrier?.name ?? carrierName,
        shipmentId,
        loadId,
        ensureCarrier: true,
      })
      if (out.sent) toast.success(out.message)
      else toast.info(out.message)
      void refresh()
      load()
      onChanged?.()
    } catch (e) { toast.error(messageOf(e)) } finally { setBusy(false) }
  }

  const add = async () => {
    setBusy(true)
    try {
      await mcpAddCarrier(lookup)
      toast.success('Added to the directory as Pending')
      void refresh()
      onChanged?.()
    } catch (e) { toast.error(messageOf(e)) } finally { setBusy(false) }
  }

  if (failure) return <p className="tms-field-error" data-testid="cs-lookup-error">{failure}</p>
  if (!result || carriersLoading) return <p className="tms-muted" style={{ fontSize: 13 }} data-testid="cs-lookup-loading">Looking up…</p>
  if (carriersError) return <p className="tms-field-error" data-testid="cs-lookup-error">Could not read our carrier directory: {carriersError}</p>

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {result.mode === 'LIVE' && !result.card && !carrier ? (
        <p className="tms-muted" style={{ fontSize: 13, margin: 0 }} data-testid="cs-lookup-none">MyCarrierPackets has no record of that number, and it is not in our directory.</p>
      ) : null}
      {(result.card || carrier || result.mode === 'STUB') ? (
        <CarrierLookupCard
          card={result.card}
          mode={result.mode}
          carrier={carrier}
          nowIso={nowIso ?? mountedAt}
          heading={carrierName}
          busy={busy}
          onSendPacket={send}
          onAddToDirectory={add}
          onCover={onCover}
          testId="cs-lookup-card"
        />
      ) : null}
    </div>
  )
}
