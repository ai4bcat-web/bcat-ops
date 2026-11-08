import type { ReactNode } from 'react'

/** The little key caps MVMNT puts next to shortcuts (F, ↓, ], Enter, Tab, Esc, C). */
export function TmsKeyHint({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <kbd className="tms-key" title={title}>
      {children}
    </kbd>
  )
}

export default TmsKeyHint
