/**
 * Step 2 of the Aljex import: the mapping profile as editable tables. Every categorical value the
 * STAGE pass found is listed with its row count; a value the profile has no answer for is red and
 * blocks Plan/Apply until it is mapped. The editor holds a draft: nothing is sent until Save.
 */
import { TmsBadge, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { DEFAULT_ALJEX_PROFILE, isMemoType } from '@/lib/aljex/profile'
import type { AljexProfile, RevDivisionCode, UnmappedValue } from '@/lib/aljex/profile'
import type { AljexStageSummary, DistinctValueCount, ShipmentMode } from '@/types/tms'
import { GroupLabel, Hint, Panel, Stack } from '@/features/settings/settingsKit'
import { countOf } from './aljexImportLogic'

const MODES: ShipmentMode[] = ['FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL']
const DIVISIONS: Array<{ value: RevDivisionCode; label: string }> = [
  { value: 'ASSETS', label: 'Ivan Cartage' },
  { value: 'BROKERAGE', label: 'BCAT Logistics' },
  { value: 'CAR_SHIPPING', label: 'Auto Shipping' },
  { value: 'OWNER_OPERATOR', label: 'Owner Operators' },
]
const RATINGS = ['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE', 'UNKNOWN'] as const
const STATUS_TEMPLATES = Object.keys(DEFAULT_ALJEX_PROFILE.statusMap)

/** Values to list: what the file has (with counts), then anything the profile already maps. */
function listed(found: DistinctValueCount[] | undefined, mapped: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of [...(found ?? []).map((d) => d.value), ...mapped]) {
    if (v === '' || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** The template status a mapped entry is identical to, else '' (a custom entry made elsewhere). */
function templateOf(entry: AljexProfile['statusMap'][string] | undefined): string {
  if (!entry) return ''
  return STATUS_TEMPLATES.find((k) => JSON.stringify(DEFAULT_ALJEX_PROFILE.statusMap[k]) === JSON.stringify(entry)) ?? ''
}

function Table({ head, children, testId }: { head: string[]; children: React.ReactNode; testId: string }) {
  return (
    <table className="tms-table" data-testid={testId}>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  )
}

const rowStyle = (bad: boolean) => (bad ? { background: 'var(--tms-badge-red-tint)' } : undefined)

export interface AljexProfileEditorProps {
  profile: AljexProfile
  onChange: (next: AljexProfile) => void
  stage: AljexStageSummary | null | undefined
  unmapped: UnmappedValue[]
  disabled?: boolean
}

export function AljexProfileEditor({ profile, onChange, stage, unmapped, disabled }: AljexProfileEditorProps) {
  const bad = (column: UnmappedValue['column'], value: string) => unmapped.some((u) => u.column === column && u.value === value)
  const set = (patch: Partial<AljexProfile>) => onChange({ ...profile, ...patch })
  const distinct = stage?.distinct ?? {}

  const statuses = listed(distinct.status, Object.keys(profile.statusMap))
  const types = listed(distinct.typeOfShipment, Object.keys(profile.typeMap)).filter((v) => !isMemoType(v))
  const reps = listed(distinct.salesreps, Object.keys(profile.repMap))
  const dispatchers = listed(distinct.dispatchers, Object.keys(profile.dispatcherMap))
  const markers = listed(distinct.stopMarkers, Object.keys(profile.stopMarkerMap))
  const ratings = listed(distinct.safetyRating, Object.keys(profile.safetyRatingMap))

  return (
    <Stack>
      <Panel>
        <GroupLabel>Dispatch Status → status</GroupLabel>
        <Hint>Pick the status each Aljex value should be treated as. A red row has no mapping and blocks the import.</Hint>
        <Table head={['Aljex value', 'Rows', 'Treat as', 'Voided in Aljex']} testId="profile-status-map">
          {statuses.map((value) => {
            const entry = profile.statusMap[value]
            return (
              <tr key={value} data-unmapped={bad('status', value) || undefined} style={rowStyle(bad('status', value))}>
                <td>{value}{bad('status', value) ? <> <TmsBadge tone="red">Unmapped</TmsBadge></> : null}</td>
                <td>{countOf(distinct.status, value)}</td>
                <td>
                  <TmsSelect
                    aria-label={`Status ${value} treated as`}
                    disabled={disabled}
                    value={templateOf(entry)}
                    onChange={(e) => {
                      const template = DEFAULT_ALJEX_PROFILE.statusMap[e.target.value]
                      const next = { ...profile.statusMap }
                      if (template) next[value] = { ...template }
                      else delete next[value]
                      set({ statusMap: next })
                    }}
                    options={[{ value: '', label: entry && !templateOf(entry) ? 'Custom' : '— choose —' }, ...STATUS_TEMPLATES.map((k) => ({ value: k, label: k }))]}
                  />
                </td>
                <td>{entry?.void ? 'Yes' : entry ? 'No' : '—'}</td>
              </tr>
            )
          })}
        </Table>
      </Panel>

      <Panel>
        <GroupLabel>Type of Shipment → mode and division</GroupLabel>
        <Hint>
          DEBT and CRED rows are memos and are imported as voided history; they are not mapped here. Division is optional:
          blank falls through to the other division rules (own fleet → Ivan Cartage, owner-operator list, otherwise BCAT Logistics).
        </Hint>
        <Table head={['Aljex value', 'Rows', 'Mode', 'Division']} testId="profile-type-map">
          {types.map((value) => {
            const entry = profile.typeMap[value]
            return (
              <tr key={value} data-unmapped={bad('typeOfShipment', value) || undefined} style={rowStyle(bad('typeOfShipment', value))}>
                <td>{value}{bad('typeOfShipment', value) ? <> <TmsBadge tone="red">Unmapped</TmsBadge></> : null}</td>
                <td>{countOf(distinct.typeOfShipment, value)}</td>
                <td>
                  <TmsSelect
                    aria-label={`Type ${value} mode`}
                    disabled={disabled}
                    value={entry?.mode ?? ''}
                    onChange={(e) => {
                      const next = { ...profile.typeMap }
                      if (e.target.value) next[value] = { ...entry, mode: e.target.value as ShipmentMode }
                      else delete next[value]
                      set({ typeMap: next })
                    }}
                    options={[{ value: '', label: '— choose —' }, ...MODES.map((m) => ({ value: m, label: m }))]}
                  />
                </td>
                <td>
                  <TmsSelect
                    aria-label={`Type ${value} division`}
                    disabled={disabled || !entry}
                    value={entry?.division ?? ''}
                    onChange={(e) => {
                      if (!entry) return
                      const { division: _drop, ...rest } = entry
                      set({ typeMap: { ...profile.typeMap, [value]: e.target.value ? { ...rest, division: e.target.value as RevDivisionCode } : rest } })
                    }}
                    options={[{ value: '', label: '— by other rules —' }, ...DIVISIONS]}
                  />
                </td>
              </tr>
            )
          })}
        </Table>
      </Panel>

      {markers.length > 0 ? (
        <Panel>
          <GroupLabel>Stop-block markers</GroupLabel>
          <Table head={['Marker', 'Rows', 'Stop type']} testId="profile-stop-markers">
            {markers.map((value) => (
              <tr key={value} data-unmapped={bad('stopMarker', value) || undefined} style={rowStyle(bad('stopMarker', value))}>
                <td>{value}</td>
                <td>{countOf(distinct.stopMarkers, value)}</td>
                <td>
                  <TmsSelect
                    aria-label={`Marker ${value} stop type`}
                    disabled={disabled}
                    value={profile.stopMarkerMap[value.trim().toUpperCase()] ?? ''}
                    onChange={(e) => {
                      const key = value.trim().toUpperCase()
                      const next = { ...profile.stopMarkerMap }
                      if (e.target.value) next[key] = e.target.value as 'pickup' | 'delivery'
                      else delete next[key]
                      set({ stopMarkerMap: next })
                    }}
                    options={[{ value: '', label: '— choose —' }, { value: 'pickup', label: 'Pickup' }, { value: 'delivery', label: 'Delivery' }]}
                  />
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      ) : null}

      {ratings.length > 0 ? (
        <Panel>
          <GroupLabel>Carrier safety rating</GroupLabel>
          <Hint>Not blocking: an unmapped rating is imported as UNKNOWN and listed in the report.</Hint>
          <Table head={['Aljex value', 'Rows', 'Rating']} testId="profile-safety">
            {ratings.map((value) => {
              const key = value.trim().toUpperCase()
              return (
                <tr key={value}>
                  <td>{value}</td>
                  <td>{countOf(distinct.safetyRating, value)}</td>
                  <td>
                    <TmsSelect
                      aria-label={`Safety rating ${value}`}
                      disabled={disabled}
                      value={profile.safetyRatingMap[key] ?? ''}
                      onChange={(e) => {
                        const next = { ...profile.safetyRatingMap }
                        if (e.target.value) next[key] = e.target.value as (typeof RATINGS)[number]
                        else delete next[key]
                        set({ safetyRatingMap: next })
                      }}
                      options={[{ value: '', label: '— unmapped —' }, ...RATINGS.map((r) => ({ value: r, label: r }))]}
                    />
                  </td>
                </tr>
              )
            })}
          </Table>
        </Panel>
      ) : null}

      {([
        ['Salesrep ID → BCAT user', 'repMap', reps, distinct.salesreps, 'salesrep'],
        ['Dispatcher → BCAT user', 'dispatcherMap', dispatchers, distinct.dispatchers, 'dispatcher'],
      ] as const).map(([title, field, values, counts, column]) => (
        <Panel key={field}>
          <GroupLabel>{title}</GroupLabel>
          <Hint>Not blocking. An id left blank leaves the field empty and is listed in the report; nobody is guessed.</Hint>
          <Table head={['Aljex id', 'Rows', 'BCAT username']} testId={`profile-${field}`}>
            {values.map((value) => (
              <tr key={value} data-unmapped={bad(column, value) || undefined}>
                <td>{value}</td>
                <td>{countOf(counts, value)}</td>
                <td>
                  <TmsInput
                    aria-label={`${column} ${value} username`}
                    disabled={disabled}
                    value={profile[field][value] ?? ''}
                    onChange={(e) => {
                      const next = { ...profile[field] }
                      if (e.target.value.trim()) next[value] = e.target.value.trim()
                      else delete next[value]
                      set({ [field]: next })
                    }}
                  />
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      ))}

      <Panel>
        <GroupLabel>Charge descriptions</GroupLabel>
        <Hint>How a charge line's description becomes a BCAT charge code. Anything not listed is an accessorial.</Hint>
        <Table head={['Description', 'Charge code', 'Is the rate']} testId="profile-charges">
          {Object.entries(profile.chargeDescriptionMap).map(([description, entry]) => (
            <tr key={description}>
              <td>{description}</td>
              <td>
                <TmsInput
                  aria-label={`Charge ${description} code`}
                  disabled={disabled}
                  value={entry.code}
                  onChange={(e) => set({ chargeDescriptionMap: { ...profile.chargeDescriptionMap, [description]: { ...entry, code: e.target.value.trim().toUpperCase() } } })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Charge ${description} is the rate`}
                  disabled={disabled}
                  checked={entry.isRate}
                  onChange={(e) => set({ chargeDescriptionMap: { ...profile.chargeDescriptionMap, [description]: { ...entry, isRate: e.target.checked } } })}
                />
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel>
        <GroupLabel>Payment method by check number</GroupLabel>
        <div className="tms-grid tms-grid-3">
          {(['numeric', 'alpha', 'blank'] as const).map((shape) => (
            <TmsField key={shape} label={`Check number is ${shape}`}>
              <TmsInput
                aria-label={`Payment method for ${shape} check numbers`}
                disabled={disabled}
                value={profile.paymentMethodByCheckShape[shape]}
                onChange={(e) => set({ paymentMethodByCheckShape: { ...profile.paymentMethodByCheckShape, [shape]: e.target.value.trim().toUpperCase() } })}
              />
            </TmsField>
          ))}
        </div>
      </Panel>

      <Panel>
        <GroupLabel>Dates and carriers</GroupLabel>
        <div className="tms-grid tms-grid-3">
          <TmsField label="Plausible dates from" hint="Blank = derived from the file.">
            <TmsInput
              aria-label="Date window start"
              type="date"
              disabled={disabled}
              value={profile.window?.start ?? ''}
              onChange={(e) => set({ window: e.target.value || profile.window?.end ? { start: e.target.value, end: profile.window?.end ?? '' } : null })}
            />
          </TmsField>
          <TmsField label="Plausible dates to">
            <TmsInput
              aria-label="Date window end"
              type="date"
              disabled={disabled}
              value={profile.window?.end ?? ''}
              onChange={(e) => set({ window: e.target.value || profile.window?.start ? { start: profile.window?.start ?? '', end: e.target.value } : null })}
            />
          </TmsField>
          <TmsField label="Unbilled legacy before" hint="Delivered, un-invoiced freight shipped before this date is excluded from AR worklists. Blank = off.">
            <TmsInput
              aria-label="Unbilled legacy before"
              type="date"
              disabled={disabled}
              value={profile.unbilledLegacyBefore ?? ''}
              onChange={(e) => set({ unbilledLegacyBefore: e.target.value || null })}
            />
          </TmsField>
          <TmsField label="Carrier window (months)" hint="Carriers with no pickup this recently, no open bill and no live load are not imported.">
            <TmsInput
              aria-label="Carrier window months"
              type="number"
              min={1}
              disabled={disabled}
              value={profile.carrierWindowMonths}
              onChange={(e) => set({ carrierWindowMonths: Math.max(1, Math.round(Number(e.target.value)) || 12) })}
            />
          </TmsField>
          <TmsField label="Carrier window anchor date" hint="Blank = newest plausible ship date in the file.">
            <TmsInput
              aria-label="Carrier cutoff date"
              type="date"
              disabled={disabled}
              value={profile.carrierCutoffDate ?? ''}
              onChange={(e) => set({ carrierCutoffDate: e.target.value || null })}
            />
          </TmsField>
        </div>
      </Panel>

      <Panel>
        <GroupLabel>Own fleet (Ivan Cartage) policy</GroupLabel>
        <div className="tms-grid tms-grid-2">
          <TmsField label="Own-fleet carrier name contains" hint="A carrier whose name contains this text is the own fleet: imported as own-asset history with no driver.">
            <TmsInput
              aria-label="Own fleet carrier match"
              disabled={disabled}
              value={profile.ownAssetCarrierMatch}
              onChange={(e) => set({ ownAssetCarrierMatch: e.target.value })}
            />
          </TmsField>
          <TmsField label="Owner-operator carrier ids / MCs" hint="One per line. Blank until supplied: nothing is tagged Owner Operators.">
            <TmsTextarea
              aria-label="Owner operator carrier ids"
              rows={3}
              disabled={disabled}
              value={profile.ownerOperatorCarrierIds.join('\n')}
              onChange={(e) => set({ ownerOperatorCarrierIds: e.target.value.split(/[\s,]+/).filter(Boolean) })}
            />
          </TmsField>
        </div>
      </Panel>
    </Stack>
  )
}
