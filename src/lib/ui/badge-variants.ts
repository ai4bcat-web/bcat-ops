import { cva, type VariantProps } from 'class-variance-authority'

export const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 whitespace-nowrap',
  {
    variants: {
      variant: {
        default:     'border-sky-200 bg-sky-50 text-sky-700',
        secondary:   'border-slate-200 bg-slate-100 text-slate-600',
        destructive: 'border-red-200 bg-red-50 text-red-700',
        outline:     'border-slate-200 text-slate-700',
        green:       'border-emerald-200 bg-emerald-50 text-emerald-700',
        orange:      'border-amber-200 bg-amber-50 text-amber-700',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export type BadgeVariantProps = VariantProps<typeof badgeVariants>
