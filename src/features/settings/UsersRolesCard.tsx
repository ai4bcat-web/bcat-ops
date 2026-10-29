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
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { pageOptions } from '@/lib/navItems'
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_PAGES } from '@/lib/roles'
import type { TmsSettings } from '@/types/tms'

/** Only the pages some role actually grants: a column nothing ticks teaches nothing. */
const GRANTED_PAGES = pageOptions().filter((page) =>
  ROLES.some((role) => ROLE_PAGES[role].includes(page.key)),
)

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
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <ShieldCheck size={16} style={{ color: 'var(--ds-t3)' }} />
        <div className="flex-1">
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Roles &amp; pages</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            What each role opens. Roles are given to people on the Users page; extra pages and claims are granted there too.
          </div>
        </div>
        <Link
          to="/users"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs font-semibold"
          style={{ color: 'var(--ds-t2)', background: 'var(--ds-bg)' }}
        >
          Users <ExternalLink size={12} />
        </Link>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border px-2 py-1.5 text-left font-semibold text-muted-foreground">Role</th>
              {GRANTED_PAGES.map((page) => (
                <th key={page.key} className="border-b border-border px-2 py-1.5 text-center font-semibold text-muted-foreground">
                  {page.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => (
              <tr key={role}>
                <td className="border-b border-border px-2 py-1.5 align-top">
                  <div className="font-semibold" style={{ color: 'var(--ds-t1)' }}>{ROLE_LABELS[role]}</div>
                  <div className="text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</div>
                </td>
                {GRANTED_PAGES.map((page) => (
                  <td key={page.key} className="border-b border-border px-2 py-1.5 text-center" style={{ color: 'var(--ds-t2)' }}>
                    {role === 'ADMIN' ? '✓' : ROLE_PAGES[role].includes(page.key) ? '✓' : '·'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        An admin opens every page, which is why that row is ticked throughout. A role&rsquo;s pages are code, not settings — they are re-applied to Cognito every time a profile is saved.
      </p>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-2">
          <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
            <Switch
              aria-label="Limit customer rep view"
              checked={limitCustomerRepView}
              onCheckedChange={setLimitCustomerRepView}
            />
            Customer reps start on &ldquo;Mine&rdquo;
          </label>
          <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
            <Switch
              aria-label="Limit carrier rep view"
              checked={limitCarrierRepView}
              onCheckedChange={setLimitCarrierRepView}
            />
            Carrier reps start on &ldquo;Mine&rdquo;
          </label>
          <p className="text-xs text-muted-foreground">
            These two default the boards&rsquo; &ldquo;Mine&rdquo; filter for reps. They are not a read restriction: every signed-in user can still read every customer, carrier and load, and clearing the filter shows them.
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save role settings
          </Button>
        </div>
      )}
    </div>
  )
}
