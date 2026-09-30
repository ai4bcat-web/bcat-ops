import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { getComplianceDocUrl } from '@/lib/complianceClient'
import { getColor } from '@/lib/driverColors'
import type { ColorKey } from '@/types'
import {
  documentStatusBadge,
  taskStatusBadge,
  severityBadge,
  complianceStatusBadge,
} from '@/lib/complianceStatus'
import type {
  ComplianceDocumentStatus,
  OnboardingTaskStatus,
  AlertSeverity,
  ComplianceStatus,
} from '@/types'

export function DocStatusBadge({ status }: { status: ComplianceDocumentStatus }) {
  const { variant, label } = documentStatusBadge(status)
  return <Badge variant={variant}>{label}</Badge>
}

export function TaskStatusBadge({ status }: { status: OnboardingTaskStatus }) {
  const { variant, label } = taskStatusBadge(status)
  return <Badge variant={variant}>{label}</Badge>
}

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const { variant, label } = severityBadge(severity)
  return <Badge variant={variant}>{label}</Badge>
}

export function ComplianceBadge({ status }: { status?: ComplianceStatus | null }) {
  const { variant, label } = complianceStatusBadge(status)
  return <Badge variant={variant}>{label}</Badge>
}

/** Round initials avatar tinted with the driver's calendar color. */
export function InitialsAvatar({ name, colorKey, size = 30 }: { name: string; colorKey?: ColorKey | null; size?: number }) {
  const initials =
    (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? '').join('') || '?'
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: getColor(colorKey).avatarBg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.38), fontWeight: 600, flexShrink: 0 }}>
      {initials}
    </div>
  )
}

export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const color = pct === 100 ? '#22c55e' : pct >= 60 ? '#1ea8f3' : '#f59e0b'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 8, background: 'var(--ds-bg)', borderRadius: 999, overflow: 'hidden', border: '1px solid var(--ds-border)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 200ms' }} />
      </div>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>
        {value} / {max}
      </span>
    </div>
  )
}

interface CardProps {
  title: string
  sub?: string
  right?: React.ReactNode
  children: React.ReactNode
  noPad?: boolean
}

export function Card({ title, sub, right, children, noPad = false }: CardProps) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{sub}</div>}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
      <div style={noPad ? undefined : { padding: '16px 18px' }}>{children}</div>
    </div>
  )
}

interface PreviewState {
  key: string
  url: string | null
  error: boolean
}

/** Inline document preview (PDF in iframe, images in img). Resolves the presigned URL. */
export function DocumentPreview({ s3Key }: { s3Key: string }) {
  const [{ key, url, error }, setState] = useState<PreviewState>(() => ({ key: s3Key, url: null, error: false }))

  useEffect(() => {
    getComplianceDocUrl(s3Key)
      .then((u) => setState((prev) => (prev.key === s3Key ? { key: s3Key, url: u, error: false } : prev)))
      .catch(() => setState((prev) => (prev.key === s3Key ? { key: s3Key, url: null, error: true } : prev)))
  }, [s3Key])

  if (key !== s3Key || !url) {
    if (key === s3Key && error) return <div style={{ padding: 24, color: 'var(--ds-t3)', fontSize: 13 }}>Could not load preview.</div>
    return <div style={{ padding: 24, color: 'var(--ds-t3)', fontSize: 13 }}>Loading preview…</div>
  }

  const isPdf = /\.pdf($|\?)/i.test(s3Key)
  if (isPdf) {
    return <iframe title="document" src={url} style={{ width: '100%', height: '70vh', border: 'none', borderRadius: 8 }} />
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
      <img src={url} alt="document" style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8 }} />
    </div>
  )
}
