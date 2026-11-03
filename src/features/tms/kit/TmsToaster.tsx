import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'

/** A phone-sized viewport, read once at mount (nobody resizes a phone). */
function isPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches === true
}

function readTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-tms-theme') === 'dark' ? 'dark' : 'light'
}

function useHtmlTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tms-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

const VARS = {
  '--normal-bg': 'var(--tms-card)',
  '--normal-text': 'var(--tms-text)',
  '--normal-border': 'var(--tms-border)',
  '--success-bg': 'var(--tms-badge-green-tint)',
  '--success-text': 'var(--tms-text)',
  '--success-border': 'var(--tms-badge-green)',
  '--error-bg': 'var(--tms-badge-red-tint)',
  '--error-text': 'var(--tms-text)',
  '--error-border': 'var(--tms-badge-red)',
  '--warning-bg': 'var(--tms-badge-orange-tint)',
  '--warning-text': 'var(--tms-text)',
  '--warning-border': 'var(--tms-badge-orange)',
  '--info-bg': 'var(--tms-badge-blue-tint)',
  '--info-text': 'var(--tms-text)',
  '--info-border': 'var(--tms-badge-blue)',
} as CSSProperties

/**
 * App-wide toaster. Themed card toasts everywhere except `/driver/*` (the dark driver PWA
 * keeps sonner's own look until S3).
 */
export function TmsToaster() {
  const { pathname } = useLocation()
  const theme = useHtmlTheme()
  const position = isPhone() ? 'top-center' : 'bottom-right'
  if (pathname.startsWith('/driver')) return <Toaster position={position} richColors />
  return <Toaster className="tms-portal" position={position} richColors={false} theme={theme} style={VARS} />
}

export default TmsToaster
