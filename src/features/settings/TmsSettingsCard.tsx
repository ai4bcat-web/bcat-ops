import { useEffect, useState } from 'react'
import { Save, Cog } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import type { TmsSettings } from '@/types/tms'

export function TmsSettingsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [marginFloorBps, setMarginFloorBps] = useState('')
  const [defaultPaymentTermsDays, setDefaultPaymentTermsDays] = useState('')
  const [accessorialCodes, setAccessorialCodes] = useState('')
  const [invoiceNumberFormat, setInvoiceNumberFormat] = useState('')
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        setMarginFloorBps(s?.marginFloorBps != null ? String(s.marginFloorBps) : '')
        setDefaultPaymentTermsDays(s?.defaultPaymentTermsDays != null ? String(s.defaultPaymentTermsDays) : '')
        // Same shape the field parses back: one code per line.
        setAccessorialCodes(Array.isArray(s?.accessorialCodes) ? s.accessorialCodes.map(String).join('\n') : '')
        setInvoiceNumberFormat(s?.invoiceNumberFormat ?? '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setError(null)
    let parsedAccessorialCodes: unknown[] | null = null

    if (accessorialCodes.trim()) {
      try {
        const parsed = parseTextArray(accessorialCodes)
        parsedAccessorialCodes = parsed
      } catch { setError('Accessorial codes must be one value per line'); return }
    }


    let margin: number | null = null
    if (marginFloorBps.trim()) {
      margin = Number(marginFloorBps)
      if (Number.isNaN(margin) || margin < 0) { setError('Margin floor must be a non-negative number'); return }
    }
    let terms: number | null = null
    if (defaultPaymentTermsDays.trim()) {
      terms = Number(defaultPaymentTermsDays)
      if (Number.isNaN(terms) || terms < 0) { setError('Default payment terms must be a non-negative number'); return }
    }

    const patch: Parameters<typeof saveTmsSettings>[0] = {
      ...(margin !== null ? { marginFloorBps: margin } : { marginFloorBps: null }),
      ...(terms !== null ? { defaultPaymentTermsDays: terms } : { defaultPaymentTermsDays: null }),
      ...(accessorialCodes.trim() ? { accessorialCodes: parsedAccessorialCodes } : { accessorialCodes: null }),
      // loadStatusRules is not operator-facing in Phase 1 (nothing consumes it yet) and is left untouched.
      ...(invoiceNumberFormat.trim() ? { invoiceNumberFormat: invoiceNumberFormat.trim() } : { invoiceNumberFormat: null }),
    }

    setSaving(true)
    try {
      const updated = await saveTmsSettings(patch, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('TMS settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Cog size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>TMS defaults</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>Margin floor, payment terms, accessorial codes, invoice format. Leave unknown fields empty — nothing is guessed.</div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Margin floor (basis points)</Label>
              <Input value={marginFloorBps} onChange={(e) => setMarginFloorBps(e.target.value)} placeholder="e.g. 1500 for 15%" className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Default payment terms (days)</Label>
              <Input value={defaultPaymentTermsDays} onChange={(e) => setDefaultPaymentTermsDays(e.target.value)} placeholder="e.g. 30" className="h-9 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Accessorial codes (one per line)</Label>
            <Textarea value={accessorialCodes} onChange={(e) => setAccessorialCodes(e.target.value)} placeholder="LINEHAUL&#10;FSC&#10;DETENTION" rows={4} className="text-sm" />
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice number format</Label>
            <Input value={invoiceNumberFormat} onChange={(e) => setInvoiceNumberFormat(e.target.value)} placeholder="e.g. BL{YYYY}-{SEQ:0000}" className="h-9 text-sm" />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save settings
          </Button>
        </div>
      )}
    </div>
  )
}


function parseTextArray(text: string): string[] {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}
