import { useTrucks } from '@/hooks/useTrucks'
import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { Truck } from 'lucide-react'

export function TrucksPage() {
  const { trucks } = useTrucks()
  const drivers = useAppStore((s) => s.drivers)

  return (
    <div className="max-w-[1200px] mx-auto px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Trucks</h1>
        <p className="text-sm text-slate-500 mt-0.5">Fleet management</p>
      </div>

      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Unit #</TableHead>
              <TableHead>Make / Model</TableHead>
              <TableHead>Year</TableHead>
              <TableHead>Plate</TableHead>
              <TableHead>Assigned Driver</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trucks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-16 text-center text-slate-400 text-sm">
                  No trucks added yet
                </TableCell>
              </TableRow>
            ) : (
              trucks.map((truck) => {
                const driver = drivers.find((d) => d.id === truck.currentDriverId)
                return (
                  <TableRow key={truck.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="size-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                          <Truck className="size-4 text-slate-500" />
                        </div>
                        <span className="font-semibold text-foreground">{truck.number}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-foreground">{truck.make} {truck.model}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{truck.year}</TableCell>
                    <TableCell className="text-sm text-muted-foreground font-mono">{truck.plate}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {driver ? driver.name : <span className="text-slate-300">—</span>}
                    </TableCell>
                    <TableCell>
                      {truck.active ? (
                        <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
                      ) : (
                        <Badge variant="secondary" className="bg-slate-50 text-slate-500 border-slate-200">Inactive</Badge>
                      )}
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
