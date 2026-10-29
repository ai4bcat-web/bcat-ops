/**
 * My Brokerage → Divisions & ownership.
 *
 * Who earns a shipment is data: the division tree, the ordered rules that tag a
 * shipment, a preview that runs the rules against one real shipment, and a re-tag
 * that re-runs them over every rule-tagged row. Owner and ADMIN only — the server
 * enforces the same thing from the token, this page just refuses to waste the trip.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from 'lucide-react'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsDialog,
  TmsField,
  TmsInput,
  TmsSelect,
} from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import {
  archiveOwnershipDivision,
  ensureOwnershipSeed,
  listCarriers,
  listCustomers,
  listOwnershipDivisions,
  listOwnershipRules,
  listShipments,
  retagShipments,
  saveOwnershipDivision,
  saveOwnershipRules,
  testOwnershipRules,
} from '@/lib/apiClient'
import type { OwnershipRuleTest, RetagReport } from '@/lib/apiClient'
import { OWN_FLEET_CARRIER_CODE, validateDivisions, validateRules } from '@/lib/ownership'
import type {
  CarrierRecord,
  CustomerRecord,
  OwnershipConditionKind,
  OwnershipDivisionRecord,
  OwnershipRuleRecord,
} from '@/types/tms'
import {
  CONDITION_KINDS,
  CONDITION_KIND_LABELS,
  DRIVER_FLEET_GROUPS,
  DRIVER_PROGRAMS,
  DRIVER_TYPES,
  FLOW_SLOTS,
  OWNER_SLOTS,
  blankDivisionDraft,
  blankRuleDraft,
  descendantCodes,
  divisionOptions,
  divisionToDraft,
  divisionsWithDraft,
  draftToDivisionInput,
  draftsAsRuleRows,
  draftsToRuleInputs,
  flattenDivisions,
  inheritedFlow,
  inheritedOwner,
  isValidPattern,
  moveRule,
  partySuggestions,
  ruleDraftsFrom,
} from './taxonomyDrafts'
import type { DivisionDraft, RuleDraft } from './taxonomyDrafts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ── Division editor ──────────────────────────────────────────────────────────

function DivisionDialog({
  draft,
  divisions,
  open,
  busy,
  errors,
  onChange,
  onClose,
  onSave,
}: {
  draft: DivisionDraft
  divisions: OwnershipDivisionRecord[]
  open: boolean
  busy: boolean
  errors: string[]
  onChange: (next: DivisionDraft) => void
  onClose: () => void
  onSave: () => void
}) {
  const parentChoices = useMemo(
    () => divisionOptions(divisions, { exclude: draft.isNew ? undefined : descendantCodes(divisions, draft.code) }),
    [divisions, draft.isNew, draft.code],
  )
  const suggestions = useMemo(() => partySuggestions(divisions), [divisions])
  const parentId = draft.parentId.trim() || null

  return (
    <TmsDialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose() }}
      title={draft.isNew ? 'Add division' : `Edit ${draft.code}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save division'}
          </TmsButton>
        </>
      }
    >
      {errors.length > 0 ? (
        <ul className="tms-field-error" style={{ margin: '0 0 12px', paddingLeft: 18 }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="tms-grid tms-grid-3">
        <TmsField label="Code" hint={draft.isNew ? 'Permanent — shipments are tagged with it.' : 'Codes never change.'}>
          <TmsInput
            value={draft.code}
            disabled={!draft.isNew}
            onChange={(e) => onChange({ ...draft, code: e.target.value.toUpperCase() })}
          />
        </TmsField>
        <TmsField label="Name">
          <TmsInput value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </TmsField>
        <TmsField label="Brand" hint="Shown in brackets beside the name.">
          <TmsInput value={draft.brand} onChange={(e) => onChange({ ...draft, brand: e.target.value })} />
        </TmsField>
      </div>

      <div className="tms-grid tms-grid-4" style={{ marginTop: 12 }}>
        <TmsField label="Parent">
          <TmsSelect
            value={draft.parentId}
            placeholder="None — a top-level business"
            onChange={(e) => onChange({ ...draft, parentId: e.target.value })}
            options={parentChoices}
          />
        </TmsField>
        <TmsField label="Colour">
          <TmsInput
            type="color"
            value={draft.color || '#888888'}
            onChange={(e) => onChange({ ...draft, color: e.target.value })}
          />
        </TmsField>
        <TmsField label="Sort order">
          <TmsInput
            type="number"
            value={String(draft.sortOrder)}
            onChange={(e) => onChange({ ...draft, sortOrder: Number(e.target.value) || 0 })}
          />
        </TmsField>
        <TmsField label="Active">
          <label className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40 }}>
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => onChange({ ...draft, active: e.target.checked })}
            />
            Shipments may be tagged with it
          </label>
        </TmsField>
      </div>

      <h3 style={{ margin: '16px 0 8px' }}>Ownership settings</h3>
      <datalist id="tms-party-suggestions">
        {suggestions.map((party) => (
          <option key={party} value={party} />
        ))}
      </datalist>
      <div className="tms-grid tms-grid-3">
        {OWNER_SLOTS.map((slot) => {
          const inherited = inheritedOwner(divisions, parentId, slot.key)
          const own = draft.owners[slot.key]
          return (
            <TmsField
              key={slot.key}
              label={slot.label}
              hint={own === '' && inherited ? `Inherited: ${inherited}` : undefined}
            >
              <TmsInput
                list="tms-party-suggestions"
                value={own}
                placeholder={inherited ?? 'Nobody set'}
                className={own === '' ? 'tms-muted' : undefined}
                onChange={(e) => onChange({ ...draft, owners: { ...draft.owners, [slot.key]: e.target.value } })}
              />
            </TmsField>
          )
        })}
      </div>

      <h3 style={{ margin: '16px 0 8px' }}>Flows into</h3>
      <div className="tms-grid tms-grid-3">
        {FLOW_SLOTS.map((slot) => {
          const inherited = inheritedFlow(divisions, parentId, slot.key)
          const own = draft.flows[slot.key]
          const effective = own ?? inherited ?? false
          return (
            <label
              key={slot.key}
              className={own === null ? 'tms-muted' : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <input
                type="checkbox"
                checked={effective}
                onChange={(e) => onChange({ ...draft, flows: { ...draft.flows, [slot.key]: e.target.checked } })}
              />
              {slot.label}
              {own === null && inherited !== null ? ' (inherited)' : null}
            </label>
          )
        })}
      </div>
    </TmsDialog>
  )
}

// ── Rule row ─────────────────────────────────────────────────────────────────

function RuleValueControl({
  draft,
  carriers,
  customers,
  onChange,
}: {
  draft: RuleDraft
  carriers: CarrierRecord[]
  customers: CustomerRecord[]
  onChange: (value: string) => void
}) {
  const label = `Value for ${draft.name.trim() || CONDITION_KIND_LABELS[draft.kind]}`
  switch (draft.kind) {
    case 'ALWAYS':
      return <span className="tms-muted">Matches every shipment</span>
    case 'CARRIER_IS':
      return (
        <TmsSelect
          aria-label={label}
          value={draft.value}
          placeholder="Pick a carrier…"
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: OWN_FLEET_CARRIER_CODE, label: 'Ivan Cartage (own fleet)' },
            ...carriers.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      )
    case 'CUSTOMER_IS':
      return (
        <TmsSelect
          aria-label={label}
          value={draft.value}
          placeholder="Pick a customer…"
          onChange={(e) => onChange(e.target.value)}
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
      )
    case 'DRIVER_FLEET_GROUP_IS':
    case 'DRIVER_TYPE_IS':
    case 'DRIVER_PROGRAM_IS': {
      const values =
        draft.kind === 'DRIVER_FLEET_GROUP_IS'
          ? DRIVER_FLEET_GROUPS
          : draft.kind === 'DRIVER_TYPE_IS'
            ? DRIVER_TYPES
            : DRIVER_PROGRAMS
      return (
        <TmsSelect
          aria-label={label}
          value={draft.value}
          placeholder="Pick one…"
          onChange={(e) => onChange(e.target.value)}
          options={values.map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase() }))}
        />
      )
    }
    case 'REFERENCE_MATCHES': {
      const broken = draft.value.trim() !== '' && !isValidPattern(draft.value)
      return (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TmsInput
            aria-label={label}
            value={draft.value}
            placeholder="vehicle|auto transport"
            onChange={(e) => onChange(e.target.value)}
          />
          {broken ? <span className="tms-field-error">Not a valid pattern.</span> : null}
        </span>
      )
    }
    default:
      return (
        <TmsInput aria-label={label} value={draft.value} onChange={(e) => onChange(e.target.value)} />
      )
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

export function DivisionsPage() {
  const { isOwner, isAdmin } = useAuth()
  const allowed = isOwner || isAdmin

  const [divisions, setDivisions] = useState<OwnershipDivisionRecord[]>([])
  const [rules, setRules] = useState<OwnershipRuleRecord[]>([])
  const [carriers, setCarriers] = useState<CarrierRecord[]>([])
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [draft, setDraft] = useState<DivisionDraft | null>(null)
  const [draftErrors, setDraftErrors] = useState<string[]>([])
  const [savingDivision, setSavingDivision] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)

  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>([])
  const [ruleErrors, setRuleErrors] = useState<string[]>([])
  const [savingRules, setSavingRules] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  const [seeding, setSeeding] = useState(false)
  const [seedNote, setSeedNote] = useState<string | null>(null)

  const [probe, setProbe] = useState('')
  const [probeBusy, setProbeBusy] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probeResult, setProbeResult] = useState<OwnershipRuleTest | null>(null)

  const [retagBusy, setRetagBusy] = useState(false)
  const [retagError, setRetagError] = useState<string | null>(null)
  const [dryReport, setDryReport] = useState<RetagReport | null>(null)
  const [appliedReport, setAppliedReport] = useState<RetagReport | null>(null)
  const [confirming, setConfirming] = useState(false)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(
    () =>
      Promise.all([listOwnershipDivisions(), listOwnershipRules(), listCarriers(), listCustomers()])
        .then(([nextDivisions, nextRules, nextCarriers, nextCustomers]) => {
          setDivisions(nextDivisions)
          setRules(nextRules)
          setRuleDrafts(ruleDraftsFrom(nextRules))
          setCarriers(nextCarriers)
          setCustomers(nextCustomers)
          setLoadError(null)
        })
        .catch((err: unknown) => setLoadError(messageOf(err)))
        .finally(() => setLoading(false)),
    [],
  )

  // A caller who may not edit renders the notice below, so `loading` never matters there.
  useEffect(() => {
    if (allowed) void load()
  }, [allowed, load])

  const rows = useMemo(() => flattenDivisions(divisions), [divisions])
  const divisionChoices = useMemo(() => divisionOptions(divisions), [divisions])
  const ruleNameById = useMemo(() => {
    const names: Record<string, string> = {}
    for (const rule of rules) names[rule.id] = rule.name ?? rule.id
    return names
  }, [rules])

  if (!allowed) {
    return (
      <div className="tms-page">
        <TmsCard>
          <p className="tms-muted">
            Divisions and tagging rules are edited by the owner and the ADMIN group. Ask one of them for a change.
          </p>
        </TmsCard>
      </div>
    )
  }

  const saveDivision = async () => {
    if (!draft) return
    const errors = validateDivisions(divisionsWithDraft(divisions, draft))
    if (errors.length) {
      setDraftErrors(errors)
      return
    }
    setSavingDivision(true)
    setDraftErrors([])
    try {
      await saveOwnershipDivision(draftToDivisionInput(draft))
      setDraft(null)
      await load()
    } catch (err) {
      setDraftErrors([messageOf(err)])
    } finally {
      setSavingDivision(false)
    }
  }

  const archive = async (division: OwnershipDivisionRecord) => {
    setTreeError(null)
    try {
      await archiveOwnershipDivision({ id: division.id })
      await load()
    } catch (err) {
      setTreeError(messageOf(err))
    }
  }

  const seed = async () => {
    setSeeding(true)
    setSeedNote(null)
    try {
      const counts = await ensureOwnershipSeed()
      setSeedNote(
        `Created ${counts.divisionsCreated} divisions, ${counts.rulesCreated} rules and ${counts.viewsCreated} views.`,
      )
      await load()
    } catch (err) {
      setSeedNote(messageOf(err))
    } finally {
      setSeeding(false)
    }
  }

  const saveRules = async () => {
    const errors = validateRules(draftsAsRuleRows(ruleDrafts), divisions)
    if (errors.length) {
      setRuleErrors(errors)
      return
    }
    setRuleErrors([])
    setSavingRules(true)
    try {
      const saved = await saveOwnershipRules({ rules: draftsToRuleInputs(ruleDrafts) })
      setRules(saved)
      setRuleDrafts(ruleDraftsFrom(saved))
    } catch (err) {
      setRuleErrors([messageOf(err)])
    } finally {
      setSavingRules(false)
    }
  }

  const runProbe = async () => {
    const typed = probe.trim()
    if (typed === '') return
    setProbeBusy(true)
    setProbeError(null)
    setProbeResult(null)
    try {
      const shipments = await listShipments()
      const match = shipments.find(
        (s) => s.id === typed || (s.number ?? '').toLowerCase() === typed.toLowerCase(),
      )
      if (!match) {
        setProbeError(`No shipment matches "${typed}".`)
        return
      }
      setProbeResult(await testOwnershipRules({ shipmentId: match.id }))
    } catch (err) {
      setProbeError(messageOf(err))
    } finally {
      setProbeBusy(false)
    }
  }

  const retag = async (dryRun: boolean) => {
    setRetagBusy(true)
    setRetagError(null)
    try {
      const report = await retagShipments({ dryRun })
      if (dryRun) {
        setDryReport(report)
        setAppliedReport(null)
      } else {
        setAppliedReport(report)
        setConfirming(false)
        await load()
      }
    } catch (err) {
      setRetagError(messageOf(err))
    } finally {
      setRetagBusy(false)
    }
  }

  const patchRule = (index: number, patch: Partial<RuleDraft>) => {
    setRuleDrafts((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const tablesEmpty = !loading && divisions.length === 0 && rules.length === 0

  return (
    <div className="tms-page">
      {loadError ? <p className="tms-field-error">{loadError}</p> : null}

      {tablesEmpty ? (
        <TmsCard title="Nothing configured yet">
          <p className="tms-muted" style={{ marginTop: 0 }}>
            The three businesses, Ivan Cartage&apos;s three driver subsidiaries, the Company group, the seed
            tagging rules and the ten department views are written once and are yours to edit afterwards.
          </p>
          <TmsButton variant="primary" onClick={() => void seed()} disabled={seeding}>
            {seeding ? 'Writing…' : 'Create the seed rows'}
          </TmsButton>
          {seedNote ? <p className="tms-muted">{seedNote}</p> : null}
        </TmsCard>
      ) : null}

      <TmsCard
        title="Divisions"
        actions={
          <TmsButton
            variant="primary"
            onClick={() => {
              setDraftErrors([])
              setDraft(blankDivisionDraft('', (divisions.length + 1) * 10))
            }}
          >
            Add division
          </TmsButton>
        }
      >
        {treeError ? <p className="tms-field-error">{treeError}</p> : null}
        {loading ? <p className="tms-muted">Loading…</p> : null}
        {!loading && rows.length === 0 ? <p className="tms-muted">No divisions yet.</p> : null}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map(({ division, depth }) => (
            <li
              key={division.code}
              data-depth={depth}
              data-testid={`division-${division.code}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: depth * 22,
                borderBottom: '1px solid var(--tms-border)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: division.color || 'transparent',
                  border: '1px solid var(--tms-input-border)',
                }}
              />
              <strong>{division.name}</strong>
              <span className="tms-muted">{division.code}</span>
              {division.brand ? <span className="tms-muted">[{division.brand}]</span> : null}
              <TmsBadge tone={division.active ? 'green' : 'gray'}>{division.active ? 'Active' : 'Archived'}</TmsBadge>
              <span className="tms-muted">#{division.sortOrder}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <TmsButton
                  size="sm"
                  onClick={() => {
                    setDraftErrors([])
                    setDraft(blankDivisionDraft(division.code, (divisions.length + 1) * 10))
                  }}
                >
                  Add subsidiary under {division.code}
                </TmsButton>
                <TmsButton
                  size="sm"
                  onClick={() => {
                    setDraftErrors([])
                    setDraft(divisionToDraft(division))
                  }}
                >
                  Edit {division.code}
                </TmsButton>
                <TmsButton size="sm" disabled={!division.active} onClick={() => void archive(division)}>
                  Archive {division.code}
                </TmsButton>
              </span>
            </li>
          ))}
        </ul>
      </TmsCard>

      <TmsCard
        title="Tagging rules"
        actions={
          <>
            <TmsButton size="sm" onClick={() => setRuleDrafts((current) => [...current, blankRuleDraft()])}>
              <Plus size={14} /> Add rule
            </TmsButton>
            <TmsButton variant="primary" size="sm" onClick={() => void saveRules()} disabled={savingRules}>
              {savingRules ? 'Saving…' : 'Save rules'}
            </TmsButton>
          </>
        }
      >
        <p className="tms-muted" style={{ marginTop: 0 }}>
          First active rule that matches wins. A hand tag on a shipment beats every rule.
        </p>
        {ruleErrors.length > 0 ? (
          <ul className="tms-field-error" style={{ paddingLeft: 18 }}>
            {ruleErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {ruleDrafts.map((rule, index) => (
            <li
              key={rule.key}
              data-testid={`rule-${index}`}
              draggable
              onDragStart={() => setDragFrom(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null) setRuleDrafts((current) => moveRule(current, dragFrom, index))
                setDragFrom(null)
              }}
              onDragEnd={() => setDragFrom(null)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                paddingTop: 8,
                paddingBottom: 8,
                borderBottom: '1px solid var(--tms-border)',
              }}
            >
              <span className="tms-muted" aria-label={`Drag ${index + 1}`} style={{ cursor: 'grab', marginTop: 10 }}>
                <GripVertical size={14} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
                <button
                  type="button"
                  className="tms-icon-btn tms-icon-btn-plain"
                  aria-label={`Move rule ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => setRuleDrafts((current) => moveRule(current, index, index - 1))}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  className="tms-icon-btn tms-icon-btn-plain"
                  aria-label={`Move rule ${index + 1} down`}
                  disabled={index === ruleDrafts.length - 1}
                  onClick={() => setRuleDrafts((current) => moveRule(current, index, index + 1))}
                >
                  <ChevronDown size={14} />
                </button>
              </span>
              <label className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 10 }}>
                <input
                  type="checkbox"
                  aria-label={`Rule ${index + 1} active`}
                  checked={rule.active}
                  onChange={(e) => patchRule(index, { active: e.target.checked })}
                />
                On
              </label>
              <span style={{ flex: '1 1 160px', minWidth: 120 }}>
                <TmsInput
                  aria-label={`Rule ${index + 1} name`}
                  value={rule.name}
                  placeholder="Name this rule"
                  onChange={(e) => patchRule(index, { name: e.target.value })}
                />
              </span>
              <span style={{ flex: '0 0 180px' }}>
                <TmsSelect
                  aria-label={`Rule ${index + 1} condition`}
                  value={rule.kind}
                  onChange={(e) =>
                    patchRule(index, { kind: e.target.value as OwnershipConditionKind, value: '' })
                  }
                  options={CONDITION_KINDS.map((kind) => ({ value: kind, label: CONDITION_KIND_LABELS[kind] }))}
                />
              </span>
              <span style={{ flex: '1 1 180px', minWidth: 140 }}>
                <RuleValueControl
                  draft={rule}
                  carriers={carriers}
                  customers={customers}
                  onChange={(value) => patchRule(index, { value })}
                />
              </span>
              <span style={{ flex: '0 0 200px' }}>
                <TmsSelect
                  aria-label={`Rule ${index + 1} division`}
                  value={rule.divisionCode}
                  placeholder="Tag as…"
                  onChange={(e) => patchRule(index, { divisionCode: e.target.value })}
                  options={divisionChoices}
                />
              </span>
              <button
                type="button"
                className="tms-icon-btn tms-icon-btn-plain"
                aria-label={`Remove rule ${index + 1}`}
                style={{ marginTop: 4 }}
                onClick={() => setRuleDrafts((current) => current.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
        {ruleDrafts.length === 0 && !loading ? <p className="tms-muted">No rules yet.</p> : null}
      </TmsCard>

      <TmsCard title="Test a shipment">
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <TmsField label="PRO or shipment id" className="tms-probe-field">
            <TmsInput value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="BCAT104221" />
          </TmsField>
          <TmsButton onClick={() => void runProbe()} disabled={probeBusy}>
            {probeBusy ? 'Testing…' : 'Test'}
          </TmsButton>
        </div>
        {probeError ? <p className="tms-field-error">{probeError}</p> : null}
        {probeResult ? (
          <div className="tms-grid tms-grid-3" style={{ marginTop: 12 }}>
            <div>
              <h3>What the rules see</h3>
              <dl style={{ margin: 0 }}>
                {[
                  ['Carrier', probeResult.context.carrierId],
                  ['Driver fleet group', probeResult.context.driverFleetGroup],
                  ['Driver type', probeResult.context.driverType],
                  ['Driver program', probeResult.context.driverProgram],
                  ['Customer', probeResult.context.customerId],
                  ['Equipment', probeResult.context.equipment],
                  ['Mode', probeResult.context.mode],
                  ['Load source', probeResult.context.loadSource],
                  ['References', probeResult.context.references.join(', ')],
                ].map(([label, value]) => (
                  <div key={label as string} style={{ display: 'flex', gap: 6 }}>
                    <dt className="tms-muted">{label}</dt>
                    <dd style={{ margin: 0 }}>{value ? String(value) : '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h3>What the rules say</h3>
              <p>
                Matched rule:{' '}
                <strong>
                  {probeResult.resolution.ruleId
                    ? ruleNameById[probeResult.resolution.ruleId] ?? probeResult.resolution.ruleId
                    : 'no rule matched'}
                </strong>
              </p>
              <p>
                Division: <strong>{probeResult.resolution.revDivision ?? '—'}</strong>
              </p>
              <p>
                Subdivision: <strong>{probeResult.resolution.revSubdivision ?? '—'}</strong>
              </p>
            </div>
            <div>
              <h3>What the shipment holds now</h3>
              <p>
                Division: <strong>{probeResult.current.revDivision ?? '—'}</strong>
              </p>
              <p>
                Subdivision: <strong>{probeResult.current.revSubdivision ?? '—'}</strong>
              </p>
              <p>
                Tagged by: <strong>{probeResult.current.revTagSource ?? '—'}</strong>
              </p>
            </div>
          </div>
        ) : null}
      </TmsCard>

      <TmsCard title="Re-tag all shipments">
        <p className="tms-muted" style={{ marginTop: 0 }}>
          Re-runs the rules over every shipment. Hand-tagged and voided shipments are left alone.
        </p>
        {retagError ? <p className="tms-field-error">{retagError}</p> : null}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <TmsButton onClick={() => void retag(true)} disabled={retagBusy}>
            {retagBusy ? 'Working…' : 'Dry run'}
          </TmsButton>
          {dryReport && !confirming ? (
            <TmsButton variant="primary" onClick={() => setConfirming(true)} disabled={retagBusy}>
              Apply to {dryReport.changed} shipments
            </TmsButton>
          ) : null}
          {confirming ? (
            <>
              <span className="tms-muted">This writes the new tags.</span>
              <TmsButton variant="primary" onClick={() => void retag(false)} disabled={retagBusy}>
                Confirm re-tag
              </TmsButton>
              <TmsButton onClick={() => setConfirming(false)}>Cancel</TmsButton>
            </>
          ) : null}
        </div>
        {dryReport ? <RetagReportView report={dryReport} /> : null}
        {appliedReport ? <RetagReportView report={appliedReport} /> : null}
      </TmsCard>

      {draft ? (
        <DivisionDialog
          draft={draft}
          divisions={divisions}
          open
          busy={savingDivision}
          errors={draftErrors}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void saveDivision()}
        />
      ) : null}
    </div>
  )
}

function RetagReportView({ report }: { report: RetagReport }) {
  const counts = (byKey: Record<string, number>) =>
    Object.entries(byKey).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  return (
    <div style={{ marginTop: 12 }}>
      <p>
        <strong>{report.dryRun ? 'Dry run' : 'Applied'}</strong> — scanned {report.scanned}, changed{' '}
        {report.changed}, {report.handTagged} hand-tagged left alone.
      </p>
      <div className="tms-grid tms-grid-2">
        <div>
          <h3>By division</h3>
          {counts(report.byDivision).length === 0 ? (
            <p className="tms-muted">No divisions in the result.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {counts(report.byDivision).map(([code, n]) => (
                <li key={code}>
                  {code}: {n}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>By subdivision</h3>
          {counts(report.bySubdivision).length === 0 ? (
            <p className="tms-muted">No subdivisions in the result.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {counts(report.bySubdivision).map(([code, n]) => (
                <li key={code}>
                  {code}: {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export default DivisionsPage
