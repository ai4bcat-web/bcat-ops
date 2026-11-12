/**
 * Reset a driver's Ivan driver app password, from the staff page. Owner and ADMIN only —
 * the server refuses everyone else, this only hides the button.
 *
 * Two ways back in:
 *   - Send a reset code: Cognito emails a code; the driver enters it on the app's sign-in
 *     screen. Needs a verified email (and SES out of sandbox for non-company addresses).
 *   - Set a temporary password: the admin types one and tells the driver; the app makes
 *     them choose their own the first time they sign in with it.
 *
 * The temporary password is sent to the Lambda and nowhere else: not stored, not logged.
 */
import { useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { OWNER_EMAIL } from '@/lib/auth/admin'
import { errorText } from '@/lib/errorText'
import {
  driverLoginStatusText, driverPasswordProblem, getDriverLogin, resetDriverPassword,
  type DriverLoginInfo, type DriverResetMethod,
} from '@/lib/driverLoginClient'
import type { Driver } from '@/types'

interface Props {
  driver: Pick<Driver, 'id' | 'name' | 'email'>
}

export function ResetDriverPassword({ driver }: Props) {
  const authUser = useAuthUser()
  const isAdmin = (authUser?.email ?? '').toLowerCase() === OWNER_EMAIL || (authUser?.groups ?? []).includes('ADMIN')
  const [open, setOpen] = useState(false)
  if (!isAdmin) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Reset ${driver.name}'s driver app password`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <KeyRound size={13} /> Reset password
      </button>
      {open && <ResetDriverPasswordDialog driver={driver} onClose={() => setOpen(false)} />}
    </>
  )
}

export function ResetDriverPasswordDialog({ driver, onClose }: Props & { onClose: () => void }) {
  const email = (driver.email ?? '').toLowerCase().trim()
  const [info, setInfo] = useState<DriverLoginInfo | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [method, setMethod] = useState<DriverResetMethod>('temporary')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<DriverResetMethod | null>(null)

  useEffect(() => {
    if (!email) return
    let stale = false
    getDriverLogin(email)
      .then((value) => { if (!stale) setInfo(value) })
      .catch((err: unknown) => { if (!stale) setLookupError(errorText(err)) })
    return () => { stale = true }
  }, [email])

  const noAccount = info !== null && !info.exists
  const codeBlocked = info?.exists && !info.emailVerified
  const passwordProblem = method === 'temporary' ? driverPasswordProblem(password) : null
  const canSubmit = !!email && !busy && !done && !noAccount && info?.exists === true && info.enabled !== false
    && (method === 'code' ? !codeBlocked : !passwordProblem)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      await resetDriverPassword(email, method, method === 'temporary' ? password : undefined)
      setPassword('')
      setDone(method)
      toast.success(method === 'code' ? `Reset code emailed to ${email}` : `Temporary password set for ${driver.name}`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title={`Reset ${driver.name}'s app password`}
      description={email ? `Ivan driver app login: ${email}` : undefined}
      footer={done
        ? <TmsButton variant="primary" onClick={onClose}>Done</TmsButton>
        : <>
            <TmsButton variant="ghost" onClick={onClose}>Cancel</TmsButton>
            <TmsButton variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? 'Resetting…' : method === 'code' ? 'Send reset code' : 'Set temporary password'}
            </TmsButton>
          </>}
    >
      {!email && <TmsAlert tone="orange">{driver.name} has no email on file. Add one on the driver profile first.</TmsAlert>}
      {email && (
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="tms-muted" data-testid="driver-login-status">{lookupError ? `Could not check the app account: ${lookupError}` : driverLoginStatusText(info)}</p>

          {done === 'temporary' && (
            <TmsAlert tone="green">
              Temporary password set. Give it to {driver.name} directly (text or call). The app will make them choose their own password the first time they sign in with it.
            </TmsAlert>
          )}
          {done === 'code' && (
            <TmsAlert tone="green">
              Reset code emailed to {email}. On the app's sign-in screen they sign in as usual and are asked for the code and a new password.
            </TmsAlert>
          )}

          {!done && info?.exists && (
            <fieldset style={{ display: 'grid', gap: 8, border: 0, padding: 0, margin: 0 }}>
              <legend className="tms-muted" style={{ marginBottom: 4 }}>How should they get back in?</legend>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input type="radio" name="driver-reset-method" checked={method === 'temporary'} onChange={() => setMethod('temporary')} />
                <span><strong>Set a temporary password</strong><br /><span className="tms-muted">You tell the driver the password. They must change it when they next sign in. Works even if email doesn't reach them.</span></span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input type="radio" name="driver-reset-method" checked={method === 'code'} disabled={!!codeBlocked} onChange={() => setMethod('code')} />
                <span><strong>Email a reset code</strong><br /><span className="tms-muted">{codeBlocked ? "Not available: this driver's email isn't verified." : 'Cognito emails a code; the driver enters it in the app with a new password.'}</span></span>
              </label>
            </fieldset>
          )}

          {!done && info?.exists && method === 'temporary' && (
            <TmsField label="Temporary password" hint="At least 8 characters, with a lowercase letter and a number." error={password && passwordProblem ? passwordProblem : undefined}>
              <div style={{ display: 'flex', gap: 6 }}>
                <TmsInput
                  id="driver-temp-password"
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  style={{ flex: 1 }}
                />
                <TmsButton variant="ghost" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}>
                  {show ? <EyeOff size={14} /> : <Eye size={14} />}
                </TmsButton>
              </div>
            </TmsField>
          )}

          {error && <TmsAlert tone="red">{error}</TmsAlert>}
        </div>
      )}
    </TmsDialog>
  )
}
