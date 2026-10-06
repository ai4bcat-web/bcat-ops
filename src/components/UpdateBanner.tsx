/**
 * "A new version is available" — shown when the tab is running code older than the server.
 *
 * Deliberately a banner and not an automatic reload: somebody halfway through a load form
 * would lose it, and discarding typing to deliver a nav item nobody was waiting for is a
 * bad trade. It sits out of the way until clicked, and it does not come back once dismissed
 * for this build.
 */
import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useAppUpdate } from '@/hooks/useAppUpdate'

export function UpdateBanner() {
  const { available, reload } = useAppUpdate()
  const [dismissed, setDismissed] = useState(false)

  if (!available || dismissed) return null

  return (
    <div
      role="status"
      style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        zIndex: 60, display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px 10px 16px', borderRadius: 10,
        background: 'var(--ds-t1)', color: 'var(--ds-surface)',
        boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)', fontSize: 13,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <span>A new version of BCAT Ops is available.</span>
      <button
        onClick={reload}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 30, padding: '0 12px', borderRadius: 7, border: 'none',
          background: 'var(--ds-surface)', color: 'var(--ds-t1)',
          fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
        }}
      >
        <RefreshCw size={13} /> Reload
      </button>
      <button
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          display: 'grid', placeItems: 'center', height: 26, width: 26,
          borderRadius: 6, border: 'none', background: 'transparent',
          color: 'var(--ds-surface)', opacity: 0.7, cursor: 'pointer',
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
