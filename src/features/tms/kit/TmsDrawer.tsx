import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef } from 'react'
import type { ReactNode } from 'react'

export interface TmsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  headerExtra?: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg' | 'xl'
  onInteractOutside?: (event: Event) => void
  className?: string
  children: ReactNode
}

/**
 * Right-docked drawer (Radix dialog into document.body). Self-contained under
 * `.tms-portal`, so it also renders correctly outside `.tms-shell` (legacy calendar).
 */
export function TmsDrawer({
  open,
  onOpenChange,
  title,
  description,
  headerExtra,
  footer,
  size = 'lg',
  onInteractOutside,
  className,
  children,
}: TmsDrawerProps) {
  // The drawer is opened from arbitrary controls (no Radix Trigger), and Radix only restores
  // focus to a Trigger — so remember the opener and hand focus back to it on close.
  const opener = useRef<HTMLElement | null>(null)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tms-portal tms-dialog-overlay" />
        <DialogPrimitive.Content
          className={`tms-portal tms-drawer tms-drawer-${size}${className ? ` ${className}` : ''}`}
          onInteractOutside={onInteractOutside}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            opener.current?.focus()
          }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="tms-drawer-head">
            <div className="tms-drawer-titles">
              <DialogPrimitive.Title className="tms-drawer-title">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="tms-drawer-desc">{description}</DialogPrimitive.Description>
              ) : null}
            </div>
            {headerExtra ? <div className="tms-drawer-extra">{headerExtra}</div> : null}
            <DialogPrimitive.Close className="tms-dialog-close" aria-label="Close">
              <X size={16} />
            </DialogPrimitive.Close>
          </div>
          <div className="tms-drawer-body">{children}</div>
          {footer ? <div className="tms-drawer-foot">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export default TmsDrawer
