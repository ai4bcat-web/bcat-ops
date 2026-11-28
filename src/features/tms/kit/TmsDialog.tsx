import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface TmsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** Extra classes on the content box, e.g. a wider max-width. */
  className?: string
  /**
   * Stacking order of the overlay (the box sits one above). Needed when the dialog opens over a drawer: the drawer's own
   * overlay and panel are at 60/61, so a dialog left at its default is dimmed by them and cannot be clicked.
   */
  zIndex?: number
}

/**
 * Radix dialog rendered into document.body — outside `.tms-shell` — so the overlay and
 * the content carry `tms-portal`, which is where the dark tokens and surfaces live.
 */
export function TmsDialog({ open, onOpenChange, title, description, children, footer, className, zIndex }: TmsDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tms-portal tms-dialog-overlay" style={zIndex === undefined ? undefined : { zIndex }} />
        <DialogPrimitive.Content
          className={`tms-portal tms-dialog-content${className ? ` ${className}` : ''}`}
          style={zIndex === undefined ? undefined : { zIndex: zIndex + 1 }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="tms-dialog-head">
            <DialogPrimitive.Title className="tms-dialog-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="tms-dialog-close" aria-label="Close">
              <X size={16} />
            </DialogPrimitive.Close>
          </div>
          {description ? (
            <DialogPrimitive.Description className="tms-dialog-desc">{description}</DialogPrimitive.Description>
          ) : null}
          <div className="tms-dialog-body">{children}</div>
          {footer ? <div className="tms-dialog-foot">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export default TmsDialog
