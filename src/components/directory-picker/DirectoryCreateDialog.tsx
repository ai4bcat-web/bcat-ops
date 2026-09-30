import { useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CustomerForm } from '@/features/directory/components/CustomerForm'
import { useCustomerForm } from '@/features/directory/components/useCustomerForm'
import { LocationForm } from '@/features/directory/components/LocationForm'
import { useLocationForm } from '@/features/directory/components/useLocationForm'
import type { CustomerRecord, Division, LocationRecord } from '@/types/tms'

export interface DirectoryCreateDialogProps {
  type: 'customer' | 'location'
  open: boolean
  initial?: { name?: string; city?: string }
  customers?: CustomerRecord[]
  divisions?: Division[]
  onClose: () => void
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
  onSave,
}: DirectoryCreateDialogProps) {
  const customerForm = useCustomerForm(type === 'customer' ? emptyCustomerRecord(initial) : null)
  const locationForm = useLocationForm(type === 'location' ? emptyLocationRecord(initial) : null)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    const errors = type === 'customer' ? customerForm.errors : locationForm.errors
    if (Object.keys(errors).length > 0) { toast.error('Please fix the errors above'); return }
    setSaving(true)
    try {
      if (type === 'customer') await onSave(customerForm.toRecord())
      else await onSave(locationForm.toRecord(), locationForm.getGeocodeToken() ?? undefined)
      onClose()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save') }
    finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{type === 'customer' ? 'Add customer' : 'Add location'}</DialogTitle>
        </DialogHeader>
        {type === 'customer' ? (
          <CustomerForm value={customerForm.value} set={customerForm.set} errors={customerForm.errors} divisions={divisions} />
        ) : (
          <LocationForm value={locationForm.value} set={locationForm.set} setAddressField={locationForm.setAddressField} errors={locationForm.errors} customers={customers} />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
