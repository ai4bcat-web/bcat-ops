import { useEffect, useState } from 'react'

type TmsToken = `--tms-${string}`

/** Computed value of a `--tms-*` token, trimmed; '' when unresolved. `from` defaults to `.tms-shell`, else <body>. */
export function readTmsToken(name: TmsToken, from?: Element | null): string {
  if (typeof document === 'undefined') return ''
  const el = from ?? document.querySelector('.tms-shell') ?? document.body
  return getComputedStyle(el).getPropertyValue(name).trim()
}

function readAll<const N extends readonly TmsToken[]>(names: N): Record<N[number], string> {
  const out = {} as Record<N[number], string>
  for (const name of names) out[name as N[number]] = readTmsToken(name)
  return out
}

/**
 * Token values for JS-only colour consumers (map polylines, SVG fallbacks). Re-resolves
 * when `<html data-tms-theme>` flips.
 */
export function useTmsTokens<const N extends readonly TmsToken[]>(names: N): Record<N[number], string> {
  const key = names.join('|')
  const [values, setValues] = useState(() => readAll(names))
  useEffect(() => {
    const update = () => setValues(readAll(names))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tms-theme'] })
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable identity of `names`
  }, [key])
  return values
}
