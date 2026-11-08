import { cva, type VariantProps } from 'class-variance-authority'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--tms-radius)] text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--tms-card)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-[color:var(--tms-primary-hover)]',
        destructive: 'bg-[color:var(--tms-badge-red-tint)] text-[color:var(--tms-badge-red)] border border-[color:var(--tms-badge-red)] hover:bg-[color:var(--tms-badge-red-tint)]',
        outline: 'border border-input bg-card text-foreground hover:bg-accent hover:text-foreground',
        secondary: 'bg-muted text-foreground hover:bg-accent',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-5 py-2',
        sm: 'h-9 rounded-[var(--tms-radius)] px-4 text-sm',
        lg: 'h-10 rounded-[var(--tms-radius)] px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>
