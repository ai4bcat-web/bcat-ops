/**
 * Step AS — Carrier Sales' MC lookup: type an MC or DOT, see at once whether the carrier is set up with us
 * (and active), where its MyCarrierPackets packet stands, and what MCP says about it; then send the setup
 * packet, add it to the directory or cover a load with it. Names are not looked up here (MCP has no name search).
 */
import { useState } from 'react'
import { Search } from 'lucide-react'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { TmsButton, TmsCard, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { parseSearch } from '@/lib/integrations/mcpReview'
import { CarrierLookupPanel } from './CarrierLookupPanel'
import type { LookupRef } from './CarrierLookupPanel'

export function CarrierLookup({ needsCover, nowIso, onCovered }: { needsCover: readonly ShipmentListRow[]; nowIso?: string; onCovered?: () => void }) {
  const [typed, setTyped] = useState('')
  const [lookup, setLookup] = useState<LookupRef | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [coverId, setCoverId] = useState('')
  const [cover, setCover] = useState<{ row: ShipmentListRow; query: string } | null>(null)

  const submit = () => {
    const parsed = parseSearch(typed)
    if (parsed.kind === 'MC' || parsed.kind === 'DOT') {
      setHint(null)
      setLookup({ ...(parsed.mcNumber ? { mcNumber: parsed.mcNumber } : {}), ...(parsed.dotNumber ? { dotNumber: parsed.dotNumber } : {}) })
    } else {
      setLookup(null)
      setHint(parsed.kind === 'NAME' ? 'Enter an MC or DOT number: MyCarrierPackets looks carriers up by number.' : null)
    }
  }

  const target = needsCover.find((r) => r.id === coverId) ?? needsCover[0] ?? null

  return (
    <TmsCard title="Carrier lookup">
      <div style={{ display: 'grid', gap: 8 }} data-testid="cs-carrier-lookup">
        <form style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} role="search" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <TmsInput aria-label="Carrier MC or DOT" data-testid="cs-lookup-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="MC 274623 or DOT 1234567" style={{ minWidth: 260 }} />
          <TmsButton type="submit" size="sm" variant="primary" disabled={!typed.trim()} data-testid="cs-lookup-go"><Search size={13} /> Look up</TmsButton>
          {needsCover.length > 0 && lookup ? (
            <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
              <span className="tms-muted">Cover load</span>
              <TmsSelect aria-label="Load to cover" value={target?.id ?? ''} onChange={(e) => setCoverId(e.target.value)}>
                {needsCover.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
              </TmsSelect>
            </label>
          ) : null}
        </form>
        {hint ? <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>{hint}</p> : null}
        {lookup ? (
          <CarrierLookupPanel
            key={`${lookup.mcNumber ?? ''}|${lookup.dotNumber ?? ''}`}
            lookup={lookup}
            nowIso={nowIso}
            onCover={target ? () => setCover({ row: target, query: lookup.mcNumber ? `MC ${lookup.mcNumber.replace(/^MC/i, '')}` : `DOT ${lookup.dotNumber ?? ''}` }) : undefined}
          />
        ) : null}
      </div>
      {cover ? (
        <CoverCarrierDialog shipmentId={cover.row.id} shipmentNumber={cover.row.number} initialQuery={cover.query} onClose={() => setCover(null)} onCovered={() => { onCovered?.() }} />
      ) : null}
    </TmsCard>
  )
}
