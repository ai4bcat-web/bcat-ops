/**
 * One carrier, everything about them, in a sheet over the board — the same shape as the
 * customer profile (spec §3.3).
 *
 * The header is the compliance answer at a glance: the status pill is the *effective*
 * status, so a carrier whose cargo insurance lapsed reads "Inactive — expired insurance"
 * without anybody having touched the record. Identity, equipment and compliance are a
 * draft saved with one button; contacts, payment methods and documents are their own
 * rows and save on their own.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Building2, ExternalLink, FileText, History, Phone, Shield, Truck, Wallet, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useCarrier } from '@/hooks/useCarrier'
import {
  archiveCarrierContact, archiveCarrierPaymentMethod, commitCarrierDocument, deleteCarrierDocument,
  getCarrierDocumentUrl, graphqlErrorText, listAuditLogs, prepareCarrierDocument, setCarrierStatus,
  upsertCarrier, upsertCarrierContact, upsertCarrierPaymentMethod, uploadCarrierDocumentFile,
} from '@/lib/apiClient'
import { insuranceState, oosBps } from '@/lib/carrierEligibility'
import {
  CARRIER_STATUS_LABELS, CARRIER_STATUS_REASON_LABELS, effectiveCarrierStatus,
} from '@/lib/carrierStatus'
import { formatCents } from '@/lib/tmsDirectory'
import { cn } from '@/lib/utils'
import {
  DEFAULT_INSURANCE_WARN_DAYS, DEFAULT_REQUIRED_CARRIER_DOCS, INSURANCE_STATE_STYLES,
} from '../carrierViews'
import { CarrierContactsEditor, type CarrierContactDraft } from './CarrierContactsEditor'
import { CarrierDocumentsEditor } from './CarrierDocumentsEditor'
import { CarrierForm } from './CarrierForm'
import {
  carrierFormError, carrierFormFrom, carrierFormInput,
  type CarrierFormValue, type CarrierPatch,
} from './carrierFormModel'
import { CarrierPaymentEditor, type CarrierPaymentDraft } from './CarrierPaymentEditor'
import { CarrierStatusDialog } from './CarrierStatusDialog'
import { InsurancePoliciesEditor } from './InsurancePoliciesEditor'
import type { AuditLogEntry } from '@/types'
import type {
  CarrierDocumentType, CarrierRecord, CarrierStatus, InsurancePolicy, TmsSettings,
} from '@/types/tms'

const tabs = [
  { key: 'profile', label: 'Profile', icon: Building2 },
  { key: 'compliance', label: 'Compliance', icon: Shield },
  { key: 'contacts', label: 'Contacts', icon: Phone },
  { key: 'payment', label: 'Payment', icon: Wallet },
  { key: 'equipment', label: 'Equipment', icon: Truck },
  { key: 'loads', label: 'Loads', icon: FileText },
  { key: 'activity', label: 'Activity', icon: History },
]

const statusStyles: Record<CarrierStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  REVIEW: 'bg-blue-100 text-blue-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  INACTIVE: 'bg-gray-100 text-gray-700',
  DO_NOT_USE: 'bg-red-100 text-red-700',
}

function saferUrl(dotNumber: string): string {
  return 'https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot' +
    `&query_param=USDOT&query_string=${encodeURIComponent(dotNumber)}`
}

interface CarrierProfileProps {
  carrierId: string
  isAdmin: boolean
  settings: TmsSettings | null
  onClose: () => void
  onChanged: (carrier: CarrierRecord) => void
}

export function CarrierProfile({ carrierId, isAdmin, settings, onClose, onChanged }: CarrierProfileProps) {
  const navigate = useNavigate()
  const { bundle, loading, error, refresh, replaceCarrier } = useCarrier(carrierId)
  const [tab, setTab] = useState('profile')
  const [statusOpen, setStatusOpen] = useState(false)
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)

  const carrier = bundle?.carrier ?? null
  const now = new Date().toISOString()
  const warnDays = settings?.insuranceWarnDays ?? DEFAULT_INSURANCE_WARN_DAYS
  const requiredDocs = settings?.requiredCarrierDocs ?? DEFAULT_REQUIRED_CARRIER_DOCS

  // The audit trail is a whole-table read, so it waits until somebody opens the tab.
  useEffect(() => {
    if (tab !== 'activity' || logs !== null) return
    listAuditLogs()
      .then(setLogs)
      .catch((e: unknown) => setLogsError(graphqlErrorText(e) || 'Could not load activity'))
  }, [tab, logs])

  const carrierLogs = useMemo(() => {
    if (!logs || !bundle) return []
    const ids = new Set<string>([bundle.carrier.id])
    for (const contact of bundle.contacts) ids.add(contact.id)
    for (const method of bundle.paymentMethods) ids.add(method.id)
    for (const document of bundle.documents) ids.add(document.id)
    return logs.filter((entry) => ids.has(entry.entityId))
  }, [logs, bundle])

  const effective = carrier ? effectiveCarrierStatus(carrier, now) : null

  const saveCarrier = async (patch: CarrierPatch) => {
    if (!carrier) return
    const next = await upsertCarrier({ id: carrier.id, expectedUpdatedAt: carrier.updatedAt, ...patch })
    replaceCarrier(next)
    onChanged(next)
    toast.success('Carrier saved')
  }

  const saveContact = async (draft: CarrierContactDraft) => {
    if (!carrier) return
    await upsertCarrierContact({ carrierId: carrier.id, ...draft })
    await refresh()
    toast.success('Contact saved')
  }

  const savePaymentMethod = async (draft: CarrierPaymentDraft) => {
    if (!carrier) return
    await upsertCarrierPaymentMethod({ carrierId: carrier.id, ...draft })
    await refresh()
    toast.success('Payment method saved')
  }

  // Archive and document buttons fire and forget, so they report their own failures
  // rather than leaving an unhandled rejection behind.
  const reportFailure = (e: unknown, fallback: string) => {
    toast.error(graphqlErrorText(e) || (e instanceof Error ? e.message : fallback))
  }

  const uploadDocument = async (file: File, type: CarrierDocumentType, expiresAt: string | null) => {
    if (!carrier) return
    const prepared = await prepareCarrierDocument({
      carrierId: carrier.id, type, name: file.name, contentType: file.type, sizeBytes: file.size,
    })
    await uploadCarrierDocumentFile(file, prepared.uploadUrl, file.type)
    await commitCarrierDocument({
      carrierId: carrier.id, type, name: file.name, s3Key: prepared.s3Key,
      contentType: file.type, sizeBytes: file.size, expiresAt,
    })
    await refresh()
    toast.success('Document uploaded')
  }

  return (
    <Sheet open onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent className="w-full sm:max-w-4xl flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <SheetTitle className="flex items-center gap-2 text-base">
                {carrier?.name ?? (loading ? 'Loading…' : 'Carrier')}
                {effective && (
                  <Badge variant="secondary" className={cn('text-[10px]', statusStyles[effective.status])}>
                    {CARRIER_STATUS_LABELS[effective.status]}
                  </Badge>
                )}
                {effective?.derived && <span className="text-[10px] text-muted-foreground">(derived)</span>}
              </SheetTitle>
              {carrier && (
                <p className="text-xs text-muted-foreground">
                  {carrier.type}
                  {carrier.mcNumber && <> · MC {carrier.mcNumber}</>}
                  {carrier.dotNumber && <> · DOT {carrier.dotNumber}</>}
                  {carrier.dotNumber && (
                    <a
                      href={saferUrl(carrier.dotNumber)}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 inline-flex items-center gap-1 underline"
                    >
                      SAFER <ExternalLink size={10} />
                    </a>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {carrier && <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>Change status</Button>}
              <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><X size={16} /></Button>
            </div>
          </div>

          {effective && effective.reason && (
            <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              {CARRIER_STATUS_REASON_LABELS[effective.reason]}
              {carrier?.statusNote && <> — {carrier.statusNote}</>}
            </p>
          )}

          {carrier && (
            <div className="flex flex-wrap gap-1 pt-2">
              {carrier.highwayStatus && <Badge variant="outline" className="text-[10px]">Highway {carrier.highwayStatus}</Badge>}
              {carrier.rmisStatus && <Badge variant="outline" className="text-[10px]">RMIS {carrier.rmisStatus}</Badge>}
              {carrier.mcpStatus && <Badge variant="outline" className="text-[10px]">MCP {carrier.mcpStatus}</Badge>}
              {(carrier.insurancePolicies ?? []).map((policy) => {
                const state = insuranceState(policy, now, warnDays)
                return (
                  <Badge key={policy.id} variant="secondary" className={cn('text-[10px]', INSURANCE_STATE_STYLES[state])}>
                    {policy.type.replace(/_/g, ' ').toLowerCase()} · {state.toLowerCase()}
                  </Badge>
                )
              })}
            </div>
          )}

          <div className="flex flex-wrap gap-1 pt-2">
            {tabs.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md',
                    tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  <Icon size={13} /> {t.label}
                </button>
              )
            })}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6 py-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!bundle && loading && <p className="text-sm text-muted-foreground">Loading…</p>}

          {bundle && carrier && (
            <>
              {(tab === 'profile' || tab === 'equipment' || tab === 'compliance') && (
                <CarrierDraft
                  key={`${carrier.id}:${carrier.updatedAt}`}
                  carrier={carrier}
                  section={tab}
                  warnDays={warnDays}
                  now={now}
                  onSave={saveCarrier}
                />
              )}

              {tab === 'compliance' && (
                <section className="mt-6">
                  <h3 className="mb-3 text-sm font-semibold">Documents</h3>
                  <CarrierDocumentsEditor
                    documents={bundle.documents}
                    requiredDocs={requiredDocs}
                    now={now}
                    canDelete={isAdmin}
                    onUpload={uploadDocument}
                    onOpen={async (document) => {
                      try {
                        window.open(await getCarrierDocumentUrl(document.s3Key), '_blank', 'noopener')
                      } catch (e) {
                        reportFailure(e, 'Could not open that document')
                      }
                    }}
                    onDelete={async (document) => {
                      if (!window.confirm(`Delete "${document.name}"? The audit row stays.`)) return
                      try {
                        await deleteCarrierDocument({ id: document.id })
                        await refresh()
                        toast.success('Document deleted')
                      } catch (e) {
                        reportFailure(e, 'Delete failed')
                      }
                    }}
                  />
                </section>
              )}

              {tab === 'contacts' && (
                <CarrierContactsEditor
                  contacts={bundle.contacts}
                  onSave={saveContact}
                  onArchive={async (contact) => {
                    try {
                      await archiveCarrierContact({ id: contact.id, expectedUpdatedAt: contact.updatedAt })
                      await refresh()
                      toast.success('Contact archived')
                    } catch (e) {
                      reportFailure(e, 'Archive failed')
                    }
                  }}
                />
              )}

              {tab === 'payment' && (
                <CarrierPaymentEditor
                  methods={bundle.paymentMethods}
                  onSave={savePaymentMethod}
                  onArchive={async (method) => {
                    try {
                      await archiveCarrierPaymentMethod({ id: method.id, expectedUpdatedAt: method.updatedAt })
                      await refresh()
                      toast.success('Payment method archived')
                    } catch (e) {
                      reportFailure(e, 'Archive failed')
                    }
                  }}
                />
              )}

              {tab === 'loads' && (
                <div className="space-y-2">
                  {bundle.loadCarriers.length === 0 && (
                    <p className="text-sm text-muted-foreground">This carrier has not been booked on a load yet.</p>
                  )}
                  {bundle.loadCarriers.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => navigate(`/shipments/${row.shipmentId}`)}
                      className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted/40"
                    >
                      <Badge variant="outline" className="text-[10px]">{row.status}</Badge>
                      <span className="font-medium">Load {row.loadId}</span>
                      {row.carrierRateCents != null && <span>${formatCents(row.carrierRateCents)}</span>}
                      {row.rateConStatus && (
                        <span className="text-xs text-muted-foreground">rate con {row.rateConStatus.toLowerCase()}</span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {row.bookedAt ? new Date(row.bookedAt).toLocaleDateString() : ''}
                        {row.dispatchedAt && ' · dispatched'}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {tab === 'activity' && (
                <div className="space-y-2">
                  {logsError && <p className="text-sm text-destructive">{logsError}</p>}
                  {!logs && !logsError && <p className="text-sm text-muted-foreground">Loading activity…</p>}
                  {logs && carrierLogs.length === 0 && (
                    <p className="text-sm text-muted-foreground">No recorded changes yet.</p>
                  )}
                  {carrierLogs.map((entry) => (
                    <div key={entry.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{entry.action}</Badge>
                        <span className="font-medium">{entry.entityType}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {entry.user} · {new Date(entry.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {Object.keys(entry.changes ?? {}).join(', ') || 'no field detail'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </ScrollArea>

        {statusOpen && carrier && (
          <CarrierStatusDialog
            carrier={carrier}
            isAdmin={isAdmin}
            onClose={() => setStatusOpen(false)}
            onConfirm={async (input) => {
              const next = await setCarrierStatus({
                id: carrier.id, expectedUpdatedAt: carrier.updatedAt, ...input,
              })
              replaceCarrier(next)
              onChanged(next)
              toast.success('Status updated')
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

/**
 * The editable half of the record. Keyed on the carrier's `updatedAt` by its parent, so a
 * successful save reseeds the draft from the server's answer without an effect.
 */
function CarrierDraft({ carrier, section, warnDays, now, onSave }: {
  carrier: CarrierRecord
  section: 'profile' | 'equipment' | 'compliance'
  warnDays: number
  now: string
  onSave: (patch: CarrierPatch) => Promise<void>
}) {
  const [value, setValue] = useState<CarrierFormValue>(() => carrierFormFrom(carrier))
  const [policies, setPolicies] = useState<InsurancePolicy[]>(() => [...(carrier.insurancePolicies ?? [])])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const driverOos = oosBps(carrier.driverInspections, carrier.driverOos)
  const vehicleOos = oosBps(carrier.vehicleInspections, carrier.vehicleOos)

  const save = async () => {
    const invalid = carrierFormError(value)
    if (invalid) { setError(invalid); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(carrierFormInput(value, policies))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <CarrierForm
        value={value}
        set={(key, next) => setValue((prev) => ({ ...prev, [key]: next }))}
        section={section === 'profile' ? 'identity' : section}
      />

      {section === 'compliance' && (
        <>
          <p className="text-xs text-muted-foreground">
            Driver out-of-service {driverOos == null ? '—' : `${(driverOos / 100).toFixed(2)}%`} ·
            {' '}vehicle out-of-service {vehicleOos == null ? '—' : `${(vehicleOos / 100).toFixed(2)}%`}
          </p>
          <section>
            <h3 className="mb-3 text-sm font-semibold">Insurance</h3>
            <InsurancePoliciesEditor
              policies={policies}
              warnDays={warnDays}
              now={now}
              onChange={setPolicies}
            />
          </section>
        </>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save carrier'}</Button>
      </div>
    </div>
  )
}
