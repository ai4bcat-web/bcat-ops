import type { ReactNode } from 'react'
import { TmsCard } from '@/features/tms/kit'
import './profiles.css'

/** One card per topic on a profile. Title on the left, the edit action on the right. */
export function ProfileSection({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      <TmsCard title={title} actions={action}>{children}</TmsCard>
    </div>
  )
}

/** Label / value rows that show a muted dash for a blank, so nothing looks missing by accident. */
export function ProfileRows({ rows }: { rows: Array<{ label: string; value: ReactNode; hint?: string }> }) {
  return (
    <div className="pf-rows">
      {rows.map((r) => (
        <div className="pf-row" key={r.label}>
          <div className="pf-row-main">
            <div className="pf-row-sub">{r.label}</div>
            <div className="pf-row-title">{r.value === '' || r.value == null ? <span className="tms-muted">—</span> : r.value}</div>
            {r.hint ? <div className="pf-row-sub">{r.hint}</div> : null}
          </div>
        </div>
      ))}
    </div>
  )
}
