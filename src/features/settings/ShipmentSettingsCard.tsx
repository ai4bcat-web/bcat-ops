/**
 * Shipment numbering and the house defaults every new shipment starts from.
 *
 * The counter is editable, unlike the invoice counter, because a brokerage moving
 * onto this system starts its numbering where its old system stopped. It is also
 * the one field here the Lambda can refuse on its own: the number is taken with an
 * atomic ADD, so a value set *below* the current counter would hand a live shipment
 * its number a second time. `SAVE_SHIPMENT_SETTINGS` refuses that, and so does the
 * check underneath the box, in the same words.
 *
 * The example beside the counter is built the way the Lambda builds a number —
 * prefix plus the counter zero-padded to six — so what an admin reads here is what
 * the next shipment is actually called.
 */
import { useEffect, useState } from 'react'
import { Package, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getTmsSettings, saveShipmentSettings } from '@/lib/apiClient'
import type { ShipmentMode, TmsSettings } from '@/types/tms'

const SHIPMENT_MODES: ShipmentMode[] = [
  'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
]

/** No mode at all is a real answer: the customer's own default decides. */
const NO_MODE = '__NONE__'

/** The number the Lambda would mint next: prefix + the counter, padded to six. */
function shipmentNumberPreview(prefix: string, next: number): string {
  return `${prefix.trim() || 'S'}${String(next).padStart(6, '0')}`
}

export function ShipmentSettingsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [prefix, setPrefix] = useState('')
  const [nextNumber, setNextNumber] = useState('')
  const [currentNumber, setCurrentNumber] = useState(0)
  const [cancelDeleteAdminOnly, setCancelDeleteAdminOnly] = useState(true)
  const [defaultMode, setDefaultMode] = useState<string>(NO_MODE)
  const [arUnbilledStage, setArUnbilledStage] = useState('')
  const [apInReviewStage, setApInReviewStage] = useState('')
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setPrefix(s?.shipmentPrefix ?? '')
        setNextNumber(s?.nextShipmentNumber != null ? String(s.nextShipmentNumber) : '')
        setCurrentNumber(s?.nextShipmentNumber ?? 0)
        // Cancelling a shipment is admin-only unless somebody deliberately opened it up.
        setCancelDeleteAdminOnly(s?.cancelDeleteAdminOnly !== false)
        setDefaultMode(s?.defaultMode ?? NO_MODE)
        // `TmsSettings` still types these two as the booleans Step B shipped; the
        // Lambda stores the board's wording, which is what `ShipmentSettings` says.
        setArUnbilledStage(typeof s?.arUnbilledStage === 'string' ? s.arUnbilledStage : '')
        setApInReviewStage(typeof s?.apInReviewStage === 'string' ? s.apInReviewStage : '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const typedNext = nextNumber.trim() ? Number(nextNumber.trim()) : null
  const nextValid = typedNext === null || (Number.isInteger(typedNext) && typedNext >= 0)
  const preview = shipmentNumberPreview(prefix, nextValid && typedNext !== null ? typedNext : currentNumber || 1)

  const save = async () => {
    setError(null)
    if (!nextValid) { setError('The next shipment number must be a whole number'); return }
    if (typedNext !== null && typedNext < currentNumber) {
      setError(`The shipment counter is at ${currentNumber} and can only go forward`)
      return
    }

    setSaving(true)
    try {
      await saveShipmentSettings({
        shipmentPrefix: prefix.trim() || null,
        nextShipmentNumber: typedNext,
        cancelDeleteAdminOnly,
        defaultMode: defaultMode === NO_MODE ? null : (defaultMode as ShipmentMode),
        arUnbilledStage: arUnbilledStage.trim() || null,
        apInReviewStage: apInReviewStage.trim() || null,
      })
      if (typedNext !== null) setCurrentNumber(typedNext)
      toast.success('Shipment settings saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Package size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Shipments</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            How shipments are numbered, what mode they start in, who may cancel one, and what the AR and AP boards call their first rung.
          </div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Shipment prefix</Label>
              <Input
                aria-label="Shipment prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="S"
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Up to 8 letters, numbers or dashes.
              </p>
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next shipment number</Label>
              <Input
                aria-label="Next shipment number"
                inputMode="numeric"
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
                placeholder={String(currentNumber)}
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The counter only goes forward — it is taken with an atomic add, so setting it back would mint a number a live shipment already has.{' '}
                Next shipment: <span className="font-medium text-foreground" data-testid="shipment-number-example">{preview}</span>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Default mode</Label>
              <Select value={defaultMode} onValueChange={setDefaultMode}>
                <SelectTrigger className="h-9 text-sm" aria-label="Default mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MODE}>— the customer&rsquo;s own default —</SelectItem>
                  {SHIPMENT_MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                What a new shipment starts as when the customer has no default of their own.
              </p>
            </div>
            <label className="flex items-end gap-2.5 pb-1 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="Cancel and delete admin only"
                checked={cancelDeleteAdminOnly}
                onCheckedChange={(v) => setCancelDeleteAdminOnly(v === true)}
              />
              Only an admin may cancel or delete a shipment
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">AR unbilled stage</Label>
              <Input
                aria-label="AR unbilled stage"
                value={arUnbilledStage}
                onChange={(e) => setArUnbilledStage(e.target.value)}
                placeholder="To invoice"
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                What the AR board calls delivered freight that has not been invoiced yet.
              </p>
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">AP in-review stage</Label>
              <Input
                aria-label="AP in review stage"
                value={apInReviewStage}
                onChange={(e) => setApInReviewStage(e.target.value)}
                placeholder="In review"
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                What the AP board calls a carrier bill that is recorded but not approved to pay.
              </p>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save shipment settings
          </Button>
        </div>
      )}
    </div>
  )
}
