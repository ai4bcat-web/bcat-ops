import { useState } from 'react'
import { SlidersHorizontal, EyeOff } from 'lucide-react'
import { EmailSettingsCard } from '@/features/compliance/EmailSettingsCard'
import { EscalationRulesCard } from '@/features/compliance/EscalationRulesCard'
import { PrivateDocsModal } from '@/features/files/PrivateDocsModal'
import { useAuth } from '@/hooks/useAuth'

/**
 * Settings that belong to the company rather than to any one driver or truck.
 *
 * Created when the Compliance and Onboarding pages were retired: escalation rules and
 * the email kill switches lived there, and they aren't per-driver, so they had no home
 * in the Files hub. The document privacy/responsibility controls move here too — they
 * were hidden behind a button on Files, which is a per-record page.
 */
export function SettingsPage() {
  const { isAdmin } = useAuth()
  const [docsOpen, setDocsOpen] = useState(false)

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ padding: '20px 32px 14px' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <SlidersHorizontal size={20} /> Settings
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            Company-wide settings — expiry warnings, driver emails, and which documents are private.
          </p>
        </div>
      </div>

      <div style={{ padding: '20px 32px 40px', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {isAdmin && (
          <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <EyeOff size={16} style={{ color: 'var(--ds-t3)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Documents</div>
                <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
                  Which documents are hidden from non-admins, and who maintains each one.
                </div>
              </div>
              <button onClick={() => setDocsOpen(true)}
                style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                Configure
              </button>
            </div>
          </div>
        )}

        <EscalationRulesCard />
        <EmailSettingsCard />
      </div>

      {docsOpen && <PrivateDocsModal onClose={() => setDocsOpen(false)} />}
    </div>
  )
}
