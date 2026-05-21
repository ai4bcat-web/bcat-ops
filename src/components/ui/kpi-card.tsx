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
  sparkColor = '#1ea8f3',
  icon,
  accent,
}: KpiCardProps) {
  const deltaColor =
    deltaDir === 'up' ? '#16a34a' : deltaDir === 'down' ? '#dc2626' : 'var(--ds-t2)'

  return (
    <div style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', boxShadow: 'var(--sh-sm)', position: 'relative', overflow: 'hidden' }}>
      {accent && (
        <div style={{
          position: 'absolute', top: -40, right: -40, width: 140, height: 140,
          borderRadius: '50%', background: accent, filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none',
        }} />
      )}
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
            {label}
          </div>
          {icon && (
            <div style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'var(--ds-bg)', border: '1px solid var(--ds-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ds-t2)',
            }}>
              {icon}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </div>
          {delta != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: deltaColor, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
              {deltaDir === 'up' ? '▲' : deltaDir === 'down' ? '▼' : ''} {delta}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{sublabel}</div>
          {spark && spark.length >= 2 && (
            <Sparkline data={spark} color={sparkColor} width={84} height={28} />
          )}
        </div>
      </div>
    </div>
  )
}
