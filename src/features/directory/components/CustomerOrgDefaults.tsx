import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { TmsSettings } from '@/types/tms'
import { MoneyField } from './MoneyField'
import { ReferencesEditor } from './ReferencesEditor'

type Defaults = Pick<TmsSettings, 'defaultCreditLimitCents' | 'defaultFreeCreditRequired' | 'defaultCreditUsageWarningBps' | 'defaultMaxDaysLate' | 'requireCustomerApproval' | 'defaultRequiredDocs' | 'defaultRequiredReferences' | 'rateConTerms'>

export function CustomerOrgDefaults({ settings, onSave, onClose }: {
  settings: TmsSettings | null
  onSave: (patch: Defaults) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Defaults>({
    defaultCreditLimitCents: settings?.defaultCreditLimitCents ?? null,
    defaultFreeCreditRequired: settings?.defaultFreeCreditRequired ?? false,
    defaultCreditUsageWarningBps: settings?.defaultCreditUsageWarningBps ?? null,
    defaultMaxDaysLate: settings?.defaultMaxDaysLate ?? null,
    requireCustomerApproval: settings?.requireCustomerApproval ?? false,
    defaultRequiredDocs: settings?.defaultRequiredDocs ?? [],
    defaultRequiredReferences: settings?.defaultRequiredReferences ?? [],
    rateConTerms: settings?.rateConTerms ?? null,
  })
  const [documents, setDocuments] = useState((settings?.defaultRequiredDocs ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try { await onSave({ ...draft, defaultRequiredDocs: documents.split(',').map((v) => v.trim()).filter(Boolean) }); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Customer organization defaults</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Used when a customer has no override. Changes do not rewrite customer records.</p>
        <div className="grid grid-cols-2 gap-4">
          <MoneyField label="Default credit limit" value={draft.defaultCreditLimitCents} onChange={(value) => setDraft({ ...draft, defaultCreditLimitCents: value })} disabled={saving} />
          <Label>Credit warning %<Input aria-label="Default credit warning percent" type="number" min={0} max={100} step="0.01" value={draft.defaultCreditUsageWarningBps == null ? '' : draft.defaultCreditUsageWarningBps / 100} onChange={(e) => setDraft({ ...draft, defaultCreditUsageWarningBps: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })} disabled={saving} /></Label>
          <Label>Maximum days late<Input aria-label="Default maximum days late" type="number" min={0} step={1} value={draft.defaultMaxDaysLate ?? ''} onChange={(e) => setDraft({ ...draft, defaultMaxDaysLate: e.target.value === '' ? null : Number(e.target.value) })} disabled={saving} /></Label>
          <div className="space-y-3">
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.defaultFreeCreditRequired === true} onChange={(e) => setDraft({ ...draft, defaultFreeCreditRequired: e.target.checked })} disabled={saving} />Require free credit</label>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.requireCustomerApproval === true} onChange={(e) => setDraft({ ...draft, requireCustomerApproval: e.target.checked })} disabled={saving} />Require customer approval</label>
          </div>
        </div>
        <Label>Required documents (comma separated)<Input aria-label="Default required documents" value={documents} onChange={(e) => setDocuments(e.target.value)} disabled={saving} /></Label>
        <div><h3 className="mb-2 text-sm font-medium">Required references</h3><ReferencesEditor references={draft.defaultRequiredReferences ?? []} onChange={(refs) => setDraft({ ...draft, defaultRequiredReferences: refs })} disabled={saving} /></div>
        <Label>Default rate confirmation terms<Textarea aria-label="Default rate confirmation terms" value={draft.rateConTerms ?? ''} onChange={(e) => setDraft({ ...draft, rateConTerms: e.target.value || null })} disabled={saving} /></Label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save defaults'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
