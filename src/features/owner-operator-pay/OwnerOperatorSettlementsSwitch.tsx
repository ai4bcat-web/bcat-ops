import { Link } from 'react-router-dom'

/**
 * Standard and Amazon settlements are one group: an owner operator is paid as one or the other each week (set per week on the driver's
 * profile, Pay tab), so the two pages read as two views of the same drivers. Same segmented style as the asset views.
 */
export function OwnerOperatorSettlementsSwitch({ active }: { active: 'standard' | 'amazon' }) {
  const style = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', height: 32, padding: '0 14px', borderRadius: 8, textDecoration: 'none',
    border: `1px solid ${on ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
    background: on ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
    color: on ? 'var(--tms-primary)' : 'var(--tms-text-2)',
    fontSize: 13, fontWeight: 600,
  })
  return (
    <nav aria-label="Owner operator settlement views" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      <Link to="/owner-operator-pay" style={style(active === 'standard')} aria-current={active === 'standard' ? 'page' : undefined}>Standard weeks</Link>
      <Link to="/driver-pay" style={style(active === 'amazon')} aria-current={active === 'amazon' ? 'page' : undefined}>Amazon weeks</Link>
    </nav>
  )
}
