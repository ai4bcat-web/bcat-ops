import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import type { RequiredReference, ReferenceLevel } from '@/types/tms'

const LEVELS: ReferenceLevel[] = ['ORDER', 'HANDLING_UNIT', 'PACKAGE', 'STOP']

function emptyReference(): RequiredReference {
  return { code: '', level: 'ORDER', display: true, countOnNewOrder: 0 }
}

interface ReferencesEditorProps {
  references: RequiredReference[]
  onChange: (references: RequiredReference[]) => void
  disabled?: boolean
}

export function ReferencesEditor({ references, onChange, disabled }: ReferencesEditorProps) {
  const update = (idx: number, patch: Partial<RequiredReference>) => {
    onChange(references.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  const add = () => onChange([...references, emptyReference()])
  const remove = (idx: number) => onChange(references.filter((_, i) => i !== idx))

  return (
    <div className="space-y-3">
      {references.length === 0 && <p className="text-xs text-muted-foreground">No required references configured.</p>}
      {references.map((r, idx) => (
        <div key={idx} className="grid grid-cols-12 items-start gap-2 rounded-lg border border-border bg-card p-3">
          <div className="col-span-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Code</Label>
            <Input value={r.code} onChange={(e) => update(idx, { code: e.target.value })} disabled={disabled} className="h-9 text-sm" />
          </div>
          <div className="col-span-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Label</Label>
            <Input value={r.label ?? ''} onChange={(e) => update(idx, { label: e.target.value })} disabled={disabled} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Level</Label>
            <select
              value={r.level}
              onChange={(e) => update(idx, { level: e.target.value as ReferenceLevel })}
              disabled={disabled}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground"># on order</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={r.countOnNewOrder}
              onChange={(e) => update(idx, { countOnNewOrder: Math.min(10, Math.max(0, Number(e.target.value))) })}
              disabled={disabled}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-1 flex flex-col gap-2 pt-5">
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={r.display} onCheckedChange={(checked) => update(idx, { display: checked as boolean })} disabled={disabled} />
              Show
            </label>
          </div>
          <div className="col-span-1 flex justify-end pt-4">
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)} disabled={disabled}>
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} className="mr-1" /> Add reference
      </Button>
    </div>
  )
}
