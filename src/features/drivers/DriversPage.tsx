import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Phone, Edit2, Trash2, Building2, Truck, Package, Camera, X, Check, AlertTriangle, Eye, Search, ShieldCheck } from 'lucide-react'
import { errorMessage } from '@/lib/utils/errorMessage'
import { useDrivers } from '@/hooks/useDrivers'
import { useAppStore } from '@/store/useAppStore'
import { useIsMobile } from '@/hooks/useIsMobile'
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
import { driverSchema, type DriverFormValues } from '@/lib/schemas'
import type { Driver } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

function expiryState(date?: string): 'none' | 'overdue' | 'expiring' | 'ok' {
  if (!date) return 'none'
  const diff = (new Date(date).getTime() - Date.now()) / 86_400_000
  if (diff < 0) return 'overdue'
  if (diff <= 30) return 'expiring'
  return 'ok'
}

// Consolidated compliance cell — replaces the CDL/Med/Drug/Hire date columns.
function DriverComplianceCell({ driver }: { driver: Driver }) {
  if ((driver.type ?? 'driver') === 'broker') {
    return <span className="text-muted-foreground/40 text-xs">N/A</span>
  }
  const hasCdl = !!(driver.cdl || driver.cdlExpiration)
  const hasMed = !!driver.medCardExpiration
  if (!hasCdl || !hasMed) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200 w-fit">
        <AlertTriangle className="size-3" /> Missing docs
      </span>
    )
  }
  const chip = (label: string, date?: string) => {
    const st = expiryState(date)
    const cls = st === 'overdue' ? 'bg-red-50 text-red-700 border-red-200'
              : st === 'expiring' ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-slate-50 text-slate-500 border-slate-200'
    return (
      <span title={`${label}: ${date ?? 'no date'}`} className={cn('inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border cursor-default', cls)}>
        {label}
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-1.5 items-start">
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 w-fit">
        <ShieldCheck className="size-3" /> Verified
      </span>
      <div className="flex gap-1">
        {chip('CDL', driver.cdlExpiration)}
        {chip('MED', driver.medCardExpiration)}
      </div>
    </div>
  )
}

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
    defaultValues: { name: '', phone: '', active: true, type: 'driver', colorKey: undefined, notes: '', email: '', cdl: '', cdlExpiration: '', medCardExpiration: '', drugTestDate: '', hireDate: '', driverType: undefined, assignedTruckId: null },
  })

  // Trucks available to assign (manually-added or Motive-connected — both are Equipment).
  const trucks = useAppStore((s) => s.equipment).filter((e) => e.type === 'truck' && e.active)

  const watchType = watch('type')
  const watchName = watch('name')
  const watchColorKey = watch('colorKey')

  // Reset form and photo state whenever the drawer opens or the driver changes
  useEffect(() => {
    if (open) {
      reset(driver
        ? {
            name: driver.name, phone: driver.phone, active: driver.active,
            type: driver.type ?? 'driver', colorKey: driver.colorKey, notes: driver.notes ?? '',
            email: driver.email ?? '', cdl: driver.cdl ?? '',
            cdlExpiration: driver.cdlExpiration ?? '', medCardExpiration: driver.medCardExpiration ?? '',
            drugTestDate: driver.drugTestDate ?? '', hireDate: driver.hireDate ?? '',
            driverType: (driver.driverType || undefined) as 'COMPANY' | 'OWNER_OPERATOR' | undefined,
            assignedTruckId: driver.assignedTruckId ?? null,
          }
        : { name: '', phone: '', active: true, type: 'driver', colorKey: undefined, notes: '', email: '', cdl: '', cdlExpiration: '', medCardExpiration: '', drugTestDate: '', hireDate: '', driverType: undefined, assignedTruckId: null })
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
    const colorKeys: ColorKey[] = [
      'driver-1','driver-2','driver-3','driver-4','driver-5','driver-6',
      'driver-7','driver-8','driver-9','driver-10','driver-11','driver-12',
    ]
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

            {/* Assigned truck (own drivers only) */}
            {watchType === 'driver' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Assigned Truck</Label>
                <Controller
                  name="assignedTruckId"
                  control={control}
                  render={({ field }) => (
                    <select
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value || null)}
                      className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">— No truck assigned —</option>
                      {trucks.map((t) => (
                        <option key={t.id} value={t.id}>
                          #{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}{(t.make || t.model) ? ` — ${[t.make, t.model].filter(Boolean).join(' ')}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Trucks come from Fleet — both Motive-connected and manually-added trucks appear here.
                </p>
              </div>
            )}

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

            {/* Compliance */}
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Compliance &amp; Profile</p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</Label>
                <Input {...register('email')} placeholder="driver@example.com" className="h-9" type="email" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">CDL Number</Label>
                <Input {...register('cdl')} placeholder="CDL-A IL-8823901" className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Driver Type</Label>
                <Controller
                  name="driverType"
                  control={control}
                  render={({ field }) => (
                    <select
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value || undefined)}
                      className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">Select…</option>
                      <option value="COMPANY">Company Driver</option>
                      <option value="OWNER_OPERATOR">Owner Operator</option>
                    </select>
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">CDL Expiration</Label>
                <Input {...register('cdlExpiration')} placeholder="YYYY-MM-DD" className="h-9" type="date" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Med Card Expiration</Label>
                <Input {...register('medCardExpiration')} placeholder="YYYY-MM-DD" className="h-9" type="date" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Drug Test</Label>
                <Input {...register('drugTestDate')} placeholder="YYYY-MM-DD" className="h-9" type="date" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Hire Date</Label>
                <Input {...register('hireDate')} placeholder="YYYY-MM-DD" className="h-9" type="date" />
              </div>
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
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { drivers } = useDrivers()
  const loads = useAppStore((s) => s.loads)

  // Active loads = assigned to the driver and not yet ready to invoice.
  const activeLoadCount = (driverId: string) =>
    loads.filter((l) => !l.readyToInvoice && (l.pickupDriverId === driverId || l.deliveryDriverId === driverId)).length
  const [drawerOpen, setDrawerOpen]       = useState(false)
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null)
  const [search, setSearch]               = useState('')
  const [typeFilter, setTypeFilter]       = useState<'all' | 'driver' | 'broker'>('all')

  const sorted = [...drivers]
    .filter((d) => {
      if (typeFilter !== 'all' && (d.type ?? 'driver') !== typeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return d.name.toLowerCase().includes(q) || (d.phone ?? '').toLowerCase().includes(q) || (d.notes ?? '').toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const openCreate  = () => { setEditingDriver(null); setDrawerOpen(true) }
  const openEdit    = (d: Driver) => { setEditingDriver(d); setDrawerOpen(true) }
  const closeDrawer = () => setDrawerOpen(false)

  const activeCount = drivers.filter((d) => d.active).length
  const brokerCount = drivers.filter((d) => d.type === 'broker').length
  const ownCount    = drivers.filter((d) => d.active && d.type !== 'broker').length

  const TABS = [
    { key: 'all' as const,    label: 'All' },
    { key: 'driver' as const, label: 'Company Drivers' },
    { key: 'broker' as const, label: 'Brokers / 3PL' },
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px 12px' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Drivers &amp; Brokers</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Roster · compliance · contact</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 13, fontWeight: 500, color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit' }}>
              Export
            </button>
            <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
              <Plus size={14} /> Add Driver
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'flex', gap: 12, padding: '0 32px 16px', overflowX: 'auto' }}>
          <div className="ds-kpi"><div className="ds-kpi-label">Total</div><div className="ds-kpi-value">{drivers.length}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Active Drivers</div><div className="ds-kpi-value green">{ownCount}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Brokers / 3PL</div><div className="ds-kpi-value blue">{brokerCount}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Inactive</div><div className="ds-kpi-value amber">{drivers.length - activeCount}</div></div>
        </div>
      </div>

      {/* ── Filters + Table ───────────────────────────────────────────────── */}
      <div style={{ padding: '24px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {/* Tab pills */}
          <div style={{ display: 'flex', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3, gap: 2 }}>
            {TABS.map(({ key, label }) => {
              const active = typeFilter === key
              return (
                <button
                  key={key}
                  onClick={() => setTypeFilter(key)}
                  style={{
                    padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                    background: active ? '#fff' : 'transparent',
                    color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* Search */}
          <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, notes…"
              style={{
                width: '100%', height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7,
                fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Table (desktop) / card list (mobile) */}
        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {isMobile ? (
            <div>
              {sorted.map((driver) => {
                const activeLoads = activeLoadCount(driver.id)
                const avatarColor = driver.colorKey ? getColor(driver.colorKey).border : undefined
                return (
                  <button
                    key={driver.id}
                    onClick={() => openEdit(driver)}
                    className={cn(!driver.active && 'opacity-50')}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'var(--ds-surface)', border: 'none', borderBottom: '1px solid var(--ds-border)', padding: '12px 16px', cursor: 'pointer' }}
                  >
                    <Avatar src={driver.photoUrl} initials={getInitials(driver.name)} size="lg" style={avatarColor ? { background: avatarColor, color: '#ffffff' } : undefined} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ds-t1)' }}>{driver.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
                        {driver.phone ? formatPhone(driver.phone) : '—'}{driver.type ? ` · ${driver.type}` : ''}
                      </div>
                    </div>
                    {activeLoads > 0 && <span style={{ fontSize: 11, color: '#16a34a', flexShrink: 0 }}>{activeLoads} active</span>}
                  </button>
                )
              })}
            </div>
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-[220px]">Driver</TableHead>
                <TableHead className="min-w-[150px]">Contact</TableHead>
                <TableHead className="min-w-[140px]">Type</TableHead>
                <TableHead className="min-w-[150px]">Assignment</TableHead>
                <TableHead className="min-w-[160px]">Compliance</TableHead>
                <TableHead className="min-w-[90px]">Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((driver) => {
                const driverType = driver.type ?? 'driver'
                const activeLoads = activeLoadCount(driver.id)
                const avatarColor = driver.colorKey ? getColor(driver.colorKey).border : undefined
                return (
                  <TableRow key={driver.id} className={cn(!driver.active && 'opacity-50')}>
                    {/* Driver — avatar (+ active pulse) + name + notes/ID subtitle */}
                    <TableCell className="py-3">
                      <div className="flex items-center gap-3">
                        <div className="relative shrink-0">
                          <Avatar
                            src={driver.photoUrl}
                            initials={getInitials(driver.name)}
                            size="lg"
                            style={avatarColor ? { background: avatarColor, color: '#ffffff' } : undefined}
                          />
                          {activeLoads > 0 && (
                            <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-emerald-500 ring-2 ring-white animate-pulse" title={`${activeLoads} active load${activeLoads !== 1 ? 's' : ''}`} />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-foreground truncate">{driver.name}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[160px]">
                            {driver.notes
                              ? driver.notes
                              : <span className="font-mono text-muted-foreground/60">{driver.id}</span>}
                          </div>
                        </div>
                      </div>
                    </TableCell>

                    {/* Contact — tel: link, mono */}
                    <TableCell className="py-3 text-muted-foreground">
                      {driver.phone
                        ? <a href={`tel:${driver.phone}`} className="inline-flex items-center gap-1.5 hover:text-primary transition-colors w-fit text-sm font-mono">
                            <Phone className="size-3.5 shrink-0" />{formatPhone(driver.phone)}
                          </a>
                        : <span className="text-muted-foreground/50">—</span>}
                    </TableCell>

                    {/* Type — company (blue, truck) or broker (violet, box) */}
                    <TableCell className="py-3">
                      {driverType === 'broker'
                        ? <Badge variant="secondary" className="bg-violet-50 text-violet-700 border-violet-200">
                            <Package className="size-3 mr-1" />Broker / 3PL
                          </Badge>
                        : <Badge variant="secondary" className="bg-sky-50 text-sky-700 border-sky-200">
                            <Truck className="size-3 mr-1" />Company
                          </Badge>}
                    </TableCell>

                    {/* Assignment — active loads pill or muted fallback */}
                    <TableCell className="py-3">
                      {activeLoads > 0
                        ? <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                            {activeLoads} active
                          </span>
                        : <span className="text-muted-foreground/50 text-sm">No truck assigned</span>}
                    </TableCell>

                    {/* Compliance — Verified / Missing docs / N/A */}
                    <TableCell className="py-3"><DriverComplianceCell driver={driver} /></TableCell>

                    {/* Status */}
                    <TableCell className="py-3">
                      {driver.active
                        ? <Badge variant="green">Active</Badge>
                        : <Badge variant="secondary">Inactive</Badge>}
                    </TableCell>

                    {/* Actions — edit + view */}
                    <TableCell className="py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" onClick={() => openEdit(driver)} aria-label="Edit driver">
                              <Edit2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" onClick={() => navigate(`/compliance/driver/${driver.id}`)} aria-label="View driver">
                              <Eye className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>View</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center text-muted-foreground text-sm">
                    {drivers.length === 0 ? 'No drivers yet. Add one to get started.' : 'No drivers match your filter.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          )}
        </div>
      </div>

      <DriverDrawer open={drawerOpen} driver={editingDriver} onClose={closeDrawer} />
    </div>
  )
}
