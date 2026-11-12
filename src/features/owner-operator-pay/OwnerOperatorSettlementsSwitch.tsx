export type SettlementsView = 'standard' | 'amazon'

/**
 * One Owner Operator Settlements page, two views of the same drivers: an owner operator is paid as one or the other each week (set per
 * week on the driver's profile, Pay tab). Same segmented style as the asset views; it flips the view in place and keeps the week.
 * A view the person has no page grant for is not offered.
 */
export function OwnerOperatorSettlementsSwitch({ active, onChange, canStandard = true, canAmazon = true }: {
  active: SettlementsView
  onChange: (view: SettlementsView) => void
  canStandard?: boolean
  canAmazon?: boolean
}) {
  if (!(canStandard && canAmazon)) return null
  const style = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', height: 32, padding: '0 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${on ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
    background: on ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
    color: on ? 'var(--tms-primary)' : 'var(--tms-text-2)',
    fontSize: 13, fontWeight: 600,
  })
  return (
    <nav aria-label="Owner operator settlement views" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      <button type="button" style={style(active === 'standard')} aria-current={active === 'standard' ? 'page' : undefined} onClick={() => onChange('standard')}>Standard weeks</button>
      <button type="button" style={style(active === 'amazon')} aria-current={active === 'amazon' ? 'page' : undefined} onClick={() => onChange('amazon')}>Amazon weeks</button>
    </nav>
  )
}
