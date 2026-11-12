/**
 * "Documents required for this load" (Documents card). POD is always required and the rate
 * confirmation once an outside carrier hauls the load; the customer's own list follows. Those are
 * shown ticked and cannot be turned off for one load. Anything else ticked here (a lumper receipt,
 * a scale ticket) is saved straight away with SET_LOAD_REQUIRED_DOCS: it blocks Move to billing
 * until it is filed and the driver app lists it for the driver.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { setLoadRequiredDocs } from '@/lib/apiClient'
import { LOAD_EXTRA_DOC_TYPES, docTypeLabel, loadExtraDocTypes } from '@/lib/loadRequiredDocs'
import { requiredDocTypesFor } from '@/lib/shipmentDocuments'
import type { CustomerRecord, ShipmentBundle, TmsSettings } from '@/types/tms'

interface Props {
  bundle: ShipmentBundle | null
  customer: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null
  settings: Pick<TmsSettings, 'defaultRequiredDocs'> | null
  disabled: boolean
  refreshBundle: () => Promise<void>
}

export function LoadRequiredDocs({ bundle, customer, settings, disabled, refreshBundle }: Props) {
  const [saving, setSaving] = useState<string | null>(null)
  const loads = bundle?.loads ?? []
  const outsideCarrier = (bundle?.loadCarriers ?? []).some((lc) => lc.status === 'ACTIVE' && lc.kind !== 'OWN_ASSET')
  const customerList = requiredDocTypesFor(customer, settings).types.filter((t) => t !== 'POD' && t !== 'RATE_CON')

  const toggle = async (loadId: string, current: string[], type: string, on: boolean) => {
    if (!bundle) return
    const next = on ? [...current, type] : current.filter((t) => t !== type)
    setSaving(`${loadId}:${type}`)
    try {
      await setLoadRequiredDocs({ shipmentId: bundle.shipment.id, loadId, requiredDocTypes: next })
      await refreshBundle()
      toast.success(on ? `${docTypeLabel(type)} is now required for this load` : `${docTypeLabel(type)} is no longer required for this load`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the required documents')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="tms-card-req" data-testid="card-documents-load-required">
      <div className="tms-card-req-title">Documents required for this load</div>
      {loads.length === 0 ? (
        <p className="tms-muted text-xs" data-testid="card-documents-load-required-unsaved">
          POD and the rate confirmation are always required. Create the shipment to add more for this load.
        </p>
      ) : (
        loads.map((load, i) => {
          const extras = loadExtraDocTypes([load])
          return (
            <fieldset key={load.id} className="tms-load-docs" data-testid={`card-documents-load-required-${load.id}`}>
              {loads.length > 1 && <legend className="tms-muted text-xs">{`Load ${i + 1}${load.aljexId ? ` · PRO ${load.aljexId}` : ''}`}</legend>}
              <ul className="tms-load-docs-list">
                <li>
                  <label><input type="checkbox" checked disabled readOnly /> {docTypeLabel('POD')}</label>
                  <span className="tms-muted">always</span>
                </li>
                <li>
                  <label><input type="checkbox" checked={outsideCarrier} disabled readOnly /> {docTypeLabel('RATE_CON')}</label>
                  <span className="tms-muted">{outsideCarrier ? 'outside carrier' : 'when an outside carrier hauls it'}</span>
                </li>
                {customerList.map((type) => (
                  <li key={`c-${type}`}>
                    <label><input type="checkbox" checked disabled readOnly /> {docTypeLabel(type)}</label>
                    <span className="tms-muted">customer requires</span>
                  </li>
                ))}
                {LOAD_EXTRA_DOC_TYPES.filter((t) => !customerList.includes(t)).map((type) => {
                  const on = extras.includes(type)
                  const busy = saving === `${load.id}:${type}`
                  return (
                    <li key={type}>
                      <label>
                        <input
                          type="checkbox"
                          data-testid={`card-documents-load-required-${type}`}
                          checked={on}
                          disabled={disabled || saving != null}
                          onChange={(e) => { void toggle(load.id, extras, type, e.target.checked) }}
                        />{' '}
                        {docTypeLabel(type)}
                      </label>
                      {busy && <span className="tms-muted">saving…</span>}
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          )
        })
      )}
      <p className="tms-muted text-xs">Defaults can&apos;t be turned off for one load. A ticked document must be filed before the load can move to billing, and the driver sees it in the app.</p>
    </div>
  )
}
