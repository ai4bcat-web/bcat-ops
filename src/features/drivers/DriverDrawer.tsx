/**
 * The full driver editor — create and edit every field on a Driver record.
 *
 * Extracted from the old Drivers page so the Files hub owns it: the Drivers page was the
 * ONLY place able to create a driver or edit their phone, email, CDL, dates, calendar
 * colour, photo, broker flag or classification. Several of those are invisible on the
 * form itself but drive behaviour elsewhere — colour drives Calendar load colours, the
 * photo is the avatar shown app-wide, and type='broker' excludes a driver from pay.
 *
 * Truck and trailer assignment go through the store's assignTruckToDriver / driver
 * update so there is still exactly ONE assignment path, shared with the Fleet page.
 */
import { useState, useRef, useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Trash2, Building2, Truck, Camera, Check, ShieldCheck, User } from 'lucide-react'
import { FormSection, Field } from '@/components/ui/form-section'
import { errorMessage } from '@/lib/utils/errorMessage'
import { useDrivers } from '@/hooks/useDrivers'
import { useAppStore } from '@/store/useAppStore'
import { uploadDriverPhoto, deleteDriverPhoto } from '@/lib/apiClient'
import { COLOR_MAP } from '@/lib/driverColors'
import { FLEET_GROUPS, FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { ColorKey } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter, SheetCloseButton,
} from '@/components/ui/sheet'
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

export function DriverDrawer({ open, driver, onClose }: DriverDrawerProps) {
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
    defaultValues: { name: '', phone: '', active: true, type: 'driver', colorKey: undefined, notes: '', email: '', cdl: '', cdlExpiration: '', medCardExpiration: '', drugTestDate: '', hireDate: '', driverType: undefined, assignedTruckId: null, assignedTrailerId: null, fleetGroup: null },
  })

  // Trucks available to assign (manually-added or Motive-connected — both are Equipment).
  const trucks = useAppStore((s) => s.equipment).filter((e) => e.type === 'truck' && e.active)
  const trailers = useAppStore((s) => s.equipment).filter((e) => e.type === 'trailer' && e.active)

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
            assignedTrailerId: driver.assignedTrailerId ?? null,
            fleetGroup: driver.fleetGroup ?? null,
          }
        : { name: '', phone: '', active: true, type: 'driver', colorKey: undefined, notes: '', email: '', cdl: '', cdlExpiration: '', medCardExpiration: '', drugTestDate: '', hireDate: '', driverType: undefined, assignedTruckId: null, assignedTrailerId: null, fleetGroup: null })
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

      // Enforce one-driver-per-truck via the single shared assignment path, which also
      // keeps Equipment.assignedDriverId in step.
      const previousTruckId = isEdit ? (driver.assignedTruckId ?? null) : null
      if (normalized.assignedTruckId) {
        await useAppStore.getState().assignTruckToDriver(normalized.assignedTruckId, driverId)
      } else if (previousTruckId) {
        // Clearing the truck must RELEASE it — otherwise Equipment.assignedDriverId keeps
        // pointing at this driver and the fleet shows a truck that is no longer theirs.
        await useAppStore.getState().assignTruckToDriver(previousTruckId, null)
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
          <SheetBody>
            <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoSelect} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

              {/* ── Driver Details ─────────────────────────────────────────── */}
              <FormSection icon={<User size={15} />} title="Driver Details" subtitle="Identity, type & calendar color">
                {/* Photo column beside stacked Name + Phone */}
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <div
                      className="relative group cursor-pointer"
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
                    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs px-2.5" onClick={() => photoInputRef.current?.click()}>
                      <Camera className="size-3" /> {photoPreview ? 'Change' : 'Photo'}
                    </Button>
                    {photoPreview && (
                      <button type="button" onClick={handleRemovePhoto} className="text-xs text-destructive hover:underline">Remove</button>
                    )}
                  </div>

                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
                    <Field label="Full Name *">
                      <Input {...register('name')} placeholder="Full name" className={cn('h-9', errors.name && 'border-destructive')} />
                      {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
                    </Field>
                    <Field label="Phone *" hint="10-digit US">
                      <Input {...register('phone')} placeholder="(312) 555-0100" type="tel" className={cn('h-9', errors.phone && 'border-destructive')} />
                      {errors.phone && <p className="text-xs text-destructive mt-1">{errors.phone.message}</p>}
                    </Field>
                    <Field label="Email" hint="for onboarding portal invite">
                      <Input {...register('email')} placeholder="driver@example.com" className="h-9" type="email" />
                    </Field>
                  </div>
                </div>

                <Field label="Fleet" hint="decides which documents this driver's file requires">
                  <Controller
                    name="fleetGroup"
                    control={control}
                    render={({ field }) => (
                      <select value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value || null)} className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                        <option value="">— Unclassified —</option>
                        {FLEET_GROUPS.map((g) => <option key={g} value={g}>{FLEET_GROUP_LABELS[g]}</option>)}
                      </select>
                    )}
                  />
                </Field>

                {/* Type toggle */}
                <Field label="Type">
                  <Controller
                    name="type"
                    control={control}
                    render={({ field }) => (
                      <ToggleGroup type="single" className="w-full grid grid-cols-2" value={field.value} onValueChange={(v) => v && field.onChange(v)}>
                        <ToggleGroupItem value="driver" className="gap-2"><Truck className="size-3.5" /> Own Driver</ToggleGroupItem>
                        <ToggleGroupItem value="broker" className="gap-2"><Building2 className="size-3.5" /> Broker / 3PL</ToggleGroupItem>
                      </ToggleGroup>
                    )}
                  />
                  {watchType === 'broker' && <p className="text-xs text-muted-foreground mt-1.5">Broker entries appear at the bottom of the calendar.</p>}
                </Field>

                {/* Assigned truck (own drivers only) */}
                {watchType === 'driver' && (
                  <>
                  <Field label="Assigned Trailer" hint="TBD until one is handed out">
                    <Controller
                      name="assignedTrailerId"
                      control={control}
                      render={({ field }) => (
                        <select value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value || null)} className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                          <option value="">— TBD, not assigned —</option>
                          {trailers.map((t) => (
                            <option key={t.id} value={t.id}>#{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}</option>
                          ))}
                        </select>
                      )}
                    />
                  </Field>
                  <Field label="Assigned Truck" hint="from Fleet">
                    <Controller
                      name="assignedTruckId"
                      control={control}
                      render={({ field }) => (
                        <select value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value || null)} className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                          <option value="">— No truck assigned —</option>
                          {trucks.map((t) => (
                            <option key={t.id} value={t.id}>#{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}{(t.make || t.model) ? ` — ${[t.make, t.model].filter(Boolean).join(' ')}` : ''}</option>
                          ))}
                        </select>
                      )}
                    />
                  </Field>
                  </>
                )}

                {/* Calendar color */}
                <Field label="Calendar Color" hint={!watchColorKey ? 'auto if none' : undefined}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {(Object.entries(COLOR_MAP) as [ColorKey, typeof COLOR_MAP[ColorKey]][])
                      .filter(([key]) => key !== 'broker')
                      .map(([key, c]) => (
                        <button key={key} type="button" title={key} onClick={() => setValue('colorKey', key, { shouldDirty: true })}
                          className="relative size-7 rounded-full transition-transform hover:scale-110 focus:outline-none"
                          style={{ background: c.border, boxShadow: watchColorKey === key ? `0 0 0 3px #fff, 0 0 0 5px ${c.border}` : undefined }}>
                          {watchColorKey === key && <Check className="absolute inset-0 m-auto size-3.5 text-white" strokeWidth={3} />}
                        </button>
                      ))}
                  </div>
                </Field>

                <Field label="Notes">
                  <Textarea {...register('notes')} placeholder="CDL class, preferred lanes, equipment…" rows={2} />
                </Field>
              </FormSection>

              {/* ── Compliance & Documents (collapsed) ─────────────────────── */}
              <FormSection icon={<ShieldCheck size={15} />} title="Compliance & Documents" subtitle="CDL, med card, drug test" collapsible defaultOpen={false}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <Field label="CDL Number"><Input {...register('cdl')} placeholder="CDL-A IL-8823901" className="h-9" /></Field>
                  <Field label="CDL Class">
                    <Controller name="driverType" control={control} render={({ field }) => (
                      <select value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value || undefined)} className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                        <option value="">Select…</option>
                        <option value="COMPANY">Company Driver</option>
                        <option value="OWNER_OPERATOR">Owner Operator</option>
                      </select>
                    )} />
                  </Field>
                  <Field label="CDL Expiration"><Input {...register('cdlExpiration')} placeholder="YYYY-MM-DD" className="h-9" type="date" /></Field>
                  <Field label="Med Card Expiration"><Input {...register('medCardExpiration')} placeholder="YYYY-MM-DD" className="h-9" type="date" /></Field>
                  <Field label="Last Drug Test"><Input {...register('drugTestDate')} placeholder="YYYY-MM-DD" className="h-9" type="date" /></Field>
                  <Field label="Hire Date"><Input {...register('hireDate')} placeholder="YYYY-MM-DD" className="h-9" type="date" /></Field>
                </div>
              </FormSection>

              {/* ── Active toggle card ─────────────────────────────────────── */}
              <Controller
                name="active"
                control={control}
                render={({ field }) => (
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `1.5px solid ${field.value ? '#86efac' : 'var(--ds-border)'}`, background: field.value ? '#f0fdf4' : 'var(--ds-surface)' }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: field.value ? '#15803d' : 'var(--ds-t1)' }}>Active driver</div>
                      <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>Inactive drivers won't appear on the calendar</div>
                    </div>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </label>
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
