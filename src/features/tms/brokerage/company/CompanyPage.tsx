/**
 * My Brokerage → Company → Company.
 *
 * The primary billing entity's identity: the name, authority numbers, address and
 * contact printed on invoices and rate confirmations. On first open, if no division
 * carries `isPrimary`, the first `BCAT_LOGISTICS` division is promoted automatically.
 */
import { useEffect, useRef, useState } from 'react'
import { Building2, Save, Upload } from 'lucide-react'
import { getUrl } from 'aws-amplify/storage'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsField, TmsInput } from '@/features/tms/kit'
import { listDivisions, saveDivision, uploadBrandAsset } from '@/lib/apiClient'
import type { Address, Division, DivisionContact } from '@/types/tms'
import { ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'

function emptyAddress(): Address {
  return { street: null, city: null, state: null, zip: null, country: null }
}

function emptyContact(): DivisionContact {
  return { name: null, title: null, email: null, phone: null }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function PrintedOn({ children }: { children: string }) {
  return (
    <span className="tms-field-hint" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
      {children}
    </span>
  )
}

export function CompanyPage() {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [primary, setPrimary] = useState<Division | null>(null)
  const [draft, setDraft] = useState<Division | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const seededRef = useRef(false)

  const set = <K extends keyof Division>(k: K, v: Division[K]) => {
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev))
  }

  const setAddress = (field: keyof Address, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev.physicalAddress ?? emptyAddress()
      return { ...prev, physicalAddress: { ...current, [field]: value || null } }
    })
  }

  const setContact = (which: 'primaryContact', field: keyof DivisionContact, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev[which] ?? emptyContact()
      return { ...prev, [which]: { ...current, [field]: value || null } }
    })
  }

  useEffect(() => {
    let cancelled = false
    listDivisions()
      .then(async (rows) => {
        if (cancelled) return
        setError(null)
        setDivisions(rows)
        let candidate = rows.find((d) => d.isPrimary) ?? rows.find((d) => d.key === 'BCAT_LOGISTICS') ?? rows[0]

        // One-line seed: if nobody is primary yet, promote the first candidate automatically.
        if (candidate && !candidate.isPrimary && !seededRef.current) {
          seededRef.current = true
          candidate = await saveDivision({ ...candidate, isPrimary: true }, candidate.updatedAt)
          if (cancelled) return
          setDivisions((prev) => prev.map((d) => (d.id === candidate.id ? candidate : d)))
        }

        setPrimary(candidate ?? null)
        setDraft(candidate ? { ...candidate } : null)
        if (candidate?.logoKey) {
          try {
            const result = await getUrl({ path: candidate.logoKey, options: { expiresIn: 3600 } })
            if (!cancelled) setLogoUrl(result.url.toString())
          } catch {
            if (!cancelled) setLogoUrl(null)
          }
        } else {
          setLogoUrl(null)
        }
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

  const handleSave = async () => {
    if (!draft || !primary) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveDivision(draft, primary.updatedAt)
      setPrimary(saved)
      setDraft({ ...saved })
      setDivisions((prev) => prev.map((d) => (d.id === saved.id ? saved : d)))
      if (saved.logoKey) {
        try {
          const result = await getUrl({ path: saved.logoKey, options: { expiresIn: 3600 } })
          setLogoUrl(result.url.toString())
        } catch {
          setLogoUrl(null)
        }
      } else {
        setLogoUrl(null)
      }
      toast.success('Company details saved')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const handleLogoSelect = async (file: File | undefined) => {
    if (!file || !draft) return
    setUploadingLogo(true)
    setError(null)
    try {
      const result = await uploadBrandAsset(file, 'brand/logos')
      setDraft((prev) => (prev ? { ...prev, logoKey: result.key } : prev))
      setLogoUrl(result.url)
      toast.success('Logo uploaded')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setUploadingLogo(false)
    }
  }

  if (loading) {
    return (
      <TmsCard>
        <Loading />
      </TmsCard>
    )
  }

  if (!draft) {
    return (
      <TmsCard title="Company">
        <ErrorText>No division found. Create a division first.</ErrorText>
      </TmsCard>
    )
  }

  const physical = draft.physicalAddress ?? emptyAddress()
  const contact = draft.primaryContact ?? emptyContact()

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={Building2}
        title="Company identity"
        description="The legal identity printed on invoices, rate confirmations and other paperwork."
        actions={
          <TmsButton variant="primary" onClick={() => void handleSave()} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </TmsButton>
        }
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}

          <Panel>
            <GroupLabel>Legal identity</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Name">
                <TmsInput value={draft.name} onChange={(e) => set('name', e.target.value)} />
                <PrintedOn>Printed as the billing company name.</PrintedOn>
              </TmsField>
              <TmsField label="Legal name">
                <TmsInput value={draft.legalName ?? ''} onChange={(e) => set('legalName', e.target.value || null)} />
                <PrintedOn>Printed on contracts and legal paperwork when set.</PrintedOn>
              </TmsField>
              <TmsField label="MC #">
                <TmsInput value={draft.mcNumber ?? ''} onChange={(e) => set('mcNumber', e.target.value || null)} />
                <PrintedOn>Printed on rate confirmations and authority blocks.</PrintedOn>
              </TmsField>
              <TmsField label="DOT #">
                <TmsInput value={draft.dotNumber ?? ''} onChange={(e) => set('dotNumber', e.target.value || null)} />
                <PrintedOn>Printed on safety and authority paperwork.</PrintedOn>
              </TmsField>
              <TmsField label="SCAC">
                <TmsInput value={draft.scac ?? ''} onChange={(e) => set('scac', e.target.value || null)} />
                <PrintedOn>Printed on EDI and carrier interchange documents.</PrintedOn>
              </TmsField>
              <TmsField label="Tax ID (EIN)">
                <TmsInput value={draft.taxId ?? ''} onChange={(e) => set('taxId', e.target.value || null)} />
                <PrintedOn>Printed on tax documents and W-9 requests.</PrintedOn>
              </TmsField>
              <TmsField label="Phone">
                <TmsInput value={draft.phone ?? ''} onChange={(e) => set('phone', e.target.value || null)} />
                <PrintedOn>Printed on paperwork as the company phone.</PrintedOn>
              </TmsField>
              <TmsField label="Terms &amp; Conditions URL">
                <TmsInput value={draft.termsUrl ?? ''} onChange={(e) => set('termsUrl', e.target.value || null)} placeholder="https://…" />
                <PrintedOn>Printed as a link on every invoice.</PrintedOn>
              </TmsField>
            </div>
          </Panel>

          <Panel>
            <GroupLabel>Physical address</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Street">
                <TmsInput value={physical.street ?? ''} onChange={(e) => setAddress('street', e.target.value)} />
              </TmsField>
              <TmsField label="City">
                <TmsInput value={physical.city ?? ''} onChange={(e) => setAddress('city', e.target.value)} />
              </TmsField>
              <TmsField label="State">
                <TmsInput value={physical.state ?? ''} onChange={(e) => setAddress('state', e.target.value)} />
              </TmsField>
              <TmsField label="ZIP">
                <TmsInput value={physical.zip ?? ''} onChange={(e) => setAddress('zip', e.target.value)} />
              </TmsField>
              <TmsField label="Country">
                <TmsInput value={physical.country ?? ''} onChange={(e) => setAddress('country', e.target.value)} />
              </TmsField>
            </div>
            <PrintedOn>Printed on invoices and rate confirmations.</PrintedOn>
          </Panel>

          <Panel>
            <GroupLabel>Primary contact</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Name">
                <TmsInput value={contact.name ?? ''} onChange={(e) => setContact('primaryContact', 'name', e.target.value)} />
              </TmsField>
              <TmsField label="Title">
                <TmsInput value={contact.title ?? ''} onChange={(e) => setContact('primaryContact', 'title', e.target.value)} />
              </TmsField>
              <TmsField label="Email">
                <TmsInput value={contact.email ?? ''} onChange={(e) => setContact('primaryContact', 'email', e.target.value)} />
              </TmsField>
              <TmsField label="Phone">
                <TmsInput value={contact.phone ?? ''} onChange={(e) => setContact('primaryContact', 'phone', e.target.value)} />
              </TmsField>
            </div>
            <PrintedOn>Printed on paperwork as the main company contact.</PrintedOn>
          </Panel>

          <Panel>
            <GroupLabel>Logo</GroupLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {logoUrl ? (
                <img src={logoUrl} alt="Company logo" style={{ maxHeight: 64, maxWidth: 200, objectFit: 'contain' }} />
              ) : (
                <span className="tms-muted">No logo uploaded</span>
              )}
              <TmsButton
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingLogo}
              >
                <Upload size={14} /> {uploadingLogo ? 'Uploading…' : 'Upload logo'}
              </TmsButton>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/svg+xml"
                style={{ display: 'none' }}
                onChange={(e) => { void handleLogoSelect(e.target.files?.[0]); e.target.value = '' }}
              />
            </div>
            <PrintedOn>Printed on invoices and customer-facing documents.</PrintedOn>
          </Panel>
        </Stack>
      </SettingsCard>

      {divisions.length > 1 ? (
        <TmsCard title="Other billing entities">
          <p className="tms-field-hint" style={{ margin: '0 0 12px' }}>
            Edit remit-to and payment details for the other entities on the Billing page.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {divisions
              .filter((d) => d.id !== primary?.id)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((d) => (
                <div key={d.id} className="tms-muted" style={{ fontSize: 14 }}>
                  {d.name} <span style={{ fontSize: 12 }}>({d.key})</span>
                </div>
              ))}
          </div>
        </TmsCard>
      ) : null}
    </div>
  )
}

export default CompanyPage
