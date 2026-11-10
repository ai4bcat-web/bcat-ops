/**
 * Two grouped columns inside one card: related fields sit together under a small muted subheading
 * ("Load details" | "Quantities"). Each column holds its own flush FieldGrid (spans 6 / 12 only, so a
 * column of half the card still reads as a clean pair). Below ~640 px of card width the columns stack.
 */
import type { ReactNode } from 'react'
import './fieldGrid.css'

export function ColGroups({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="tms-fg-cols" data-testid={testId}>{children}</div>
}

export function ColGroup({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="tms-fg-col" role="group" aria-label={title} data-testid={testId}>
      <h4 className="tms-fg-colhead">{title}</h4>
      {children}
    </section>
  )
}
