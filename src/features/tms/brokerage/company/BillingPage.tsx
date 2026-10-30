/**
 * My Brokerage → Company → Billing.
 *
 * One billing entity at a time: its remit-to block, how to pay it in each country,
 * the footer that appears on every invoice, and the contacts for billing and
 * payables. Below that, the org-level payment terms table applies to every entity.
 */
import { useEffect, useMemo, useState } from 'react'
import { Building2, Plus, Save, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsField,
  TmsIconButton,
  TmsInput,
  TmsTable,
  TmsTextarea,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { CheckRow, ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { getTmsSettings, listDivisions, saveDivision, saveTmsSettings } from '@/lib/apiClient'
import type { Address, Division, DivisionContact, PaymentInstructions, PaymentTerm, TmsSettings } from '@/types/tms'

function emptyAddress(): Address {
  return { street: null, city: null, state: null, zip: null, country: null }
}

function emptyContact(): DivisionContact {
  return { name: null, title: null, email: null, phone: null }
}

function emptyInstructions(): PaymentInstructions {
  return {
    US: { ach: null, wire: null, check: null },
    CA: { eft: null, check: null },
    MX: { spei: null, check: null },
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function bpsToPercent(bps: number | null | undefined): string {
  if (bps == null) return ''
  return (bps / 100).toFixed(2)
}

function percentToBps(text: string): number | null {
  const n = Number(text)
  if (text === '' || Number.isNaN(n)) return null
  return Math.round(n * 100)
}

function instructionLines(pi: PaymentInstructions | null | undefined, country: 'US' | 'CA' | 'MX'): string[] {
  const block = pi?.[country]
  if (!block) return []
  const labels: Record<string, Record<string, string>> = {
    US: { ach: 'ACH', wire: 'Wire', check: 'Check' },
    CA: { eft: 'EFT', check: 'Check' },
    MX: { spei: 'SPEI', check: 'Check' },
  }
  return Object.entries(block)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${labels[country][k] ?? k}: ${v}`)
}

function previewFooter(division: Division | null, verbiage: string): string {
  const lines: string[] = []
  if (verbiage.trim()) lines.push(verbiage.trim())
  const remit = division?.remitToName ?? division?.legalName ?? division?.name
  if (remit) {
    lines.push(`Remit to: ${remit}`)
  }
  for (const country of ['US', 'CA', 'MX'] as const) {
    const inst = instructionLines(division?.paymentInstructions, country)
    if (inst.length) lines.push(`${country}: ${inst.join(' · ')}`)
  }
  return lines.join('\n')
}

export function BillingPage() {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingEntity, setSavingEntity] = useState(false)
  const [savingTerms, setSavingTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState<Division | null>(null)
  const [terms, setTerms] = useState<PaymentTerm[]>([])
  const [defaultKey, setDefaultKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listDivisions(), getTmsSettings()])
      .then(([divisionRows, s]) => {
        if (cancelled) return
        setDivisions(divisionRows)
        const primary = divisionRows.find((d) => d.isPrimary) ?? divisionRows[0]
        setSelectedId(primary?.id ?? null)
        setDraft(primary ? { ...primary } : null)
        setSettings(s)
        setTerms(s?.paymentTerms ?? [])
        setDefaultKey(s?.paymentTerms?.find((t) => t.days === s?.defaultPaymentTermsDays)?.key ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(messageOf(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selected = divisions.find((d) => d.id === selectedId)

  const set = <K extends keyof Division>(k: K, v: Division[K]) => {
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev))
  }

  const setRemitAddress = (field: keyof Address, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev.remitToAddress ?? emptyAddress()
      return { ...prev, remitToAddress: { ...current, [field]: value || null } }
    })
  }

  const setContact = (which: 'billingContact' | 'payablesContact', field: keyof DivisionContact, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev[which] ?? emptyContact()
      return { ...prev, [which]: { ...current, [field]: value || null } }
    })
  }

  const setPaymentInstruction = (
    country: 'US' | 'CA' | 'MX',
    method: string,
    value: string,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev.paymentInstructions ?? emptyInstructions()
      return {
        ...prev,
        paymentInstructions: {
          ...current,
          [country]: { ...(current[country] ?? {}), [method]: value || null },
        },
      }
    })
  }

  const saveEntity = async () => {
    if (!draft || !selected) return
    setSavingEntity(true)
    setError(null)
    try {
      const saved = await saveDivision(draft, selected.updatedAt)
      setDivisions((prev) => prev.map((d) => (d.id === saved.id ? saved : d)))
      setDraft({ ...saved })
      toast.success('Billing entity saved')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSavingEntity(false)
    }
  }

  const savePaymentTerms = async () => {
    if (!settings) return
    setSavingTerms(true)
    setError(null)
    try {
      const keys = new Set<string>()
      for (const term of terms) {
        if (!term.name.trim()) { setError('Every payment term needs a name.'); return }
        if (keys.has(term.key)) { setError(`Duplicate payment term key: ${term.key}.`); return }
        keys.add(term.key)
        if (term.days < 0 || term.days > 180) { setError(`${term.name}: days must be between 0 and 180.`); return }
        if (term.quickPayFeeBps != null && (term.quickPayFeeBps < 0 || term.quickPayFeeBps > 2000)) {
          setError(`${term.name}: quick-pay fee must be between 0% and 20%.`)
          return
        }
      }
      if (defaultKey) {
        const defaultTerm = terms.find((t) => t.key === defaultKey)
        if (!defaultTerm) { setError('The default payment term no longer exists.'); return }
        if (defaultTerm.doNotUse) { setError('A do-not-use term cannot be the default.'); return }
      }

      const patch: Parameters<typeof saveTmsSettings>[0] = {
        paymentTerms: terms.length ? terms : null,
        defaultPaymentTermsDays: defaultKey ? terms.find((t) => t.key === defaultKey)?.days ?? null : null,
      }
      const saved = await saveTmsSettings(patch, settings.updatedAt ?? undefined)
      setSettings(saved)
      setTerms(saved.paymentTerms ?? [])
      setDefaultKey(saved.defaultPaymentTermsDays ? saved.paymentTerms?.find((t) => t.days === saved.defaultPaymentTermsDays)?.key ?? null : null)
      toast.success('Payment terms saved')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSavingTerms(false)
    }
  }

  const addTerm = () => {
    setTerms((prev) => {
      const base = `term-${prev.length + 1}`
      let key = base
      let i = 1
      while (prev.some((t) => t.key === key)) {
        key = `${base}-${i}`
        i += 1
      }
      return [...prev, { key, name: '', days: 30, description: null, quickPayFeeBps: null, apOnly: false, doNotUse: false }]
    })
  }

  const updateTerm = (index: number, patch: Partial<PaymentTerm>) => {
    setTerms((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }

  const removeTerm = (index: number) => {
    setTerms((prev) => {
      const next = prev.filter((_, i) => i !== index)
      if (defaultKey && !next.some((t) => t.key === defaultKey)) setDefaultKey(null)
      return next
    })
  }

  const termColumns = useMemo(
    (): Array<ColumnDef<PaymentTerm>> => [
      { key: 'name', header: 'Name', render: (row) => row.name },
      { key: 'days', header: 'Days', width: 70, render: (row) => String(row.days) },
      { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
      { key: 'fee', header: 'Quick-pay fee', width: 110, render: (row) => (row.quickPayFeeBps != null ? `${bpsToPercent(row.quickPayFeeBps)}%` : '—') },
      { key: 'apOnly', header: 'AP only', width: 80, render: (row) => (row.apOnly ? 'Yes' : '—') },
      { key: 'doNotUse', header: 'Do not use', width: 90, render: (row) => (row.doNotUse ? 'Yes' : '—') },
      { key: 'default', header: 'Default', width: 80, render: (row) => (row.key === defaultKey ? <Star size={14} /> : '—') },
    ],
    [defaultKey],
  )

  if (loading) {
    return (
      <TmsCard>
        <Loading />
      </TmsCard>
    )
  }

  const remitAddress = draft?.remitToAddress ?? emptyAddress()
  const billingContact = draft?.billingContact ?? emptyContact()
  const payablesContact = draft?.payablesContact ?? emptyContact()
  const instructions = draft?.paymentInstructions ?? emptyInstructions()

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <TmsCard title="Billing entity">
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Stack>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {divisions
              .slice()
              .sort((a, b) => (a.isPrimary === b.isPrimary ? a.name.localeCompare(b.name) : a.isPrimary ? -1 : 1))
              .map((d) => (
                <TmsButton
                  key={d.id}
                  size="sm"
                  variant={d.id === selectedId ? 'primary' : 'secondary'}
                  onClick={() => { setSelectedId(d.id); setDraft({ ...d }) }}
                >
                  {d.name}
                  {d.isPrimary ? <TmsBadge tone="green" style={{ marginLeft: 6 }}>Primary</TmsBadge> : null}
                </TmsButton>
              ))}
          </div>

          {draft ? (
            <>
              <Panel>
                <GroupLabel>Remit-to</GroupLabel>
                <TmsField label="Remit-to name">
                  <TmsInput value={draft.remitToName ?? ''} onChange={(e) => set('remitToName', e.target.value || null)} />
                </TmsField>
                <TmsField label="Remit-to email">
                  <TmsInput value={draft.remitToEmail ?? ''} onChange={(e) => set('remitToEmail', e.target.value || null)} />
                </TmsField>
                <TmsField label="Remit-to address">
                  <div className="tms-grid tms-grid-2">
                    <TmsInput aria-label="Street" value={remitAddress.street ?? ''} onChange={(e) => setRemitAddress('street', e.target.value)} placeholder="Street" />
                    <TmsInput aria-label="City" value={remitAddress.city ?? ''} onChange={(e) => setRemitAddress('city', e.target.value)} placeholder="City" />
                    <TmsInput aria-label="State" value={remitAddress.state ?? ''} onChange={(e) => setRemitAddress('state', e.target.value)} placeholder="State" />
                    <TmsInput aria-label="ZIP" value={remitAddress.zip ?? ''} onChange={(e) => setRemitAddress('zip', e.target.value)} placeholder="ZIP" />
                    <TmsInput aria-label="Country" value={remitAddress.country ?? ''} onChange={(e) => setRemitAddress('country', e.target.value)} placeholder="Country" />
                  </div>
                </TmsField>
              </Panel>

              <div className="tms-grid tms-grid-2">
                <Panel>
                  <GroupLabel>US payment instructions</GroupLabel>
                  <TmsField label="ACH">
                    <TmsInput value={instructions.US?.ach ?? ''} onChange={(e) => setPaymentInstruction('US', 'ach', e.target.value)} />
                  </TmsField>
                  <TmsField label="Wire">
                    <TmsInput value={instructions.US?.wire ?? ''} onChange={(e) => setPaymentInstruction('US', 'wire', e.target.value)} />
                  </TmsField>
                  <TmsField label="Check">
                    <TmsInput value={instructions.US?.check ?? ''} onChange={(e) => setPaymentInstruction('US', 'check', e.target.value)} />
                  </TmsField>
                </Panel>
                <Panel>
                  <GroupLabel>Canada payment instructions</GroupLabel>
                  <TmsField label="EFT">
                    <TmsInput value={instructions.CA?.eft ?? ''} onChange={(e) => setPaymentInstruction('CA', 'eft', e.target.value)} />
                  </TmsField>
                  <TmsField label="Check">
                    <TmsInput value={instructions.CA?.check ?? ''} onChange={(e) => setPaymentInstruction('CA', 'check', e.target.value)} />
                  </TmsField>
                </Panel>
                <Panel>
                  <GroupLabel>Mexico payment instructions</GroupLabel>
                  <TmsField label="SPEI">
                    <TmsInput value={instructions.MX?.spei ?? ''} onChange={(e) => setPaymentInstruction('MX', 'spei', e.target.value)} />
                  </TmsField>
                  <TmsField label="Check">
                    <TmsInput value={instructions.MX?.check ?? ''} onChange={(e) => setPaymentInstruction('MX', 'check', e.target.value)} />
                  </TmsField>
                </Panel>
                <Panel>
                  <GroupLabel>Invoice verbiage</GroupLabel>
                  <TmsField label="Footer text">
                    <TmsTextarea
                      rows={6}
                      value={draft.invoiceVerbiage ?? ''}
                      onChange={(e) => set('invoiceVerbiage', e.target.value || null)}
                      placeholder="Thank you for your business…"
                    />
                  </TmsField>
                </Panel>
              </div>

              <Panel style={{ background: 'var(--tms-bg-elevated)' }}>
                <GroupLabel>Preview</GroupLabel>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14 }}>
                  {previewFooter(draft, draft.invoiceVerbiage ?? '')}
                </pre>
              </Panel>

              <div className="tms-grid tms-grid-2">
                <Panel>
                  <GroupLabel>Billing contact</GroupLabel>
                  <TmsField label="Name">
                    <TmsInput value={billingContact.name ?? ''} onChange={(e) => setContact('billingContact', 'name', e.target.value)} />
                  </TmsField>
                  <TmsField label="Title">
                    <TmsInput value={billingContact.title ?? ''} onChange={(e) => setContact('billingContact', 'title', e.target.value)} />
                  </TmsField>
                  <TmsField label="Email">
                    <TmsInput value={billingContact.email ?? ''} onChange={(e) => setContact('billingContact', 'email', e.target.value)} />
                  </TmsField>
                  <TmsField label="Phone">
                    <TmsInput value={billingContact.phone ?? ''} onChange={(e) => setContact('billingContact', 'phone', e.target.value)} />
                  </TmsField>
                </Panel>
                <Panel>
                  <GroupLabel>Payables contact</GroupLabel>
                  <TmsField label="Name">
                    <TmsInput value={payablesContact.name ?? ''} onChange={(e) => setContact('payablesContact', 'name', e.target.value)} />
                  </TmsField>
                  <TmsField label="Title">
                    <TmsInput value={payablesContact.title ?? ''} onChange={(e) => setContact('payablesContact', 'title', e.target.value)} />
                  </TmsField>
                  <TmsField label="Email">
                    <TmsInput value={payablesContact.email ?? ''} onChange={(e) => setContact('payablesContact', 'email', e.target.value)} />
                  </TmsField>
                  <TmsField label="Phone">
                    <TmsInput value={payablesContact.phone ?? ''} onChange={(e) => setContact('payablesContact', 'phone', e.target.value)} />
                  </TmsField>
                </Panel>
              </div>

              <div>
                <TmsButton variant="primary" onClick={() => void saveEntity()} disabled={savingEntity}>
                  <Save size={14} /> {savingEntity ? 'Saving…' : 'Save entity'}
                </TmsButton>
              </div>
            </>
          ) : (
            <p className="tms-muted">No billing entity selected.</p>
          )}
        </Stack>
      </TmsCard>

      <SettingsCard
        icon={Building2}
        title="Payment terms"
        description="Terms offered across the organization. Days are net due; quick-pay fee is shown as a percentage but stored in basis points."
        actions={
          <TmsButton variant="primary" onClick={() => void savePaymentTerms()} disabled={savingTerms}>
            <Save size={14} /> {savingTerms ? 'Saving…' : 'Save terms'}
          </TmsButton>
        }
      >
        <Stack>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {terms.map((term, idx) => (
              <Panel key={term.key} style={{ flex: '1 1 320px', minWidth: 280 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <TmsInput
                    aria-label="Term name"
                    value={term.name}
                    onChange={(e) => updateTerm(idx, { name: e.target.value })}
                    placeholder="Net 30"
                    style={{ fontWeight: 600 }}
                  />
                  <TmsIconButton shape="plain" aria-label={`Remove ${term.name || 'term'}`} onClick={() => removeTerm(idx)}>
                    <Trash2 size={14} />
                  </TmsIconButton>
                </div>
                <div className="tms-grid tms-grid-2">
                  <TmsField label="Days">
                    <TmsInput
                      aria-label="Days"
                      inputMode="numeric"
                      value={term.days}
                      onChange={(e) => updateTerm(idx, { days: Number(e.target.value) || 0 })}
                    />
                  </TmsField>
                  <TmsField label="Quick-pay fee %">
                    <TmsInput
                      aria-label="Quick-pay fee percent"
                      inputMode="decimal"
                      value={bpsToPercent(term.quickPayFeeBps)}
                      onChange={(e) => updateTerm(idx, { quickPayFeeBps: percentToBps(e.target.value) })}
                      placeholder="1.50"
                    />
                  </TmsField>
                </div>
                <TmsField label="Description">
                  <TmsInput value={term.description ?? ''} onChange={(e) => updateTerm(idx, { description: e.target.value || null })} />
                </TmsField>
                <div style={{ display: 'flex', gap: 16 }}>
                  <CheckRow label="AP only" checked={term.apOnly === true} onChange={(v) => updateTerm(idx, { apOnly: v })} />
                  <CheckRow label="Do not use" checked={term.doNotUse === true} onChange={(v) => updateTerm(idx, { doNotUse: v })} />
                </div>
                <TmsButton
                  size="sm"
                  variant={term.key === defaultKey ? 'primary' : 'ghost'}
                  disabled={term.doNotUse === true}
                  onClick={() => setDefaultKey(term.key === defaultKey ? null : term.key)}
                >
                  {term.key === defaultKey ? 'Default' : 'Set as default'}
                </TmsButton>
              </Panel>
            ))}
          </div>

          <TmsButton size="sm" onClick={addTerm}>
            <Plus size={14} /> Add term
          </TmsButton>

          <TmsTable
            columns={termColumns}
            rows={terms}
            rowKey={(row) => row.key}
            empty={<span className="tms-muted">No payment terms defined.</span>}
          />
        </Stack>
      </SettingsCard>
    </div>
  )
}

export default BillingPage
