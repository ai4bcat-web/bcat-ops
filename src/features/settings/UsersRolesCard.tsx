/**
 * Roles and pages: what each role opens, and the two board defaults that are not
 * permissions at all.
 *
 * The matrix is read-only on purpose. A role's pages are code (`ROLE_PAGES`), not
 * settings: the Lambda projects them onto `page-*` Cognito groups every time a
 * profile is saved, so an edit here would be overwritten by the next reconcile.
 * What an admin changes per person — their role, their extra pages, their claims —
 * lives on the Users page, which is what the link goes to.
 *
 * The two switches underneath are deliberately labelled as filters. They default
 * the boards' "Mine" toggle for reps; they do not hide a row from anybody, and no
 * Lambda refuses a read because of them.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Save, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { pageOptions } from '@/lib/navItems'
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_PAGES } from '@/lib/roles'
import type { RoleKey, TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

/** Only the pages some role actually grants: a column nothing ticks teaches nothing. */
const GRANTED_PAGES = pageOptions().filter((page) =>
  ROLES.some((role) => ROLE_PAGES[role].includes(page.key)),
)

const COLUMNS: ColumnDef<RoleKey>[] = [
  {
    key: 'role',
    header: 'Role',
    render: (role) => (
      <div>
        <div style={{ fontWeight: 600 }}>{ROLE_LABELS[role]}</div>
        <div className="tms-muted" style={{ fontSize: 12 }}>{ROLE_DESCRIPTIONS[role]}</div>
      </div>
    ),
  },
  // An admin opens every page, so that row is ticked throughout rather than looked up.
  ...GRANTED_PAGES.map((page): ColumnDef<RoleKey> => ({
    key: page.key,
    header: page.label,
    render: (role) => (role === 'ADMIN' || ROLE_PAGES[role].includes(page.key) ? '✓' : '·'),
  })),
]

/** The matrix rows. `ROLES` is readonly; the table takes a mutable array. */
const ROLE_ROWS: RoleKey[] = [...ROLES]

export function UsersRolesCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [limitCustomerRepView, setLimitCustomerRepView] = useState(false)
  const [limitCarrierRepView, setLimitCarrierRepView] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setSettings(s)
        setLimitCustomerRepView(s?.limitCustomerRepView === true)
        setLimitCarrierRepView(s?.limitCarrierRepView === true)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      const updated = await saveTmsSettings(
        { limitCustomerRepView, limitCarrierRepView },
        settings?.updatedAt ?? undefined,
      )
      setSettings(updated)
      toast.success('Role settings saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={ShieldCheck}
      title="Roles & pages"
      description="What each role opens. Roles are given to people on the Users page; extra pages and claims are granted there too."
      actions={
        <Link to="/tms/brokerage/users" className="tms-btn tms-btn-secondary tms-btn-sm">
          Users <ExternalLink size={12} />
        </Link>
      }
    >
      <Stack>
        <TmsTable columns={COLUMNS} rows={ROLE_ROWS} rowKey={(role) => role} />
        <Hint>An admin opens every page, which is why that row is ticked throughout. A role&rsquo;s pages are code, not settings — they are re-applied to Cognito every time a profile is saved.</Hint>

        {loading ? <Loading /> : (
          <Stack gap={8}>
            <CheckRow
              ariaLabel="Limit customer rep view"
              label={<>Customer reps start on &ldquo;Mine&rdquo;</>}
              checked={limitCustomerRepView}
              onChange={setLimitCustomerRepView}
            />
            <CheckRow
              ariaLabel="Limit carrier rep view"
              label={<>Carrier reps start on &ldquo;Mine&rdquo;</>}
              checked={limitCarrierRepView}
              onChange={setLimitCarrierRepView}
            />
            <Hint>These two default the boards&rsquo; &ldquo;Mine&rdquo; filter for reps. They are not a read restriction: every signed-in user can still read every customer, carrier and load, and clearing the filter shows them.</Hint>

            {error && <ErrorText>{error}</ErrorText>}
            <div>
              <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
                <Save size={14} /> Save role settings
              </TmsButton>
            </div>
          </Stack>
        )}
      </Stack>
    </SettingsCard>
  )
}
