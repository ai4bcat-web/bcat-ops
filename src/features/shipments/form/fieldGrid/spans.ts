import { Children, isValidElement, type ReactNode } from 'react'
import { narrowSpanOf } from './rowsOf'

/** Spans of the direct children that declare one (`span` prop); other children (datalists, toolbars) are not fields. */
export function spansOfChildren(children: ReactNode): { wide: number[]; narrow: number[] } {
  const wide: number[] = []
  const narrow: number[] = []
  for (const c of Children.toArray(children)) {
    if (!isValidElement(c)) continue
    const p = c.props as { span?: unknown; narrow?: unknown }
    if (typeof p.span !== 'number') continue
    wide.push(p.span)
    narrow.push(narrowSpanOf(p.span, typeof p.narrow === 'number' ? p.narrow : undefined))
  }
  return { wide, narrow }
}
