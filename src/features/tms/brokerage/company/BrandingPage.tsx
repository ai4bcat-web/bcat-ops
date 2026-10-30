/**
 * My Brokerage → Company → Branding.
 *
 * Org look-and-feel: three logo keys, accent colour, theme mode, default sender
 * addresses per message type, the e-mail signature template, and the white-label
 * domain request form with its DNS records.
 */
import { useEffect, useRef, useState } from 'react'
import { Palette, Save, Upload } from 'lucide-react'
import { getUrl } from 'aws-amplify/storage'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, listDivisions, saveTmsSettings, uploadBrandAsset } from '@/lib/apiClient'
import type { TmsSettings } from '@/types/tms'
import {
  BRAND_ACCENTS,
  BRAND_SENDER_SLOTS,
  BRAND_THEMES,
  SIGNATURE_TOKENS,
  renderSignature,
} from '@/lib/brokerage/branding'
import { dnsRecordsFor, normalizeDomain } from '@/lib/brokerage/whiteLabel'
import { ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { useAuthUser } from '@/hooks/useAuth'

const SENDER_LABELS: Record<(typeof BRAND_SENDER_SLOTS)[number], string> = {
  shipment: 'Shipment notices',
  rateCon: 'Rate confirmations',
  quoteReply: 'Quote replies',
  customerInvoice: 'Customer invoices',
  remittance: 'Remittance advice',
}

const THEME_OPTIONS = BRAND_THEMES.map((t) => ({ value: t, label: t }))
const ACCENT_OPTIONS = BRAND_ACCENTS.map((a) => ({ value: a, label: a }))

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function logoKeyOf(slot: 'square' | 'wide' | 'document'): keyof TmsSettings {
  if (slot === 'square') return 'brandLogoSquareKey'
  if (slot === 'wide') return 'brandLogoWideKey'
  return 'brandLogoDocumentKey'
}

function logoLabel(slot: 'square' | 'wide' | 'document'): string {
  if (slot === 'square') return 'Square logo'
  if (slot === 'wide') return 'Wide logo'
  return 'Document logo'
}

export function BrandingPage() {
  const user = useAuthUser()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [draft, setDraft] = useState<Partial<Pick<
    TmsSettings,
    | 'brandLogoSquareKey'
    | 'brandLogoWideKey'
    | 'brandLogoDocumentKey'
    | 'brandAccent'
    | 'brandTheme'
    | 'brandSenders'
    | 'emailSignatureTemplate'
  >>>({})
  const [whiteLabelDomain, setWhiteLabelDomain] = useState('')
  const [primaryName, setPrimaryName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<Record<'square' | 'wide' | 'document', boolean>>({
    square: false,
    wide: false,
    document: false,
  })
  const [logoUrls, setLogoUrls] = useState<Record<'square' | 'wide' | 'document', string | null>>({
    square: null,
    wide: null,
    document: null,
  })
  const [error, setError] = useState<string | null>(null)
  const fileInputRefs = {
    square: useRef<HTMLInputElement>(null),
    wide: useRef<HTMLInputElement>(null),
    document: useRef<HTMLInputElement>(null),
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([getTmsSettings(), listDivisions()])
      .then(async ([s, divisions]) => {
        if (cancelled) return
        setSettings(s)
        setDraft({
          brandLogoSquareKey: s?.brandLogoSquareKey ?? null,
          brandLogoWideKey: s?.brandLogoWideKey ?? null,
          brandLogoDocumentKey: s?.brandLogoDocumentKey ?? null,
          brandAccent: s?.brandAccent ?? null,
          brandTheme: s?.brandTheme ?? null,
          brandSenders: s?.brandSenders ?? null,
          emailSignatureTemplate: s?.emailSignatureTemplate ?? null,
        })
        setWhiteLabelDomain(s?.whiteLabel?.domain ?? '')
        const primary = divisions.find((d) => d.isPrimary) ?? divisions[0]
        setPrimaryName(primary?.name ?? null)
        const urls = await Promise.all([
          s?.brandLogoSquareKey
            ? getUrl({ path: s.brandLogoSquareKey, options: { expiresIn: 3600 } })
                .then((result) => result.url.toString())
                .catch(() => null)
            : Promise.resolve(null),
          s?.brandLogoWideKey
            ? getUrl({ path: s.brandLogoWideKey, options: { expiresIn: 3600 } })
                .then((result) => result.url.toString())
                .catch(() => null)
            : Promise.resolve(null),
          s?.brandLogoDocumentKey
            ? getUrl({ path: s.brandLogoDocumentKey, options: { expiresIn: 3600 } })
                .then((result) => result.url.toString())
                .catch(() => null)
            : Promise.resolve(null),
        ])
        if (cancelled) return
        setLogoUrls({ square: urls[0], wide: urls[1], document: urls[2] })
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

  const setField = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setDraft((prev) => ({ ...prev, [k]: v }))
  }

  const setSender = (slot: (typeof BRAND_SENDER_SLOTS)[number], value: string) => {
    setDraft((prev) => ({
      ...prev,
      brandSenders: { ...(prev.brandSenders ?? {}), [slot]: value || null },
    }))
  }

  const handleLogoSelect = async (slot: 'square' | 'wide' | 'document', file: File | undefined) => {
    if (!file) return
    setUploading((prev) => ({ ...prev, [slot]: true }))
    setError(null)
    try {
      const result = await uploadBrandAsset(file, 'brand/logos')
      setDraft((prev) => ({ ...prev, [logoKeyOf(slot)]: result.key }))
      setLogoUrls((prev) => ({ ...prev, [slot]: result.url }))
      toast.success(`${logoLabel(slot)} uploaded`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setUploading((prev) => ({ ...prev, [slot]: false }))
    }
  }

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const patch: Parameters<typeof saveTmsSettings>[0] = {
        brandLogoSquareKey: draft.brandLogoSquareKey,
        brandLogoWideKey: draft.brandLogoWideKey,
        brandLogoDocumentKey: draft.brandLogoDocumentKey,
        brandAccent: draft.brandAccent,
        brandTheme: draft.brandTheme,
        brandSenders: draft.brandSenders,
        emailSignatureTemplate: draft.emailSignatureTemplate,
        whiteLabel: whiteLabelDomain.trim()
          ? { domain: normalizeDomain(whiteLabelDomain), status: 'PENDING', records: [] }
          : null,
      }
      const saved = await saveTmsSettings(patch, settings.updatedAt ?? undefined)
      setSettings(saved)
      setWhiteLabelDomain(saved?.whiteLabel?.domain ?? '')
      toast.success('Branding saved')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const dnsRecords = (() => {
    const domain = whiteLabelDomain.trim() || settings?.whiteLabel?.domain
    if (!domain) return []
    try {
      return dnsRecordsFor(domain, 'app')
    } catch {
      return []
    }
  })()

  const signaturePreview = renderSignature(
    draft.emailSignatureTemplate ?? '',
    { name: user?.email, title: null, phone: null },
    { name: primaryName },
  )

  if (loading) {
    return (
      <TmsCard>
        <Loading />
      </TmsCard>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={Palette}
        title="Branding"
        description="Logos, colours, senders and the e-mail signature that customer-facing messages carry."
        actions={
          <TmsButton variant="primary" onClick={() => void handleSave()} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </TmsButton>
        }
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}

          <Panel>
            <GroupLabel>Logos</GroupLabel>
            <div style={{ display: 'grid', gap: 16 }}>
              {(['square', 'wide', 'document'] as const).map((slot) => (
                <div key={slot}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                    {logoUrls[slot] ? (
                      <img
                        src={logoUrls[slot] ?? undefined}
                        alt={logoLabel(slot)}
                        style={{ maxHeight: slot === 'square' ? 64 : 40, maxWidth: 200, objectFit: 'contain' }}
                      />
                    ) : (
                      <span className="tms-muted">No {logoLabel(slot).toLowerCase()} uploaded</span>
                    )}
                    <TmsButton
                      size="sm"
                      onClick={() => fileInputRefs[slot].current?.click()}
                      disabled={uploading[slot]}
                    >
                      <Upload size={14} /> {uploading[slot] ? 'Uploading…' : `Upload ${logoLabel(slot).toLowerCase()}`}
                    </TmsButton>
                    <input
                      ref={fileInputRefs[slot]}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/svg+xml"
                      style={{ display: 'none' }}
                      onChange={(e) => { void handleLogoSelect(slot, e.target.files?.[0]); e.target.value = '' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <div className="tms-grid tms-grid-2">
            <Panel>
              <GroupLabel>Appearance</GroupLabel>
              <TmsField label="Accent colour">
                <TmsSelect
                  value={draft.brandAccent ?? ''}
                  onChange={(e) => setField('brandAccent', (e.target.value as TmsSettings['brandAccent']) || null)}
                  options={[{ value: '', label: 'Use default' }, ...ACCENT_OPTIONS]}
                />
              </TmsField>
              <TmsField label="Theme">
                <TmsSelect
                  value={draft.brandTheme ?? ''}
                  onChange={(e) => setField('brandTheme', (e.target.value as TmsSettings['brandTheme']) || null)}
                  options={[{ value: '', label: 'Use default' }, ...THEME_OPTIONS]}
                />
                {draft.brandTheme && draft.brandTheme !== 'DARK' ? (
                  <p className="tms-field-hint" style={{ marginTop: 6 }}>
                    Only the dark theme is built; LIGHT and SYSTEM will follow.
                  </p>
                ) : null}
              </TmsField>
            </Panel>

            <Panel>
              <GroupLabel>Default senders</GroupLabel>
              <div className="tms-grid tms-grid-1">
                {BRAND_SENDER_SLOTS.map((slot) => (
                  <TmsField key={slot} label={SENDER_LABELS[slot]}>
                    <TmsInput
                      type="email"
                      value={draft.brandSenders?.[slot] ?? ''}
                      onChange={(e) => setSender(slot, e.target.value)}
                      placeholder="no-reply@example.com"
                    />
                  </TmsField>
                ))}
              </div>
            </Panel>
          </div>

          <Panel>
            <GroupLabel>E-mail signature</GroupLabel>
            <TmsField
              label="Template"
              hint={
                <span>
                  Tokens:{' '}
                  {SIGNATURE_TOKENS.map((t) => `{${t}}`).join(', ')}
                </span>
              }
            >
              <TmsTextarea
                rows={6}
                value={draft.emailSignatureTemplate ?? ''}
                onChange={(e) => setField('emailSignatureTemplate', e.target.value || null)}
                placeholder="Best regards,\n{name}\n{title} | {phone}\n{company}"
              />
            </TmsField>
            <div style={{ background: 'var(--tms-bg-elevated)', padding: 12, borderRadius: 'var(--tms-radius)' }}>
              <div className="tms-field-label" style={{ marginBottom: 6 }}>Preview</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{signaturePreview || 'No signature template yet.'}</div>
              <p className="tms-field-hint" style={{ marginTop: 8 }}>Preview uses your e-mail for {'{name}'}.</p>
            </div>
          </Panel>

          <Panel>
            <GroupLabel>White-label domain</GroupLabel>
            <TmsField label="Domain">
              <TmsInput
                value={whiteLabelDomain}
                onChange={(e) => setWhiteLabelDomain(e.target.value)}
                placeholder="portal.bcatcorp.com"
              />
            </TmsField>
            {settings?.whiteLabel?.status === 'PENDING' ? (
              <span className="tms-badge tms-badge-yellow" style={{ alignSelf: 'flex-start' }}>PENDING</span>
            ) : null}
            {dnsRecords.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <div className="tms-field-label">DNS records</div>
                {dnsRecords.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '80px 1fr 1fr',
                      gap: 12,
                      fontSize: 13,
                      padding: '8px 10px',
                      background: 'var(--tms-bg-elevated)',
                      borderRadius: 'var(--tms-radius)',
                    }}
                  >
                    <span>{r.type}</span>
                    <span style={{ wordBreak: 'break-all' }}>{r.name}</span>
                    <span style={{ wordBreak: 'break-all' }}>{r.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </Panel>
        </Stack>
      </SettingsCard>
    </div>
  )
}

export default BrandingPage
