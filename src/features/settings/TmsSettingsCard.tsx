import { useEffect, useState } from 'react'
import { Save, Cog } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import type { TmsSettings } from '@/types/tms'
import { ErrorText, Loading, SettingsCard, Stack } from './settingsKit'

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
    // One code per line; blank lines are not codes.
    const parsedAccessorialCodes = accessorialCodes.trim()
      ? accessorialCodes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : null


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
    <SettingsCard
      icon={Cog}
      title="TMS defaults"
      description="Margin floor, payment terms, accessorial codes, invoice format. Leave unknown fields empty — nothing is guessed."
    >
      {loading ? <Loading /> : (
        <Stack>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Margin floor (basis points)">
              <TmsInput value={marginFloorBps} onChange={(e) => setMarginFloorBps(e.target.value)} placeholder="e.g. 1500 for 15%" />
            </TmsField>
            <TmsField label="Default payment terms (days)">
              <TmsInput value={defaultPaymentTermsDays} onChange={(e) => setDefaultPaymentTermsDays(e.target.value)} placeholder="e.g. 30" />
            </TmsField>
          </div>
          <TmsField label="Accessorial codes (one per line)">
            <TmsTextarea value={accessorialCodes} onChange={(e) => setAccessorialCodes(e.target.value)} placeholder="LINEHAUL&#10;FSC&#10;DETENTION" rows={4} />
          </TmsField>
          <TmsField label="Invoice number format">
            <TmsInput value={invoiceNumberFormat} onChange={(e) => setInvoiceNumberFormat(e.target.value)} placeholder="e.g. BL{YYYY}-{SEQ:0000}" />
          </TmsField>
          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
