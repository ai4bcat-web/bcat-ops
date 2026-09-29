import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { usePodDocuments } from '@/hooks/usePodDocuments'
import { toast } from 'sonner'
import {
  PackageCheck, Search, RefreshCw, Loader2, AlertCircle,
  Settings2, X, CheckCircle2,
} from 'lucide-react'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { PodCard } from './PodCard'
import { PodPreviewDialog } from './PodPreviewDialog'
import { AssignLoadDialog } from './AssignLoadDialog'
import { PodsConnectionForm } from './PodsConnectionForm'
import { assignPod, retryPod } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import type { PodDocument, PodConnectionStatus } from '@/types/pods'

const FILTER_LABELS: Record<string, string> = {
  ALL: 'All',
  ASSIGNED: 'Assigned',
  UNASSIGNED: 'Unassigned',
}

function useFilteredDocs(
  docs: PodDocument[],
  query: string,
  filter: 'ALL' | 'ASSIGNED' | 'UNASSIGNED',
) {
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    return docs.filter((d) => {
      const matchesQuery = !q || [
        d.companyName,
        d.senderName,
        d.senderContact,
        d.referenceNumber,
      ].some((v) => (v ?? '').toLowerCase().includes(q))
      const matchesFilter =
        filter === 'ALL' ? true : filter === 'ASSIGNED' ? !!d.loadId : !d.loadId
      return matchesQuery && matchesFilter
    })
  }, [docs, query, filter])
}

export function PodsPage() {
  const { isAdmin, isOwner } = useAuth()
  const loads = useAppStore((s) => s.loads)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const {
    status,
    statusLoading,
    statusError,
    docs,
    nextToken,
    loading,
    error,
    syncing,
    syncImported,
    syncSkipped,
    syncError,
    refresh,
    refreshStatus,
    loadMore,
    syncAll,
    cancelSync,
    patchDoc,
  } = usePodDocuments()

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'ASSIGNED' | 'UNASSIGNED'>('ALL')
  const [previewDoc, setPreviewDoc] = useState<PodDocument | null>(null)
  const [assignDoc, setAssignDoc] = useState<PodDocument | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [configuredOverride, setConfiguredOverride] = useState<PodConnectionStatus | null>(null)

  const activeStatus = configuredOverride ?? status

  const filteredDocs = useFilteredDocs(docs, query, filter)

  const handleAssign = async (doc: PodDocument, loadId: string | null) => {
    try {
      const res = await assignPod({ id: doc.id, loadId, expectedVersion: doc.version })
      patchDoc(doc.id, () => res.item)
      toast.success(loadId ? 'POD assigned to load' : 'POD unassigned')
    } catch (err) {
      toast.error(graphqlErrorText(err) || (loadId ? 'Assign failed' : 'Unassign failed'))
      // Any failure may mean the document moved on (version conflict, load gone):
      // pull the latest state so the next attempt uses a current version.
      await refresh()
    }
  }

  const handleRetry = async (doc: PodDocument) => {
    try {
      const res = await retryPod({ id: doc.id })
      patchDoc(doc.id, () => res.item)
      toast.success('Retry queued')
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Retry failed')
    }
  }

  const openLoad = (loadId: string) => setSelectedLoad(loadId, 'view')

  const canConfigure = isAdmin || isOwner
  const configured = activeStatus?.configured ?? false
  const connectionLabel = configured
    ? `Connected · ${activeStatus?.companyName || activeStatus?.clientId || 'JobsDone'}`
    : 'Not connected'

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ padding: '20px 32px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <PackageCheck size={22} style={{ color: 'var(--ds-blue)' }} />
              <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ds-t1)', margin: 0 }}>PODs</h1>
            </div>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 999,
                background: configured ? '#f0fdf4' : '#fef2f2',
                color: configured ? '#15803d' : '#b91c1c',
              }}
            >
              {configured ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
              {connectionLabel}
            </span>
            <div style={{ flex: 1 }} />
            {configured && (
              <button
                onClick={() => syncAll()}
                disabled={syncing}
                title="Sync the full JobsDone feed now"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid var(--ds-border)',
                  background: 'var(--ds-surface)',
                  color: 'var(--ds-t2)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: syncing ? 'wait' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {syncing ? `Syncing… ${syncImported}` : 'Sync JobsDone'}
              </button>
            )}
            {canConfigure && (
              <button
                onClick={() => setShowConfig((v) => !v)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid var(--ds-border)',
                  background: 'var(--ds-surface)',
                  color: 'var(--ds-t2)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <Settings2 size={14} /> {showConfig ? 'Close' : 'Configure'}
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search company, sender, reference…"
                style={{
                  height: 32,
                  width: '100%',
                  borderRadius: 8,
                  border: '1px solid var(--ds-border)',
                  padding: '0 10px 0 30px',
                  fontSize: 13,
                  background: 'var(--ds-surface)',
                  color: 'var(--ds-t1)',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                }}
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {(['ALL', 'ASSIGNED', 'UNASSIGNED'] as const).map((key) => {
              const active = filter === key
              const count = docs.filter((d) =>
                key === 'ALL' ? true : key === 'ASSIGNED' ? !!d.loadId : !d.loadId,
              ).length
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 30,
                    padding: '0 12px',
                    borderRadius: 8,
                    border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                    background: active ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)',
                    color: active ? 'var(--ds-blue)' : 'var(--ds-t2)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {FILTER_LABELS[key]}
                  <span style={{ fontSize: 11.5, color: 'var(--ds-t3)', fontWeight: 500 }}>{count}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '20px 32px 40px', maxWidth: 1400, margin: '0 auto' }}>
        {statusLoading && docs.length === 0 && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
            <Loader2 size={14} className="animate-spin" /> Loading connection status…
          </div>
        )}

        {statusError && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3 mb-4">
            {statusError}
          </div>
        )}

        {showConfig && canConfigure && (
          <div
            className="mb-4"
            style={{
              border: '1px solid var(--ds-border)',
              borderRadius: 12,
              background: 'var(--ds-surface)',
              padding: 18,
              boxShadow: 'var(--sh-sm)',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', marginBottom: 12 }}>JobsDone connection</div>
            <PodsConnectionForm onConfigured={(s) => { setShowConfig(false); setConfiguredOverride(s); void refreshStatus(); }} />
          </div>
        )}

        {!configured && !statusLoading && (
          <div
            style={{
              border: '1px solid var(--ds-border)',
              borderRadius: 12,
              background: 'var(--ds-surface)',
              padding: 24,
              textAlign: 'center',
              boxShadow: 'var(--sh-sm)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>JobsDone is not connected</div>
            <p style={{ fontSize: 13, color: 'var(--ds-t3)', marginTop: 8, lineHeight: 1.5 }}>
              Ask an admin to add the JobsDone client ID and API key. PODs cannot be imported until the connection is configured.
            </p>
            {canConfigure && (
              <button
                onClick={() => setShowConfig(true)}
                className="mt-4 inline-flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium"
              >
                <Settings2 size={14} /> Connect JobsDone
              </button>
            )}
          </div>
        )}

        {configured && (
          <>
            {syncing && (
              <div className="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Syncing JobsDone feed… {syncImported > 0 ? `${syncImported} imported` : ''}
                </span>
                <button onClick={cancelSync} className="font-semibold hover:underline">Cancel</button>
              </div>
            )}
            {!syncing && syncSkipped > 0 && (
              <div className="mb-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {syncSkipped} JobsDone {syncSkipped === 1 ? 'row was' : 'rows were'} skipped because {syncSkipped === 1 ? 'it' : 'they'} could not be read or belonged to another account. Nothing from {syncSkipped === 1 ? 'it' : 'them'} was imported.
              </div>
            )}
            {syncError && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                Sync failed: {syncError}
              </div>
            )}
            {error && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            {(query || filter !== 'ALL') && nextToken && (
              <div className="mb-3 text-xs text-muted-foreground">
                Filtering only the documents already loaded. Use “Load more” to search older PODs.
              </div>
            )}

            {filteredDocs.length === 0 && !loading ? (
              <div
                style={{
                  border: '1px dashed var(--ds-border)',
                  borderRadius: 12,
                  background: 'var(--ds-surface)',
                  padding: 40,
                  textAlign: 'center',
                  color: 'var(--ds-t3)',
                }}
              >
                {docs.length === 0 ? 'No PODs yet. Run Sync JobsDone to import the feed.' : 'No PODs match the current filters.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                {filteredDocs.map((doc) => (
                  <PodCard
                    key={doc.id}
                    doc={doc}
                    onPreview={setPreviewDoc}
                    onAssign={setAssignDoc}
                    onUnassign={(d) => {
                      if (confirm('Unassign this POD from its load?')) {
                        handleAssign(d, null)
                      }
                    }}
                    onRetry={handleRetry}
                    onViewLoad={openLoad}
                  />
                ))}
              </div>
            )}

            {nextToken && (
              <div className="mt-6 text-center">
                <button
                  onClick={() => loadMore()}
                  disabled={loading}
                  className="inline-flex items-center gap-2 h-9 px-5 rounded-md border text-sm font-semibold disabled:opacity-50"
                >
                  {loading && <Loader2 size={14} className="animate-spin" />}
                  Load more
                </button>
              </div>
            )}

            {loading && docs.length === 0 && (
              <div className="text-sm text-muted-foreground mt-4 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Loading PODs…
              </div>
            )}
          </>
        )}
      </div>

      {previewDoc && <PodPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
      {assignDoc && (
        <AssignLoadDialog
          doc={assignDoc}
          loads={loads}
          onAssign={(d, loadId) => handleAssign(d, loadId)}
          onUnassign={(d) => handleAssign(d, null)}
          onClose={() => setAssignDoc(null)}
        />
      )}
      <LoadDrawer />
    </div>
  )
}
