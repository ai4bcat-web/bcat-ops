import { useState, useEffect, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2, Circle, Edit2, Trash2, Clock, CalendarRange, AlarmClock, Upload, X, FileImage } from 'lucide-react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter, SheetCloseButton,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuth } from '@/hooks/useAuth'
import { loadSchema, type LoadFormValues } from '@/lib/schemas'
import {
  formatDateTime, formatDateTimeInput, fromDateTimeInput,
  formatDateInput, fromDateInput,
} from '@/lib/date'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { ApptType, Load } from '@/types'

// ── Field wrappers ────────────────────────────────────────────────────────────

function Field({ label, children, error, hint }: {
  label: string; children: React.ReactNode; error?: string; hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ReadonlyField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between items-start py-2.5 border-b border-border last:border-b-0">
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
      <span className="text-sm font-medium text-foreground text-right max-w-[60%]">{value || '—'}</span>
    </div>
  )
}

// ── Appointment type group ────────────────────────────────────────────────────

const APPT_TYPE_OPTIONS: { value: ApptType; label: string; icon: React.ElementType }[] = [
  { value: 'exact', label: 'Exact',  icon: Clock        },
  { value: 'range', label: 'Range',  icon: CalendarRange },
  { value: 'fcfs',  label: 'FCFS',   icon: AlarmClock   },
]

function ApptFields({
  label,
  typeField,
  startField,
  endField,
  startError,
  endError,
}: {
  label: string
  typeField: { value: ApptType; onChange: (v: ApptType) => void }
  startField: { value: string; onChange: (v: string) => void }
  endField:   { value: string; onChange: (v: string) => void }
  startError?: string
  endError?: string
}) {
  const type = typeField.value

  return (
    <div className="space-y-2 rounded-md border border-border p-3 bg-muted/30">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider shrink-0">{label}</Label>
        <ToggleGroup
          type="single"
          value={type}
          onValueChange={(v) => v && typeField.onChange(v as ApptType)}
          className="shrink-0"
        >
          {APPT_TYPE_OPTIONS.map(({ value, label: l, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value} aria-label={l} className="gap-1">
              <Icon className="size-3" />{l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {type === 'exact' && (
        <div>
          <Input
            type="datetime-local"
            className="h-9 text-sm"
            value={startField.value}
            onChange={(e) => startField.onChange(e.target.value)}
          />
          {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
        </div>
      )}

      {type === 'range' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">From</p>
            <Input
              type="datetime-local"
              className="h-9 text-sm"
              value={startField.value}
              onChange={(e) => startField.onChange(e.target.value)}
            />
            {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">To</p>
            <Input
              type="datetime-local"
              className="h-9 text-sm"
              value={endField.value}
              onChange={(e) => endField.onChange(e.target.value)}
            />
            {endError && <p className="text-xs text-destructive mt-1">{endError}</p>}
          </div>
        </div>
      )}

      {type === 'fcfs' && (
        <div>
          <Input
            type="date"
            className="h-9 text-sm"
            value={startField.value.slice(0, 10)}
            onChange={(e) => startField.onChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            First Come First Serve — any arrival time on this date.
          </p>
          {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
        </div>
      )}
    </div>
  )
}

// ── Drawer ────────────────────────────────────────────────────────────────────

export function LoadDrawer() {
  const selectedLoadId  = useAppStore((s) => s.selectedLoadId)
  const drawerMode      = useAppStore((s) => s.drawerMode)
  const createPreFill   = useAppStore((s) => s.createPreFill)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const { loads, addLoad, updateLoad, deleteLoad } = useLoads()
  const { drivers } = useDrivers()
  const { user } = useAuth()

  const load         = loads.find((l) => l.id === selectedLoadId)
  const isOpen       = drawerMode !== null
  const isCreate     = drawerMode === 'create'
  const isEdit       = drawerMode === 'edit' || isCreate
  const activeDrivers = drivers.filter((d) => d.active)

  const {
    register, control, handleSubmit, reset, watch, setValue,
    formState: { errors },
  } = useForm<LoadFormValues>({
    resolver: zodResolver(loadSchema),
    defaultValues: {
      aljexId: '', tmsId: '', pickupNumber: '',
      originName: '', originCity: '', destinationName: '', destinationCity: '',
      pickupApptType: 'exact', pickupAppt: '', pickupApptEnd: '',
      deliveryApptType: 'exact', deliveryAppt: '', deliveryApptEnd: '',
      pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false,
    },
  })

  useEffect(() => {
    if (!isOpen) return
    if (load && !isCreate) {
      reset({
        aljexId: load.aljexId,
        tmsId: load.tmsId,
        pickupNumber: load.pickupNumber,
        originName:      load.originName      ?? '',
        originCity:      load.originCity      ?? '',
        destinationName: load.destinationName ?? '',
        destinationCity: load.destinationCity ?? '',
        pickupApptType:   (load.pickupApptType   ?? 'exact') as ApptType,
        pickupAppt:       load.pickupApptType === 'fcfs' ? formatDateInput(load.pickupAppt) : formatDateTimeInput(load.pickupAppt),
        pickupApptEnd:    load.pickupApptEnd ? formatDateTimeInput(load.pickupApptEnd) : '',
        deliveryApptType: (load.deliveryApptType ?? 'exact') as ApptType,
        deliveryAppt:     load.deliveryApptType === 'fcfs' ? formatDateInput(load.deliveryAppt) : formatDateTimeInput(load.deliveryAppt),
        deliveryApptEnd:  load.deliveryApptEnd ? formatDateTimeInput(load.deliveryApptEnd) : '',
        pickupDriverId:   load.pickupDriverId,
        deliveryDriverId: load.deliveryDriverId,
        readyToInvoice:   load.readyToInvoice,
      })
    } else {
      const preDate = createPreFill?.dateStr
      reset({
        aljexId: '', tmsId: '', pickupNumber: '',
        originName: '', originCity: '', destinationName: '', destinationCity: '',
        pickupApptType: 'exact',
        pickupAppt:    preDate ? `${preDate}T08:00` : '',
        pickupApptEnd: '',
        deliveryApptType: 'exact',
        deliveryAppt:  preDate ? `${preDate}T17:00` : '',
        deliveryApptEnd: '',
        pickupDriverId:  createPreFill?.driverId ?? null,
        deliveryDriverId: createPreFill?.driverId ?? null,
        readyToInvoice: false,
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, load?.id, isCreate, drawerMode])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleRateConfirmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !load) return
    e.target.value = ''
    try {
      const { uploadRateConfirm } = await import('@/lib/apiClient')
      const key = await uploadRateConfirm(load.id, file)
      await updateLoad(load.id, { rateConfirmKey: key } as never)
      toast.success('Rate confirmation uploaded')
    } catch {
      toast.error('Upload failed')
    }
  }

  const handleRateConfirmRemove = async () => {
    if (!load) return
    try {
      if (load.rateConfirmUrl) {
        const { deleteRateConfirm } = await import('@/lib/apiClient')
        await deleteRateConfirm((load as Load & { rateConfirmKey?: string }).rateConfirmKey ?? '')
      }
      await updateLoad(load.id, { rateConfirmKey: undefined } as never)
      toast('Rate confirmation removed')
    } catch {
      toast.error('Failed to remove')
    }
  }

  const watchPickupDriver = watch('pickupDriverId')
  const [deliveryLocked, setDeliveryLocked] = useState(false)
  useEffect(() => {
    if (!deliveryLocked && watchPickupDriver) setValue('deliveryDriverId', watchPickupDriver)
  }, [watchPickupDriver, deliveryLocked, setValue])

  const onClose = () => setSelectedLoad(null)

  const onSubmit = async (values: LoadFormValues) => {
    const toIso = (s: string, t: ApptType) => t === 'fcfs' ? fromDateInput(s) : fromDateTimeInput(s)
    const userEmail = user?.email ?? 'dispatch'
    const payload = {
      ...values,
      pickupAppt:      toIso(values.pickupAppt, values.pickupApptType),
      pickupApptEnd:   values.pickupApptType === 'range' && values.pickupApptEnd ? fromDateTimeInput(values.pickupApptEnd) : undefined,
      deliveryAppt:    toIso(values.deliveryAppt, values.deliveryApptType),
      deliveryApptEnd: values.deliveryApptType === 'range' && values.deliveryApptEnd ? fromDateTimeInput(values.deliveryApptEnd) : undefined,
      createdBy: userEmail,
      updatedBy: userEmail,
    }
    try {
      if (isCreate) {
        await addLoad(payload)
        toast.success('Load created')
      } else if (load) {
        await updateLoad(load.id, payload)
        toast.success('Load updated')
      }
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save load')
    }
  }

  const handleDelete = () => {
    if (!load) return
    deleteLoad(load.id)
    toast.success('Load deleted')
    onClose()
  }

  const driverName = (id: string | null) => id ? (drivers.find((d) => d.id === id)?.name ?? id) : '—'

  const apptLabel = (appt: string, type?: string, apptEnd?: string) => {
    if (type === 'fcfs') return 'FCFS (first come first serve)'
    if (type === 'range' && apptEnd) return `${formatDateTime(appt)} – ${formatDateTime(apptEnd)}`
    return formatDateTime(appt)
  }

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="text-base font-semibold">
            {isCreate ? 'New Load' : isEdit ? `Edit — ${load?.aljexId}` : (load?.aljexId ?? 'Load Detail')}
          </SheetTitle>
          <div className="flex items-center gap-2">
            {!isCreate && !isEdit && load && (
              load.readyToInvoice ? (
                <Badge variant="green" className="gap-1 text-xs">
                  <CheckCircle2 className="size-3" /> Ready to Invoice
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                  <Circle className="size-3" /> Pending
                </Badge>
              )
            )}
          </div>
          <SheetCloseButton />
        </SheetHeader>

        <SheetBody>
          {isEdit ? (
            <form id="load-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="ALJEX ID" error={errors.aljexId?.message}>
                  <Input {...register('aljexId')} placeholder="A-2847391" className="h-9" />
                </Field>
                <Field label="TMS ID / PO" error={errors.tmsId?.message}>
                  <Input {...register('tmsId')} placeholder="TMS-44201" className="h-9" />
                </Field>
              </div>

              <Field label="Pickup Number" error={errors.pickupNumber?.message}>
                <Input {...register('pickupNumber')} placeholder="PU-8812" className="h-9" />
              </Field>

              <Separator />

              {/* Origin / Destination */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Origin Name">
                  <Input {...register('originName')} placeholder="Shipper / Facility" className="h-9" />
                </Field>
                <Field label="Origin City">
                  <Input {...register('originCity')} placeholder="Chicago, IL" className="h-9" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Destination Name">
                  <Input {...register('destinationName')} placeholder="Consignee / Facility" className="h-9" />
                </Field>
                <Field label="Destination City">
                  <Input {...register('destinationCity')} placeholder="Indianapolis, IN" className="h-9" />
                </Field>
              </div>

              <Separator />

              {/* Pickup appointment */}
              <Controller
                name="pickupApptType"
                control={control}
                render={({ field: tf }) => (
                  <Controller name="pickupAppt" control={control} render={({ field: sf }) => (
                    <Controller name="pickupApptEnd" control={control} render={({ field: ef }) => (
                      <ApptFields
                        label="Pickup"
                        typeField={{ value: tf.value as ApptType, onChange: (v) => { tf.onChange(v); ef.onChange('') } }}
                        startField={{ value: sf.value ?? '', onChange: sf.onChange }}
                        endField={{ value: ef.value ?? '', onChange: ef.onChange }}
                        startError={errors.pickupAppt?.message}
                        endError={errors.pickupApptEnd?.message}
                      />
                    )} />
                  )} />
                )}
              />

              {/* Delivery appointment */}
              <Controller
                name="deliveryApptType"
                control={control}
                render={({ field: tf }) => (
                  <Controller name="deliveryAppt" control={control} render={({ field: sf }) => (
                    <Controller name="deliveryApptEnd" control={control} render={({ field: ef }) => (
                      <ApptFields
                        label="Delivery"
                        typeField={{ value: tf.value as ApptType, onChange: (v) => { tf.onChange(v); ef.onChange('') } }}
                        startField={{ value: sf.value ?? '', onChange: sf.onChange }}
                        endField={{ value: ef.value ?? '', onChange: ef.onChange }}
                        startError={errors.deliveryAppt?.message}
                        endError={errors.deliveryApptEnd?.message}
                      />
                    )} />
                  )} />
                )}
              />

              <Separator />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Pickup Driver" error={errors.pickupDriverId?.message}>
                  <Controller name="pickupDriverId" control={control} render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={(v) => field.onChange(v || null)}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Unassigned</SelectItem>
                        {activeDrivers.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )} />
                </Field>

                <Field
                  label="Delivery Driver"
                  error={errors.deliveryDriverId?.message}
                  hint={!deliveryLocked ? 'Mirrors pickup' : undefined}
                >
                  <Controller name="deliveryDriverId" control={control} render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={(v) => { field.onChange(v || null); setDeliveryLocked(true) }}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Same as pickup" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Unassigned</SelectItem>
                        {activeDrivers.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )} />
                </Field>
              </div>

              <Separator />

              {/* RTI toggle */}
              <Controller
                name="readyToInvoice"
                control={control}
                render={({ field }) => (
                  <Button
                    type="button"
                    variant={field.value ? 'outline' : 'outline'}
                    className={cn(
                      'w-full h-9 gap-2 justify-start font-medium',
                      field.value
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'text-muted-foreground',
                    )}
                    onClick={() => field.onChange(!field.value)}
                  >
                    {field.value
                      ? <CheckCircle2 className="size-4 text-emerald-600" />
                      : <Circle className="size-4" />}
                    {field.value ? 'Ready to Invoice' : 'Not Ready to Invoice'}
                  </Button>
                )}
              />

              {/* Rate confirmation upload (edit mode — only for existing loads) */}
              {!isCreate && load?.rateConfirmUrl && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rate Confirmation</Label>
                  <img
                    src={load.rateConfirmUrl}
                    alt="Rate confirmation"
                    className="w-full rounded-md border border-border object-contain max-h-48"
                  />
                  <p className="text-xs text-muted-foreground">Open the load detail view to replace or remove.</p>
                </div>
              )}
            </form>
          ) : load ? (
            <div className="space-y-0">
              <ReadonlyField label="ALJEX ID"   value={load.aljexId} />
              <ReadonlyField label="TMS / PO"   value={load.tmsId} />
              <ReadonlyField label="PU #"       value={load.pickupNumber} />
              {(load.originName || load.originCity) && (
                <ReadonlyField label="Origin" value={[load.originName, load.originCity].filter(Boolean).join(' · ')} />
              )}
              {(load.destinationName || load.destinationCity) && (
                <ReadonlyField label="Destination" value={[load.destinationName, load.destinationCity].filter(Boolean).join(' · ')} />
              )}
              <ReadonlyField label="Pickup"     value={apptLabel(load.pickupAppt, load.pickupApptType, load.pickupApptEnd)} />
              <ReadonlyField label="Delivery"   value={apptLabel(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)} />
              <ReadonlyField label="PU Driver"  value={driverName(load.pickupDriverId)} />
              <ReadonlyField label="DE Driver"  value={driverName(load.deliveryDriverId)} />
              <ReadonlyField label="Status"     value={load.readyToInvoice ? 'Ready to Invoice' : 'Pending'} />
              <ReadonlyField label="Created"    value={formatDateTime(load.createdAt)} />
              <ReadonlyField label="Updated"    value={formatDateTime(load.updatedAt)} />
              <ReadonlyField label="Created by" value={load.createdBy} />

              {/* Rate confirmation */}
              <div className="pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rate Confirmation</Label>
                  <div className="flex items-center gap-2">
                    {load.rateConfirmUrl && (
                      <button
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                        onClick={handleRateConfirmRemove}
                      >
                        <X className="size-3" /> Remove
                      </button>
                    )}
                    <button
                      className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="size-3" /> {load.rateConfirmUrl ? 'Replace' : 'Upload'}
                    </button>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={handleRateConfirmUpload}
                />
                {load.rateConfirmUrl ? (
                  <a href={load.rateConfirmUrl} target="_blank" rel="noreferrer">
                    <img
                      src={load.rateConfirmUrl}
                      alt="Rate confirmation"
                      className="w-full rounded-md border border-border object-contain max-h-64 hover:opacity-90 transition-opacity cursor-pointer"
                    />
                  </a>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full h-24 rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
                  >
                    <FileImage className="size-6 opacity-50" />
                    <span className="text-xs">Click to upload rate confirmation</span>
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </SheetBody>

        <SheetFooter>
          {isEdit ? (
            <>
              <Button variant="outline" className="flex-1 h-9" onClick={onClose}>Cancel</Button>
              <Button type="submit" form="load-form" className="flex-1 h-9">
                {isCreate ? 'Create Load' : 'Save Changes'}
              </Button>
            </>
          ) : (
            <>
              {load && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 text-destructive border-destructive/30 hover:bg-destructive/5"
                  onClick={handleDelete}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
              <Button variant="outline" className="flex-1 h-9" onClick={() => setSelectedLoad(selectedLoadId, 'edit')}>
                <Edit2 className="size-4 mr-2" /> Edit Load
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
