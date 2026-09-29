import type { CSSProperties } from 'react'

/** Header/footer button styling shared by file and load panels. */
export const panelBtn = {
  primary: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  } as CSSProperties,
  secondary: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  } as CSSProperties,
  danger: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: '#b91c1c',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  } as CSSProperties,
}
