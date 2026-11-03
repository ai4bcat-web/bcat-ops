import type { ReactNode } from 'react'
import { Sparkline } from '@/components/charts/sparkline'

interface KpiCardProps {
  label: string
  value: ReactNode
  sublabel?: string
  delta?: string
  deltaDir?: 'up' | 'down' | 'neutral'
  spark?: number[]
  sparkColor?: string
  icon?: ReactNode
  accent?: string
}

export function KpiCard({
  label,
  value,
  sublabel,
  delta,
  deltaDir = 'up',
  spark,
  sparkColor = 'var(--tms-primary)',
  icon,
  accent,
}: KpiCardProps) {
  const deltaColor =
    deltaDir === 'up' ? 'var(--tms-badge-green)' : deltaDir === 'down' ? 'var(--tms-badge-red)' : 'var(--tms-text-2)'

  return (
    <div style={{ background: 'var(--tms-card)', borderRadius: 12, border: '1px solid var(--tms-border)', boxShadow: 'var(--tms-shadow)', position: 'relative', overflow: 'hidden' }}>
      {accent && (
        <div style={{
          position: 'absolute', top: -40, right: -40, width: 140, height: 140,
          borderRadius: '50%', background: accent, filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none',
        }} />
      )}
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
            {label}
          </div>
          {icon && (
            <div style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)',
            }}>
              {icon}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </div>
          {delta != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: deltaColor, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
              {deltaDir === 'up' ? '▲' : deltaDir === 'down' ? '▼' : ''} {delta}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{sublabel}</div>
          {spark && spark.length >= 2 && (
            <Sparkline data={spark} color={sparkColor} width={84} height={28} />
          )}
        </div>
      </div>
    </div>
  )
}
