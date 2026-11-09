import { Link } from 'react-router-dom'

/**
 * Asset documents and Fleet are one section of the Fleet manager: this switch sits at the top of both pages, in the same
 * segmented style as the Trucks / Trailers tabs, so they read as two views of the same assets.
 */
export function AssetPagesSwitch({ active }: { active: 'documents' | 'fleet' }) {
  const style = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', height: 32, padding: '0 14px', borderRadius: 8, textDecoration: 'none',
    border: `1px solid ${on ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
    background: on ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
    color: on ? 'var(--tms-primary)' : 'var(--tms-text-2)',
    fontSize: 13, fontWeight: 600,
  })
  return (
    <nav aria-label="Asset views" style={{ display: 'flex', gap: 8 }}>
      <Link to="/truck-docs" style={style(active === 'documents')} aria-current={active === 'documents' ? 'page' : undefined}>Documents</Link>
      <Link to="/trucks" style={style(active === 'fleet')} aria-current={active === 'fleet' ? 'page' : undefined}>Fleet</Link>
    </nav>
  )
}
