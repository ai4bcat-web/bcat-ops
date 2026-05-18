import { useExpenses } from '@/hooks/useExpenses'
import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import type { ExpenseCategory } from '@/types/expense'

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  fuel:        'Fuel',
  maintenance: 'Maintenance',
  insurance:   'Insurance',
  tolls:       'Tolls',
  other:       'Other',
}

const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  fuel:        'bg-sky-50 text-sky-700 border-sky-200',
  maintenance: 'bg-amber-50 text-amber-700 border-amber-200',
  insurance:   'bg-violet-50 text-violet-700 border-violet-200',
  tolls:       'bg-slate-50 text-slate-600 border-slate-200',
  other:       'bg-slate-50 text-slate-600 border-slate-200',
}

function cents(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n / 100)
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function ExpensesPage() {
  const { expenses } = useExpenses()
  const trucks = useAppStore((s) => s.equipment.filter((e) => e.type === 'truck'))

  const total = expenses.reduce((sum, e) => sum + e.amount, 0)
  const sorted = [...expenses].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="max-w-[1200px] mx-auto px-8 py-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Expenses</h1>
          <p className="text-sm text-slate-500 mt-0.5">Fuel, maintenance, and operating costs</p>
        </div>
        <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm px-5 py-3 text-right">
          <div className="text-xs text-slate-500 uppercase tracking-wide font-medium">Total (all time)</div>
          <div className="text-2xl font-semibold text-foreground mt-0.5">{cents(total)}</div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Date</TableHead>
              <TableHead>Truck</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-16 text-center text-slate-400 text-sm">
                  No expenses recorded yet
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((expense) => {
                const truck = trucks.find((t) => t.id === expense.truckId)
                return (
                  <TableRow key={expense.id}>
                    <TableCell className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                      {shortDate(expense.date)}
                    </TableCell>
                    <TableCell className="text-sm font-medium text-foreground">
                      {truck ? `#${truck.unitNumber}` : <span className="text-slate-300">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={CATEGORY_COLORS[expense.category]}>
                        {CATEGORY_LABELS[expense.category]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {expense.vendor ?? <span className="text-slate-300">—</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[240px] truncate">
                      {expense.description ?? <span className="text-slate-300">—</span>}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-foreground tabular-nums">
                      {cents(expense.amount)}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
