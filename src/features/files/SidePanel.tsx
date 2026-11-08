import type { ReactNode } from 'react'
import { TmsDrawer } from '@/features/tms/kit/TmsDrawer'

/**
 * The right-hand panel shell used across the Files hub.
 *
 * Extracted so the driver file and the driver editor are visibly the same object —
 * same width, background, header treatment, padding and close affordance. They were
 * built separately (one hand-rolled, one a Radix Sheet with its own white background
 * and tailwind chrome) and read as two different components, which is exactly what
 * looked wrong when opening the editor from a file.
 *
 * Anything that opens beside a file should use this rather than rolling its own.
 */
export function SidePanel({
  title, subtitle, avatar, actions, footer, onClose, children, width = 620, zIndex,
}: {
  title: string
  subtitle?: string
  /** Rendered left of the title — the driver's photo, typically. */
  avatar?: ReactNode
  /** Header buttons, right of the title and left of the close control. */
  actions?: ReactNode
  /** Pinned below the scroll area — save/cancel, delete. */
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
  /**
   * Raise above another panel when one opens over the other. Equal z-indexes stack two
   * dimmed backdrops and make both look broken.
   */
  zIndex?: number
}) {
  const size = width <= 460 ? 'md' : width <= 640 ? 'lg' : 'xl'
  return (
    <TmsDrawer
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      size={size}
      zIndex={zIndex}
      title={avatar ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          {avatar}
          <span>{title}</span>
        </span>
      ) : title}
      description={subtitle}
      headerExtra={actions}
      footer={footer}
    >
      {children}
    </TmsDrawer>
  )
}
