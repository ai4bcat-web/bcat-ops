import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
SheetOverlay.displayName = 'SheetOverlay'

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'right' | 'left' }
>(({ className, children, side = 'right', ...props }, ref) => (
  <DialogPrimitive.Portal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 h-full w-full max-w-[560px] bg-white shadow-2xl flex flex-col',
        'data-[state=open]:animate-in data-[state=closed]:animate-out duration-200',
        side === 'right'
          ? 'right-0 top-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right'
          : 'left-0 top-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
SheetContent.displayName = 'SheetContent'

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-between px-8 py-5 border-b border-slate-200 flex-shrink-0 min-h-[64px] bg-white', className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold', className)} {...props} />
}

function SheetDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex-1 overflow-y-auto px-8 py-6 space-y-5', className)} {...props} />
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-3 px-8 py-5 border-t border-slate-200 bg-slate-50/50 flex-shrink-0 min-h-[72px]', className)}
      {...props}
    />
  )
}

function SheetCloseButton() {
  return (
    <SheetClose className="rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring">
      <X className="size-5" />
      <span className="sr-only">Close</span>
    </SheetClose>
  )
}

export {
  Sheet, SheetTrigger, SheetClose, SheetContent,
  SheetHeader, SheetTitle, SheetDescription, SheetBody, SheetFooter, SheetCloseButton,
}
