/** The one 12-column grid every card, the header strip, the Bill To panel and the rail use (feedback 10). */
import { useEffect, type ReactNode } from 'react'
import { rowsOf } from './rowsOf'
import { spansOfChildren } from './spans'
import './fieldGrid.css'

export function FieldGrid({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- the condition is a build-time constant
    useEffect(() => {
      const { wide, narrow } = spansOfChildren(children)
      if (wide.length && (!rowsOf(wide).ok || !rowsOf(narrow).ok)) console.warn('[FieldGrid] a row does not sum to 12', { wide, narrow })
    })
  }
  return <div className={`tms-fg${className ? ` ${className}` : ''}`} data-testid={testId}>{children}</div>
}
