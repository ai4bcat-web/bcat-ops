import { useState, type ReactNode } from 'react'
import { useOnVisible } from '@/hooks/useOnVisible'

/**
 * Mounts `children` only once the KPI strip is final (`enabled`) AND the slot is within 200px
 * of the viewport; until then a fixed-height placeholder keeps the layout still. Sticky: a
 * mounted widget never unmounts. The widgets behind it read the year-to-date load window, so
 * they must stay off the KPI path.
 */
export function LazyWidget({ enabled, minHeight, label, children }: {
  enabled: boolean
  minHeight: number
  label: string
  children: ReactNode
}) {
  const [ref, visible] = useOnVisible('200px')
  const [mounted, setMounted] = useState(false)
  if (!mounted && enabled && visible) setMounted(true)
  if (mounted) return <>{children}</>
  return <div ref={ref} data-testid="lazy-widget" data-widget={label} aria-busy="true" style={{ minHeight }} />
}
