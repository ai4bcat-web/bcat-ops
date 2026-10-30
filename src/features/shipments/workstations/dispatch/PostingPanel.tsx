/**
 * P6 — the posting state for the selected shipment.
 *
 * Shows the latest status per board (DAT / Truckstop), a STUB label when the adapter
 * ran in stub mode, and Post / Unpost buttons. A server refusal is surfaced verbatim
 * so a dispatcher sees why a BUILDING shipment cannot be posted yet.
 */
import { useState } from 'react'

import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { postLoad, unpostLoad, type ShipmentPostingRecord } from '@/lib/apiClient'
import { descriptorOf } from '@/lib/integrations/registry'

type ProviderKey = 'DAT' | 'TRUCKSTOP'

const PROVIDERS: ProviderKey[] = ['DAT', 'TRUCKSTOP']

interface PostingPanelProps {
  shipmentId: string
  postings: ShipmentPostingRecord[]
  loading?: boolean
  onChange: () => void
}

export function PostingPanel({ shipmentId, postings, loading, onChange }: PostingPanelProps) {
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  const latestByProvider = latestByProviderOf(postings)

  const handlePost = async (provider: ProviderKey) => {
    setError(null)
    setBusy((prev) => ({ ...prev, [provider]: true }))
    try {
      await postLoad({ shipmentId, providers: [provider] })
      await onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : `${provider} post failed`)
    } finally {
      setBusy((prev) => ({ ...prev, [provider]: false }))
    }
  }

  const handleUnpost = async (provider: ProviderKey) => {
    setError(null)
    setBusy((prev) => ({ ...prev, [provider]: true }))
    try {
      await unpostLoad({ shipmentId, providers: [provider] })
      await onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : `${provider} unpost failed`)
    } finally {
      setBusy((prev) => ({ ...prev, [provider]: false }))
    }
  }

  return (
    <TmsCard title="Postings">
      <div className="space-y-3">
        {PROVIDERS.map((provider) => {
          const latest = latestByProvider[provider]
          const isPosted = latest?.status === 'POSTED'
          const isFailed = latest?.status === 'FAILED'
          const stub = latest?.mode === 'STUB'

          return (
            <div
              key={provider}
              className="tms-dispatch-posting-row flex items-center justify-between gap-3 rounded border p-3"
              data-testid="posting-row"
              data-provider={provider}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{descriptorOf(provider)?.label ?? provider}</span>
                  <TmsBadge tone={isPosted ? 'green' : isFailed ? 'red' : 'gray'}>
                    {latest ? latest.status.replace('_', ' ') : 'Not posted'}
                  </TmsBadge>
                  {stub && (
                    <span className="text-xs tms-badge-stub" data-testid="stub-label">STUB</span>
                  )}
                </div>
                {latest?.postedAt && (
                  <div className="mt-1 text-xs tms-muted">
                    {latest.boardPostingId ? `Board #${latest.boardPostingId} · ` : null}
                    {formatDateTime(latest.postedAt)}
                  </div>
                )}
                {latest?.message && (
                  <div className="mt-1 text-xs tms-muted truncate">{latest.message}</div>
                )}
              </div>

              <TmsButton
                size="sm"
                variant={isPosted ? 'secondary' : 'primary'}
                disabled={loading || busy[provider]}
                onClick={() => { void (isPosted ? handleUnpost(provider) : handlePost(provider)) }}
                data-testid={isPosted ? 'unpost-button' : 'post-button'}
              >
                {busy[provider] ? 'Working…' : isPosted ? 'Unpost' : 'Post'}
              </TmsButton>
            </div>
          )
        })}

        {error && (
          <div className="text-sm tms-text-destructive" data-testid="posting-error">
            {error}
          </div>
        )}
      </div>
    </TmsCard>
  )
}

function latestByProviderOf(postings: ShipmentPostingRecord[]): Record<string, ShipmentPostingRecord> {
  const out: Record<string, ShipmentPostingRecord> = {}
  for (const p of postings) {
    const held = out[p.provider]
    if (!held || String(p.postedAt ?? p.createdAt) > String(held.postedAt ?? held.createdAt)) {
      out[p.provider] = p
    }
  }
  return out
}
