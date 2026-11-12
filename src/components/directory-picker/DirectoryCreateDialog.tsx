import { useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CustomerForm } from '@/features/directory/components/CustomerForm'
import { useCustomerForm } from '@/features/directory/components/useCustomerForm'
import { LocationForm } from '@/features/directory/components/LocationForm'
import { useLocationForm } from '@/features/directory/components/useLocationForm'
import { DuplicateCustomerNotice } from '@/features/directory/components/NewCustomerGuard'
import { useNewCustomerGuard } from '@/features/directory/components/useNewCustomerGuard'
import { useAuthUser } from '@/hooks/useAuth'
import { OWNER_EMAIL } from '@/lib/auth/admin'
import type { CustomerRecord, Division, LocationRecord } from '@/types/tms'

export interface DirectoryCreateDialogProps {
  type: 'customer' | 'location'
  open: boolean
  initial?: { name?: string; city?: string }
  customers?: CustomerRecord[]
  divisions?: Division[]
  onClose: () => void
  /** Opt in to the TMS theme (`tms-portal`); legacy call sites leave it off. */
  tmsTheme?: boolean
  /** Locations carry the geocode token separately so it is never persisted on the record. */
  onSave: (record: CustomerRecord | LocationRecord, geocodeToken?: string) => void | Promise<void>
}

function emptyCustomerRecord(initial?: { name?: string }): CustomerRecord | null {
  if (!initial?.name) return null
  return {
    id: '', createdAt: '', updatedAt: '', name: initial.name.trim(),
    contactName: null, contactEmail: null, contactPhone: null, notes: null,
  }
}

function emptyLocationRecord(initial?: { name?: string; city?: string }): LocationRecord | null {
  if (!initial?.name) return null
  return { id: '', createdAt: '', updatedAt: '', name: initial.name.trim(), city: initial.city?.trim() || null }
}

export function DirectoryCreateDialog({
  type,
  open,
  initial,
  customers = [],
  divisions = [],
  onClose,
  tmsTheme,
  onSave,
}: DirectoryCreateDialogProps) {
  const customerForm = useCustomerForm(type === 'customer' ? emptyCustomerRecord(initial) : null)
  const locationForm = useLocationForm(type === 'location' ? emptyLocationRecord(initial) : null)
  const [saving, setSaving] = useState(false)
  const authUser = useAuthUser()
  const isAdmin = (authUser?.groups ?? []).includes('ADMIN') || (authUser?.email ?? '').toLowerCase() === OWNER_EMAIL
  const guard = useNewCustomerGuard({
    value: customerForm.value,
    isNew: type === 'customer' && customerForm.isNew,
    existing: type === 'customer' ? customers : [],
    isAdmin,
  })

  const handleSave = async () => {
    const errors = type === 'customer' ? customerForm.errors : locationForm.errors
    if (Object.keys(errors).length > 0) { toast.error('Please fix the errors above'); return }
    if (type === 'customer' && guard.blocked) { toast.error('This customer already exists'); return }
    setSaving(true)
    try {
      if (type === 'customer') {
        const record = guard.overrideReason ? { ...customerForm.toRecord(), duplicateOverrideReason: guard.overrideReason } : customerForm.toRecord()
        await onSave(record)
      } else await onSave(locationForm.toRecord(), locationForm.getGeocodeToken() ?? undefined)
      onClose()
    } catch (e) { if (!(type === 'customer' && guard.takeError(e))) toast.error(e instanceof Error ? e.message : 'Could not save') }
    finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className={`max-w-2xl${tmsTheme ? ' tms-portal' : ''}`}>
        <DialogHeader>
          <DialogTitle>{type === 'customer' ? 'Add customer' : 'Add location'}</DialogTitle>
        </DialogHeader>
        {type === 'customer' && customerForm.isNew && (
          <DuplicateCustomerNotice guard={guard} onOpenExisting={(id) => { window.open(`/tms/customers?customer=${encodeURIComponent(id)}`, '_blank', 'noopener') }} />
        )}
        {type === 'customer' ? (
          <CustomerForm value={customerForm.value} set={customerForm.set} errors={customerForm.errors} divisions={divisions} isNew={customerForm.isNew} />
        ) : (
          <LocationForm value={locationForm.value} set={locationForm.set} setAddressField={locationForm.setAddressField} errors={locationForm.errors} customers={customers} />
        )}
        <DialogFooter>
          {type === 'customer' && customerForm.missing && (
            <span role="status" data-testid="customer-missing" className="tms-field-error" style={{ marginRight: 'auto' }}>{customerForm.missing}</span>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (type === 'customer' && (guard.blocked || (customerForm.isNew && Object.keys(customerForm.errors).length > 0)))}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
