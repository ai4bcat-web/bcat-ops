import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { downloadPodAsPdf } from '@/lib/podDownload'
import { getPodAssets } from '@/lib/podsClient'

export function PodActionBtn({
  onClick,
  icon,
  label,
  danger = false,
}: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)',
        color: danger ? '#dc2626' : 'var(--ds-t2)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {icon} {label}
    </button>
  )
}

/**
 * `tone` separates the copy people should take from the one they should not.
 *
 * The enhanced scan is the readable document — deskewed, cleaned, always JPEG — and it is
 * what goes to a broker or to OTR. The original is the raw phone photo, kept because it is
 * the evidence of what actually arrived, but handing it to anyone is a mistake. So the
 * enhanced copy is the primary action and the original is deliberately quiet.
 */
export function PodDownloadBtn({
  podId, variant, filename, label, tone = 'primary',
}: {
  /** Re-signed at click, never carried from when the row was opened. See below. */
  podId: string
  variant: 'enhanced' | 'original'
  filename: string
  label: string
  tone?: 'primary' | 'muted'
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      onClick={async () => {
        setBusy(true)
        try {
          /*
           * Sign the URL now, not when the row was expanded.
           *
           * A presigned URL lasts fifteen minutes. A POD list that had been open longer
           * than that handed the browser a dead link, and S3 answers an expired signature
           * with a 403 that carries no CORS headers — so the browser reports it as
           * "Failed to fetch", which names neither the cause nor the fix. One extra call
           * on a button somebody presses occasionally is a cheap way to never see it.
           */
          const assets = await getPodAssets(podId)
          const url = variant === 'enhanced' ? assets.enhancedUrl : assets.originalUrl
          if (!url) {
            toast.error(
              variant === 'enhanced'
                ? 'There is no cleaned copy of this POD yet'
                : 'This POD has no stored file',
            )
            return
          }
          // A POD leaves here for a broker or OTR, where one PDF is the expected form.
          await downloadPodAsPdf(url, filename)
        } catch (err) {
          // Nothing below this toasts, so a swallowed failure read as "the button does
          // nothing" — which is exactly how the broken enhanced download presented.
          toast.error(err instanceof Error ? err.message : 'Could not download this POD')
        } finally {
          setBusy(false)
        }
      }}
      disabled={busy}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)',
        color: tone === 'primary' ? 'var(--ds-blue)' : 'var(--ds-t3)',
        fontSize: 12,
        fontWeight: tone === 'primary' ? 600 : 500,
        cursor: busy ? 'wait' : 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      {label}
    </button>
  )
}
