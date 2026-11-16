/**
 * The one way to choose a customer for freight that names one the directory does not
 * hold yet (Ryne 2026-11-16, 20007 "R&R Transport, Inc."): a fuzzy directory search
 * seeded with the typed name, and — for anyone allowed to add customers — "Create
 * customer '<name>'" right in the picker, through the same create form as Directory →
 * New customer. A created customer is picked at once; the caller links it.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
import { DirectoryPicker } from '@/components/directory-picker/DirectoryPicker'
import { useCanCreateCustomer } from './useCanCreateCustomer'
import { createCustomer } from '@/lib/apiClient'
import type { CustomerRecord } from '@/types/tms'

export interface LinkCustomerPickerProps {
  customers: CustomerRecord[]
  value: string | null
  /** The name typed on the freight (e.g. from the intake e-mail): seeds the search and the create form. */
  initialQuery?: string
  onChange: (customerId: string | null, record?: CustomerRecord | null) => void
  /** Called after a customer is created here, so the caller can add it to its own list. */
  onCreated?: (record: CustomerRecord) => void
  placeholder?: string
}

export function LinkCustomerPicker({ customers, value, initialQuery = '', onChange, onCreated, placeholder }: LinkCustomerPickerProps) {
  const canCreate = useCanCreateCustomer()
  const [creating, setCreating] = useState<string | null>(null)
  const [list, setList] = useState<CustomerRecord[]>([])
  const all = list.length ? [...customers, ...list.filter((c) => !customers.some((x) => x.id === c.id))] : customers

  return (
    <div data-testid="link-customer-picker">
      <DirectoryPicker
        type="customer" value={value} customers={all} locations={[]} initialQuery={initialQuery}
        placeholder={placeholder ?? 'Search customers…'}
        onChange={(id, record) => onChange(id, (record as CustomerRecord | null | undefined) ?? null)}
        onCreateNew={canCreate ? ({ name }) => setCreating((name ?? '').trim() || initialQuery) : undefined}
        noMatchHint={canCreate ? undefined : 'No matches. Ask an admin to add this customer.'}
        createLabel={(q) => `Create customer “${q}”`}
        inlineResults
      />
      {!canCreate && <p className="mt-1 text-xs text-muted-foreground" data-testid="link-customer-no-create">Not in the directory? Ask an admin to add this customer.</p>}
      {creating != null && (
        <DirectoryCreateDialog
          type="customer" open tmsTheme customers={all} initial={{ name: creating }} onClose={() => setCreating(null)}
          onSave={async (record) => {
            const { id: _id, createdAt: _c, updatedAt: _u, ...input } = record as CustomerRecord
            const created = await createCustomer(input)
            setList((p) => [...p, created])
            onCreated?.(created)
            onChange(created.id, created)
            setCreating(null)
            toast.success(`${created.name} added`)
          }}
        />
      )}
    </div>
  )
}
