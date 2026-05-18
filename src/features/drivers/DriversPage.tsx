import { useState, useRef, useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Phone, ToggleLeft, ToggleRight, Edit2, Trash2, Building2, Truck, Camera, X, Check } from 'lucide-react'
import { errorMessage } from '@/lib/utils/errorMessage'
import { useDrivers } from '@/hooks/useDrivers'
import { uploadDriverPhoto, deleteDriverPhoto } from '@/lib/apiClient'
import { COLOR_MAP, getColor } from '@/lib/driverColors'
import type { ColorKey } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Avatar } from '@/components/ui/avatar'
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

function getInitials(name: string): string {
  return name.split(' ').slice(0, 2).map((n) => n[0] ?? '').join('').toUpperCase()
}

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

  // Photo state
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [shouldDeletePhoto, setShouldDeletePhoto] = useState(false)

  const {
    register, handleSubmit, reset, control, watch, setValue,
    formState: { errors, isSubmitting },
  } = useForm<DriverFormValues>({
    resolver: zodResolver(driverSchema),
    defaultValues: { name: '', phone: '', active: true, type: 'driver', colorKey: undefined, notes: '' },
  })

  const watchType = watch('type')
  const watchName = watch('name')
  const watchColorKey = watch('colorKey')

  // Reset form and photo state whenever the drawer opens or the driver changes
  useEffect(() => {
    if (open) {
      reset(driver
        ? { name: driver.name, phone: driver.phone, active: driver.active, type: driver.type ?? 'driver', colorKey: driver.colorKey, notes: driver.notes ?? '' }
        : { name: '', phone: '', active: true, type: 'driver', colorKey: undefined, notes: '' })
      setPhotoFile(null)
      setPhotoPreview(driver?.photoUrl ?? null)
      setShouldDeletePhoto(false)
    }
  }, [open, driver?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) onClose()
  }

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setShouldDeletePhoto(false)
    const reader = new FileReader()
    reader.onload = (ev) => setPhotoPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
    // Reset input so selecting same file again still triggers onChange
    e.target.value = ''
  }

  const handleRemovePhoto = () => {
    setPhotoFile(null)
    setPhotoPreview(null)
    setShouldDeletePhoto(true)
  }

  const onSubmit = async (values: DriverFormValues) => {
    // Auto-assign a color if none chosen
    const colorKeys: ColorKey[] = ['driver-1','driver-2','driver-3','driver-4','driver-5','driver-6']
    const autoColor = values.colorKey ?? colorKeys[Math.floor(Math.random() * colorKeys.length)]
    const normalized = { ...values, phone: normalizePhone(values.phone), colorKey: autoColor }
    try {
      let driverId: string
      if (isEdit) {
        await updateDriver(driver.id, normalized)
        driverId = driver.id
      } else {
        const newDriver = await addDriver(normalized)
        driverId = newDriver.id
      }

      // Handle photo upload / removal separately
      try {
        if (shouldDeletePhoto && driver?.photoKey) {
          await deleteDriverPhoto(driver.photoKey)
          await updateDriver(driverId, { photoKey: '' })
        } else if (photoFile) {
          const key = await uploadDriverPhoto(driverId, photoFile)
          await updateDriver(driverId, { photoKey: key })
        }
      } catch {
        toast.error('Driver saved but photo upload failed')
      }

      toast(isEdit ? 'Driver updated' : 'Driver added', { description: normalized.name })
      onClose()
    } catch (err) {
      // Log the raw error so GraphQL error objects are visible in the console
      console.error('Driver save error:', err)
      // @aws-amplify/data throws { errors: [...] } (not Error instances) for GraphQL errors
      toast.error(errorMessage(err))
    }
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

            {/* Photo upload */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Photo</Label>
              <div className="flex items-center gap-4">
                {/* Avatar preview */}
                <div
                  className="relative group cursor-pointer shrink-0"
                  onClick={() => photoInputRef.current?.click()}
                  title="Click to upload photo"
                >
                  {photoPreview ? (
                    <img src={photoPreview} alt="Driver" className="size-16 rounded-full object-cover border-2 border-border" />
                  ) : (
                    <div className="size-16 rounded-full bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground border-2 border-dashed border-border select-none">
                      {getInitials(watchName || driver?.name || '?') || '?'}
                    </div>
                  )}
                  <div className="absolute inset-0 rounded-full flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Camera className="size-6 text-white" />
                  </div>
                </div>

                {/* Buttons */}
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => photoInputRef.current?.click()}
                  >
                    <Camera className="size-3.5" />
                    {photoPreview ? 'Change Photo' : 'Upload Photo'}
                  </Button>
                  {photoPreview && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={handleRemovePhoto}
                    >
                      <X className="size-3.5" /> Remove
                    </Button>
                  )}
                </div>
              </div>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoSelect}
              />
            </div>

            <Separator />

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

            {/* Color picker */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Calendar Color</Label>
              <div className="flex items-center gap-2 flex-wrap">
                {(Object.entries(COLOR_MAP) as [ColorKey, typeof COLOR_MAP[ColorKey]][])
                  .filter(([key]) => key !== 'broker')
                  .map(([key, c]) => (
                    <button
                      key={key}
                      type="button"
                      title={key}
                      onClick={() => setValue('colorKey', key, { shouldDirty: true })}
                      className="relative size-7 rounded-full transition-transform hover:scale-110 focus:outline-none"
                      style={{ background: c.border, boxShadow: watchColorKey === key ? `0 0 0 3px #fff, 0 0 0 5px ${c.border}` : undefined }}
                    >
                      {watchColorKey === key && (
                        <Check className="absolute inset-0 m-auto size-3.5 text-white" strokeWidth={3} />
                      )}
                    </button>
                  ))}
              </div>
              {!watchColorKey && (
                <p className="text-xs text-muted-foreground">A color will be auto-assigned if none is picked.</p>
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
            {Object.keys(errors).length > 0 && (
              <p className="w-full text-xs text-destructive mb-1">
                Please fix the errors above before saving.
              </p>
            )}
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
      <div className="sticky top-0 z-10 border-b border-border bg-white">
        <div className="flex items-center justify-between px-8 pt-5 pb-3">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Drivers &amp; Brokers</h1>
          <Button size="lg" className="gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add Driver
          </Button>
        </div>
        <div className="flex items-center gap-3 px-8 pb-4 overflow-x-auto">
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
      <div className="p-8">
        <div className="rounded-xl border border-slate-200/60 overflow-hidden bg-white shadow-sm">
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
                  <TableCell className="font-semibold text-foreground">
                    <div className="flex items-center gap-2">
                      <Avatar
                        src={driver.photoUrl}
                        initials={getInitials(driver.name)}
                        size="sm"
                        style={driver.colorKey ? { background: getColor(driver.colorKey).border, color: '#ffffff' } : undefined}
                      />
                      {driver.name}
                      {driver.colorKey && (
                        <span
                          className="size-2.5 rounded-full shrink-0"
                          style={{ background: getColor(driver.colorKey).border }}
                        />
                      )}
                    </div>
                  </TableCell>
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
