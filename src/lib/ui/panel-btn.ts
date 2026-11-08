import type { CSSProperties } from 'react'

/** Header/footer button styling shared by file and load panels. */
export const panelBtn = {
  primary: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: 'none', background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  } as CSSProperties,
  secondary: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-text-2)',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  } as CSSProperties,
  danger: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-badge-red)',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  } as CSSProperties,
}
