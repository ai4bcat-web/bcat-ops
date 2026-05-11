import { useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Phone, ToggleLeft, ToggleRight, Edit2, Trash2, Building2, Truck } from 'lucide-react'
import { useDrivers } from '@/hooks/useDrivers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter, SheetCloseButton,
} from '@/components/ui/sheet'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { formatPhone } from '@/lib/utils'
import { formatDateTime } from '@/lib/date'
import { driverSchema, type DriverFormValues } from '@/lib/schemas'
import type { Driver } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^1/, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  return raw
}

// ── Driver Drawer ─────────────────────────────────────────────────────────────

interface DriverDrawerProps {
  open: boolean
  driver: Driver | null
  onClose: () => void
}

function DriverDrawer({ open, driver, onClose }: DriverDrawerProps) {
  const { addDriver, updateDriver, deleteDriver } = useDrivers()
  const isEdit = driver !== null

  const {
    register, handleSubmit, reset, control, watch,
    formState: { errors, isSubmitting },
  } = useForm<DriverFormValues>({
    resolver: zodResolver(driverSchema),
    defaultValues: { name: '', phone: '', active: true, type: 'driver', notes: '' },
  })

  const watchType = watch('type')

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      reset(driver
        ? { name: driver.name, phone: driver.phone, active: driver.active, type: driver.type ?? 'driver', notes: driver.notes ?? '' }
        : { name: '', phone: '', active: true, type: 'driver', notes: '' })
    } else {
      onClose()
    }
  }

  const onSubmit = (values: DriverFormValues) => {
    const normalized = { ...values, phone: normalizePhone(values.phone) }
    if (isEdit) {
      updateDriver(driver.id, normalized)
      toast('Driver updated', { description: normalized.name })
    } else {
      addDriver(normalized)
      toast('Driver added', { description: normalized.name })
    }
    onClose()
  }

  const handleDelete = () => {
    if (!driver) return
    if (!confirm(`Delete driver "${driver.name}"? This cannot be undone.`)) return
    deleteDriver(driver.id)
    toast('Driver deleted', { description: driver.name })
    onClose()
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="text-base font-semibold">{isEdit ? 'Edit Driver' : 'Add Driver'}</SheetTitle>
          <SheetCloseButton />
        </SheetHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col h-full">
          <SheetBody className="space-y-4">

            {/* Name */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name *</Label>
              <Input
                {...register('name')}
                placeholder="Full name"
                className={cn('h-9', errors.name && 'border-destructive')}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            {/* Phone */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone *</Label>
              <Input
                {...register('phone')}
                placeholder="(312) 555-0100"
                type="tel"
                className={cn('h-9', errors.phone && 'border-destructive')}
              />
              {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
              <p className="text-xs text-muted-foreground">10-digit US number, any format accepted</p>
            </div>

            <Separator />

            {/* Type toggle */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</Label>
              <Controller
                name="type"
                control={control}
                render={({ field }) => (
                  <ToggleGroup
                    type="single"
                    value={field.value}
                    onValueChange={(v) => v && field.onChange(v)}
                  >
                    <ToggleGroupItem value="driver" className="gap-2">
                      <Truck className="size-3.5" /> Own Driver
                    </ToggleGroupItem>
                    <ToggleGroupItem value="broker" className="gap-2">
                      <Building2 className="size-3.5" /> Broker / 3PL
                    </ToggleGroupItem>
                  </ToggleGroup>
                )}
              />
              {watchType === 'broker' && (
                <p className="text-xs text-muted-foreground">
                  Broker entries appear at the bottom of the calendar.
                </p>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</Label>
              <Textarea
                {...register('notes')}
                placeholder="CDL class, preferred lanes, equipment…"
                rows={3}
              />
            </div>

            <Separator />

            {/* Active switch */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Active driver</p>
                <p className="text-xs text-muted-foreground">Inactive drivers won't appear on the calendar</p>
              </div>
              <Controller
                name="active"
                control={control}
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </div>
          </SheetBody>

          <SheetFooter>
            {isEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mr-auto h-9 text-destructive border-destructive/30 hover:bg-destructive/5 gap-1.5"
                onClick={handleDelete}
              >
                <Trash2 className="size-3.5" /> Delete
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" className="h-9" disabled={isSubmitting}>
              {isEdit ? 'Save Changes' : 'Add Driver'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// ── Drivers Page ──────────────────────────────────────────────────────────────

export function DriversPage() {
  const { drivers, updateDriver } = useDrivers()
  const [drawerOpen, setDrawerOpen]     = useState(false)
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null)

  const sorted = [...drivers].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const openCreate = () => { setEditingDriver(null); setDrawerOpen(true) }
  const openEdit   = (d: Driver) => { setEditingDriver(d); setDrawerOpen(true) }
  const closeDrawer = () => setDrawerOpen(false)

  const activeCount  = drivers.filter((d) => d.active).length
  const brokerCount  = drivers.filter((d) => d.type === 'broker').length
  const ownCount     = drivers.filter((d) => d.active && d.type !== 'broker').length

  return (
    <div className="h-full overflow-auto">
      {/* KPI + header */}
      <div className="sticky top-0 z-10 border-b border-border" style={{ background: 'linear-gradient(180deg,#0e2454 0%,#07122b 100%)' }}>
        <div className="flex items-center justify-between px-6 pt-4 pb-3">
          <h1 className="text-base font-bold text-white tracking-tight">Drivers &amp; Brokers</h1>
          <Button size="sm" className="h-8 gap-1.5" onClick={openCreate}>
            <Plus className="size-3.5" /> Add Driver
          </Button>
        </div>
        <div className="flex items-center gap-3 px-6 pb-3 overflow-x-auto">
          <div className="ds-kpi">
            <div className="ds-kpi-label">Total</div>
            <div className="ds-kpi-value">{drivers.length}</div>
          </div>
          <div className="ds-kpi">
            <div className="ds-kpi-label">Active Drivers</div>
            <div className="ds-kpi-value green">{ownCount}</div>
          </div>
          <div className="ds-kpi">
            <div className="ds-kpi-label">Brokers / 3PL</div>
            <div className="ds-kpi-value blue">{brokerCount}</div>
          </div>
          <div className="ds-kpi">
            <div className="ds-kpi-label">Inactive</div>
            <div className="ds-kpi-value amber">{drivers.length - activeCount}</div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="p-6">
        <div className="rounded-lg border border-border overflow-hidden" style={{ background: '#0d1d3d' }}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((driver) => (
                <TableRow
                  key={driver.id}
                  className={cn(!driver.active && 'opacity-50')}
                >
                  <TableCell className="font-semibold text-foreground">{driver.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <a
                      href={`tel:${driver.phone}`}
                      className="flex items-center gap-1.5 hover:text-primary transition-colors w-fit text-sm"
                    >
                      <Phone className="size-3.5" />
                      {formatPhone(driver.phone)}
                    </a>
                  </TableCell>
                  <TableCell>
                    {driver.active
                      ? <Badge variant="green">Active</Badge>
                      : <Badge variant="secondary">Inactive</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs max-w-[200px] truncate">
                    {driver.notes || '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(driver.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => openEdit(driver)}
                            aria-label="Edit driver"
                          >
                            <Edit2 className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => updateDriver(driver.id, { active: !driver.active })}
                            aria-label={driver.active ? 'Deactivate driver' : 'Activate driver'}
                          >
                            {driver.active
                              ? <ToggleRight className="size-4 text-emerald-600" />
                              : <ToggleLeft className="size-4 text-muted-foreground" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{driver.active ? 'Deactivate' : 'Activate'}</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-muted-foreground text-sm">
                    No drivers yet. Add one to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <DriverDrawer open={drawerOpen} driver={editingDriver} onClose={closeDrawer} />
    </div>
  )
}
