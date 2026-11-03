import { cva, type VariantProps } from 'class-variance-authority'

export const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 whitespace-nowrap',
  {
    variants: {
      variant: {
        default:     'border-[color:var(--tms-primary)] bg-[color:var(--tms-primary-tint)] text-[color:var(--tms-primary-ink)]',
        secondary:   'border-border bg-muted text-muted-foreground',
        destructive: 'border-[color:var(--tms-badge-red)] bg-[color:var(--tms-badge-red-tint)] text-[color:var(--tms-badge-red)]',
        outline:     'border-border text-foreground',
        green:       'border-[color:var(--tms-badge-green)] bg-[color:var(--tms-badge-green-tint)] text-[color:var(--tms-badge-green)]',
        orange:      'border-[color:var(--tms-badge-orange)] bg-[color:var(--tms-badge-orange-tint)] text-[color:var(--tms-badge-orange)]',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export type BadgeVariantProps = VariantProps<typeof badgeVariants>
