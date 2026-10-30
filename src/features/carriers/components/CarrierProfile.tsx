/**
 * One carrier, everything about them, in a sheet over the board — the same shape as the
 * customer profile, on the MVMNT kit: a header strip with the status and the compliance
 * badges, the eight tabs, and a card per section.
 *
 * The sheet carries `tms-portal` because Radix renders it into `document.body`, outside
 * `.tms-shell`, where the dark tokens would not otherwise reach.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Banknote, Bot, Building2, ExternalLink, FileText, History, Phone, Send, Shield, Truck, Wallet, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsDialog, TmsField, TmsIconButton, TmsInput, TmsTabs } from '@/features/tms/kit'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCarrier } from '@/hooks/useCarrier'
import { useCarrierAp } from '@/hooks/useCarrierAp'
import {
  archiveCarrierContact, archiveCarrierPaymentMethod, commitCarrierDocument, deleteCarrierDocument,
  getCarrierDocumentUrl, graphqlErrorText, listAuditLogs, prepareCarrierDocument,
  sendCarrierSetupPacket, setCarrierStatus, upsertCarrier, upsertCarrierContact,
  upsertCarrierPaymentMethod, uploadCarrierDocumentFile,
} from '@/lib/apiClient'
import type { UpsertCarrierInput } from '@/lib/apiClient'
import { insuranceState, oosBps } from '@/lib/carrierEligibility'
import {
  CARRIER_STATUS_LABELS, CARRIER_STATUS_REASON_LABELS, effectiveCarrierStatus,
} from '@/lib/carrierStatus'
import { formatCents } from '@/lib/tmsDirectory'
import {
  DEFAULT_INSURANCE_WARN_DAYS, DEFAULT_REQUIRED_CARRIER_DOCS, INSURANCE_STATE_TONE,
} from '../carrierViews'
import { PartyAiMemoryTab } from '@/features/tms/settings/AiAgentsPage'
import { CarrierApTab } from './CarrierApTab'
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
import type { TmsTone } from '@/features/tms/kit'
import type {
  AiAgentKey, CarrierDocumentType, CarrierRecord, CarrierStatus, InsurancePolicy, PartyAiMemory,
  TmsSettings,
} from '@/types/tms'

const TABS = [
  { key: 'profile', label: 'Profile', icon: Building2 },
  { key: 'compliance', label: 'Compliance', icon: Shield },
  { key: 'contacts', label: 'Contacts', icon: Phone },
  { key: 'payment', label: 'Payment', icon: Wallet },
  { key: 'ap', label: 'AP', icon: Banknote },
  { key: 'equipment', label: 'Equipment', icon: Truck },
  { key: 'aiAgents', label: 'AI Agents', icon: Bot },
  { key: 'loads', label: 'Shipments', icon: FileText },
  { key: 'activity', label: 'Activity', icon: History },
]

/** The two agents that ever read a carrier: their mail is invoices and capacity. */
const CARRIER_AGENTS: readonly AiAgentKey[] = ['AP', 'CAPACITY']

const STATUS_TONE: Record<CarrierStatus, TmsTone> = {
  PENDING: 'orange',
  REVIEW: 'blue',
  ACTIVE: 'green',
  INACTIVE: 'gray',
  DO_NOT_USE: 'red',
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
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupEmail, setSetupEmail] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)
  const ap = useCarrierAp(carrierId)

  /**
   * Bills already approved and still unpaid — the money a missing payment method is
   * actually holding up. TO_BE_PAID and PARTIAL are approved; IN_REVIEW is not agreed
   * to yet, and a bill nobody has approved is not waiting on the bank details.
   */
  const awaitingPayment = useMemo(() => {
    let count = 0
    let cents = 0
    for (const bill of ap.bills) {
      if (bill.status !== 'TO_BE_PAID' && bill.status !== 'PARTIAL') continue
      count += 1
      cents += bill.balanceCents
    }
    return { count, cents }
  }, [ap.bills])

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

  // Widened past `CarrierPatch` so the AI Agents tab can send `aiMemory` through the
  // same door the form uses: `UPSERT_CARRIER` is the carrier's only write path.
  const saveCarrier = async (patch: Omit<UpsertCarrierInput, 'id' | 'expectedUpdatedAt'>) => {
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

  const openSetupPacket = () => {
    if (!carrier) return
    setSetupEmail(carrier.email ?? '')
    setSetupOpen(true)
  }

  const handleSendSetupPacket = async () => {
    if (!carrier || !setupEmail.trim()) return
    setSetupBusy(true)
    try {
      const result = await sendCarrierSetupPacket({ carrierId: carrier.id, email: setupEmail.trim() })
      toast.success(result.message)
      setSetupOpen(false)
      setSetupEmail('')
    } catch (e) {
      reportFailure(e, 'Setup packet failed')
    } finally {
      setSetupBusy(false)
    }
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
      <SheetContent className="tms-portal w-full sm:max-w-4xl flex flex-col p-0 bg-[var(--tms-bg)]">
        <div className="flex flex-col gap-2 p-4" style={{ borderBottom: '1px solid var(--tms-border)' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
                {carrier?.name ?? (loading ? 'Loading…' : 'Carrier')}
                {effective && (
                  <TmsBadge tone={STATUS_TONE[effective.status]}>
                    {CARRIER_STATUS_LABELS[effective.status]}
                  </TmsBadge>
                )}
                {effective?.derived && <span className="text-[10px] tms-muted">(derived)</span>}
              </DialogPrimitive.Title>
              {carrier && (
                <p className="text-xs tms-muted">
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
              {carrier && (
                <TmsButton size="sm" onClick={openSetupPacket}>
                  <Send size={14} />
                  Send setup packet
                </TmsButton>
              )}
              {carrier && <TmsButton size="sm" onClick={() => setStatusOpen(true)}>Change status</TmsButton>}
              <TmsIconButton shape="plain" aria-label="Close" onClick={onClose}><X size={16} /></TmsIconButton>
            </div>
          </div>

          {effective && effective.reason && (
            <p
              className="p-2 text-xs"
              style={{ border: '1px solid var(--tms-badge-red)', borderRadius: 'var(--tms-radius)' }}
            >
              {CARRIER_STATUS_REASON_LABELS[effective.reason]}
              {carrier?.statusNote && <> — {carrier.statusNote}</>}
            </p>
          )}

          {carrier && (
            <div className="flex flex-wrap gap-1">
              {carrier.highwayStatus && <TmsBadge tone="gray">Highway {carrier.highwayStatus}</TmsBadge>}
              {carrier.rmisStatus && <TmsBadge tone="gray">RMIS {carrier.rmisStatus}</TmsBadge>}
              {carrier.mcpStatus && <TmsBadge tone="gray">MCP {carrier.mcpStatus}</TmsBadge>}
              {(carrier.insurancePolicies ?? []).map((policy) => {
                const state = insuranceState(policy, now, warnDays)
                return (
                  <TmsBadge key={policy.id} tone={INSURANCE_STATE_TONE[state]}>
                    {policy.type.replace(/_/g, ' ').toLowerCase()} · {state.toLowerCase()}
                  </TmsBadge>
                )
              })}
            </div>
          )}

          <TmsTabs
            tabs={TABS.map((t) => ({ key: t.key, label: t.label }))}
            active={tab}
            onSelect={setTab}
          />
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
          {error && <p style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
          {!bundle && loading && <p className="tms-muted">Loading…</p>}

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
                <TmsCard title="Documents">
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
                </TmsCard>
              )}

              {tab === 'contacts' && (
                <TmsCard title="Contacts">
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
                </TmsCard>
              )}

              {tab === 'payment' && (
                <TmsCard title="Payment methods">
                  <CarrierPaymentEditor
                    methods={bundle.paymentMethods}
                    awaitingPayment={awaitingPayment}
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
                </TmsCard>
              )}

              {tab === 'ap' && (
                <CarrierApTab
                  carrierId={carrier.id}
                  bills={ap.bills}
                  payments={ap.payments}
                  openCents={ap.openCents}
                  unappliedCents={ap.unappliedCents}
                  loading={ap.loading}
                  error={ap.error}
                  onRefresh={ap.refresh}
                />
              )}

              {tab === 'aiAgents' && (
                <PartyAiMemoryTab
                  partyId={carrier.id}
                  partyWord="carrier"
                  agents={CARRIER_AGENTS}
                  memory={carrier.aiMemory}
                  onSave={(aiMemory: PartyAiMemory) => saveCarrier({ aiMemory })}
                />
              )}

              {tab === 'loads' && (
                <TmsCard title="Shipments">
                  <div className="flex flex-col gap-2">
                    {bundle.loadCarriers.length === 0 && (
                      <p className="tms-muted">This carrier has not been booked on a shipment yet.</p>
                    )}
                    {bundle.loadCarriers.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => navigate(`/tms/shipments/${row.shipmentId}`)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left"
                        style={{
                          border: '1px solid var(--tms-border)',
                          borderRadius: 'var(--tms-radius)',
                          background: 'none',
                          color: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        <TmsBadge tone="gray">{row.status}</TmsBadge>
                        <span className="font-medium">Shipment {row.shipmentId}</span>
                        {row.carrierRateCents != null && <span>${formatCents(row.carrierRateCents)}</span>}
                        {row.rateConStatus && (
                          <span className="text-xs tms-muted">rate con {row.rateConStatus.toLowerCase()}</span>
                        )}
                        <span className="ml-auto text-xs tms-muted">
                          {row.bookedAt ? new Date(row.bookedAt).toLocaleDateString() : ''}
                          {row.dispatchedAt && ' · dispatched'}
                        </span>
                      </button>
                    ))}
                  </div>
                </TmsCard>
              )}

              {tab === 'activity' && (
                <TmsCard title="Activity">
                  <div className="flex flex-col gap-2">
                    {logsError && <p style={{ color: 'var(--tms-badge-red)' }}>{logsError}</p>}
                    {!logs && !logsError && <p className="tms-muted">Loading activity…</p>}
                    {logs && carrierLogs.length === 0 && <p className="tms-muted">No recorded changes yet.</p>}
                    {carrierLogs.map((entry) => (
                      <div
                        key={entry.id}
                        className="px-3 py-2"
                        style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
                      >
                        <div className="flex items-center gap-2">
                          <TmsBadge tone="gray">{entry.action}</TmsBadge>
                          <span className="font-medium">{entry.entityType}</span>
                          <span className="ml-auto text-xs tms-muted">
                            {entry.user} · {new Date(entry.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="mt-1 text-xs tms-muted">
                          {Object.keys(entry.changes ?? {}).join(', ') || 'no field detail'}
                        </p>
                      </div>
                    ))}
                  </div>
                </TmsCard>
              )}
            </>
          )}
        </div>

        {setupOpen && carrier && (
          <TmsDialog
            open
            onOpenChange={(v) => { if (!v) { setSetupOpen(false); setSetupEmail('') } }}
            title={`Send setup packet — ${carrier.name}`}
            footer={
              <>
                <TmsButton variant="ghost" size="sm" onClick={() => { setSetupOpen(false); setSetupEmail('') }} disabled={setupBusy}>Cancel</TmsButton>
                <TmsButton variant="primary" size="sm" onClick={handleSendSetupPacket} disabled={setupBusy || !setupEmail.trim()}>
                  {setupBusy ? 'Sending…' : 'Send'}
                </TmsButton>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <p className="tms-muted text-sm">
                Sends a MyCarrierPackets setup packet to {carrier.name}.
              </p>
              <TmsField label="E-mail" htmlFor="setup-packet-email">
                <TmsInput
                  id="setup-packet-email"
                  type="email"
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  placeholder="dispatch@carrier.com"
                />
              </TmsField>
            </div>
          </TmsDialog>
        )}

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

  const title = section === 'profile' ? 'Carrier' : section === 'equipment' ? 'Equipment' : 'Compliance'

  return (
    <TmsCard
      title={title}
      actions={<TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save carrier'}</TmsButton>}
    >
      <div className="flex flex-col gap-5">
        <CarrierForm
          value={value}
          set={(key, next) => setValue((prev) => ({ ...prev, [key]: next }))}
          section={section === 'profile' ? 'identity' : section}
        />

        {section === 'compliance' && (
          <>
            <p className="text-xs tms-muted">
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

        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsCard>
  )
}
