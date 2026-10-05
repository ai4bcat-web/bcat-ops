/**
 * A driver's actual app, served by the actual driver API, viewed by an admin.
 *
 * Not a mock-up and not a reconstruction from staff data: the driver's own components ask
 * the driver's own endpoint and render what comes back. If this and their phone disagree,
 * one of them is wrong — which is the only version of this feature worth having, because
 * the question it answers is "is the driver seeing what we think?"
 *
 * The staff session is what authenticates it. The API only consults the staff pool when
 * this header is present, only accepts an admin, and refuses every write — so this is a
 * request to LOOK, enforced on the server rather than trusted from here.
 *
 * Mounted inside the staff app behind its auth guard, so reaching the route at all already
 * requires a staff session. Every view is written to the audit log by the API.
 */
import { useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchAuthSession } from 'aws-amplify/auth'
import { ArrowLeft, Loader2, Smartphone, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  setDriverTokenSupplier,
  setDriverImpersonation,
} from '@/features/driver-app/driverApi'
import { SettlementPage } from '@/features/driver-app/settlement/SettlementPage'
import { PaperworkPage } from '@/features/driver-app/paperwork/PaperworkPage'
import { useDrivers } from '@/hooks/useDrivers'
import { driverProgramOf } from '@/lib/driverProgram'

/** iPhone 14 at CSS pixels — wide enough to be honest, narrow enough to catch a clip. */
const PHONE_WIDTH = 390

export function DriverAppViewPage() {
  const { driverId = '' } = useParams()
  const navigate = useNavigate()
  const { drivers } = useDrivers()
  const driver = drivers.find((d) => d.id === driverId)

  /*
   * Which of the driver's two apps to render.
   *
   * This used to be hardcoded to the settlement, which was right while only owner operators
   * had an app. Opening an Ivan driver that way showed them a settlement they do not have —
   * and the API now refuses it outright, so the frame came up empty. Read from the same
   * helper the driver's own app routes on, so this and their phone cannot disagree.
   */
  const program = driver ? driverProgramOf(driver) : 'SETTLEMENT'

  /** Back to wherever this driver is managed from. */
  const backTo = program === 'PAPERWORK' ? '/ivan-paperwork' : '/owner-operator-pay'

  /*
   * Installed during render, not in an effect.
   *
   * The settlement page fetches on its first effect, and effects run child-first — so an
   * effect here would install the token after that request had already gone out with no
   * token at all. A ref makes the swap happen before anything below it mounts; the effect
   * below is left with only the job effects are for, which is putting it back.
   */
  useMemo(() => {
    if (!driverId) return
    setDriverTokenSupplier(async () => {
      const session = await fetchAuthSession()
      return session.tokens?.idToken?.toString() ?? null
    })
    setDriverImpersonation(driverId)
  }, [driverId])

  /*
   * Point driverApi at the staff session for as long as this page is open, and put it
   * back on the way out.
   *
   * The cleanup matters more than it looks: leaving the impersonation set would make a
   * later visit to /driver carry someone else's id, and leaving the staff token installed
   * would send it to an endpoint that has no business seeing it.
   */
  useEffect(
    () => () => {
      /*
       * Put it back. This matters more than it looks: leaving the impersonation set would
       * make a later visit to /driver carry someone else's id, and leaving the staff token
       * installed would send it to an endpoint with no business seeing it.
       */
      setDriverImpersonation(null)
      setDriverTokenSupplier(async () => null)
    },
    [],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ds-bg)' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px', borderBottom: '1px solid var(--ds-border)',
          background: 'var(--ds-surface)', flexShrink: 0,
        }}
      >
        <Button variant="outline" size="sm" onClick={() => navigate(backTo)}>
          <ArrowLeft className="size-3.5" /> Back
        </Button>
        <Smartphone size={16} style={{ color: 'var(--ds-t2)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>
            {driver?.name ?? 'Driver'} — their app, live
          </p>
          <p style={{ margin: '1px 0 0', fontSize: 12, color: 'var(--ds-t3)' }}>
            Served by the driver API as {driver?.name ?? 'this driver'}. Read only, and recorded.
          </p>
        </div>
      </div>

      {/* Said plainly, where it cannot be missed: this is somebody else's account. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px', background: '#fffbeb',
          borderBottom: '1px solid #fcd34d', color: '#b45309',
          fontSize: 12.5, flexShrink: 0,
        }}
      >
        <ShieldAlert size={14} style={{ flexShrink: 0 }} />
        <span>
          You are viewing {driver?.name ?? 'a driver'}&rsquo;s account. Nothing here can be
          changed — uploads and edits are refused — and this view is written to the audit log.
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '16px 0' }}>
        <div
          style={{
            width: PHONE_WIDTH, maxWidth: '100%', margin: '0 auto',
            border: '1px solid var(--ds-border)', borderRadius: 14,
            overflow: 'hidden', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)',
          }}
        >
          {driverId && driver ? (
            program === 'PAPERWORK' ? <PaperworkPage /> : <SettlementPage />
          ) : (
            <div style={{ display: 'grid', placeItems: 'center', height: 240, color: 'var(--ds-t3)' }}>
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
