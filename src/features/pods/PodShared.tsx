import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { downloadFromUrl } from '@/lib/download'

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
  url, filename, label, tone = 'primary',
}: {
  url: string
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
          await downloadFromUrl(url, filename)
        } catch {
          // download.ts already surfaces a toast; avoid duplicate noise
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
