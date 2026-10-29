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
 *
 * `cancelDeleteAdminOnly` keeps its stored name; what it gates on screen is cancel
 * and **void**. A PRO number is permanent — nothing deletes a shipment.
 */
import { useEffect, useState } from 'react'
import { Package, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getTmsSettings, saveShipmentSettings } from '@/lib/apiClient'
import type { ShipmentMode, TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, Loading, SettingsCard, Stack } from './settingsKit'

const SHIPMENT_MODES: ShipmentMode[] = [
  'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
]

/** No mode at all is a real answer: the customer's own default decides. */
const NO_MODE = '__NONE__'

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
  // The number the Lambda would mint next: prefix + the counter, padded to six.
  const counter = nextValid && typedNext !== null ? typedNext : currentNumber || 1
  const preview = `${prefix.trim() || 'S'}${String(counter).padStart(6, '0')}`

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
    <SettingsCard
      icon={Package}
      title="Shipments"
      description="How shipments are numbered, what mode they start in, who may cancel one, and what the AR and AP boards call their first rung."
    >
      {loading ? <Loading /> : (
        <Stack>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Shipment prefix" hint="Up to 8 letters, numbers or dashes.">
              <TmsInput
                aria-label="Shipment prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="S"
              />
            </TmsField>
            <TmsField
              label="Next shipment number"
              hint={
                <>
                  The counter only goes forward — it is taken with an atomic add, so setting it back would mint a number a live shipment already has.{' '}
                  Next shipment: <strong data-testid="shipment-number-example">{preview}</strong>
                </>
              }
            >
              <TmsInput
                aria-label="Next shipment number"
                inputMode="numeric"
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
                placeholder={String(currentNumber)}
              />
            </TmsField>
          </div>

          <div className="tms-grid tms-grid-2">
            <TmsField
              label="Default mode"
              hint="What a new shipment starts as when the customer has no default of their own."
            >
              <TmsSelect aria-label="Default mode" value={defaultMode} onChange={(e) => setDefaultMode(e.target.value)}>
                <option value={NO_MODE}>— the customer&rsquo;s own default —</option>
                {SHIPMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </TmsSelect>
            </TmsField>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }}>
              <CheckRow
                ariaLabel="Cancel and void admin only"
                label="Only an admin may cancel or void a shipment"
                checked={cancelDeleteAdminOnly}
                onChange={setCancelDeleteAdminOnly}
              />
            </div>
          </div>

          <div className="tms-grid tms-grid-2">
            <TmsField
              label="AR unbilled stage"
              hint="What the AR board calls delivered freight that has not been invoiced yet."
            >
              <TmsInput
                aria-label="AR unbilled stage"
                value={arUnbilledStage}
                onChange={(e) => setArUnbilledStage(e.target.value)}
                placeholder="To invoice"
              />
            </TmsField>
            <TmsField
              label="AP in-review stage"
              hint="What the AP board calls a carrier bill that is recorded but not approved to pay."
            >
              <TmsInput
                aria-label="AP in review stage"
                value={apInReviewStage}
                onChange={(e) => setApInReviewStage(e.target.value)}
                placeholder="In review"
              />
            </TmsField>
          </div>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save shipment settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
