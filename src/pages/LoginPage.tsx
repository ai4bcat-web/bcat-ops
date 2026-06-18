import { useState } from 'react'
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import bcatLogo from '@/assets/bcat-logo.png'

const BRAND_STATS = [
  { v: '44', l: 'loads / mo' },
  { v: '16', l: 'units' },
  { v: '92%', l: 'on-time' },
]

export function LoginPage() {
  const { login, completeNewPassword, needsNewPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [keepSignedIn, setKeepSignedIn] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      await completeNewPassword(newPassword)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to set password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden p-6"
      style={{ background: 'radial-gradient(1200px 600px at 50% -10%, #e6f4fd 0%, #f4f7fb 55%, #eef2f8 100%)' }}
    >
      {/* faint blue blobs */}
      <div style={{ position: 'absolute', top: -140, left: '12%', width: 380, height: 380, borderRadius: '50%', background: 'rgba(30,168,243,0.16)', filter: 'blur(110px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -160, right: '10%', width: 420, height: 420, borderRadius: '50%', background: 'rgba(30,168,243,0.10)', filter: 'blur(120px)', pointerEvents: 'none' }} />

      <div
        className="relative z-10 grid w-full max-w-[1000px] grid-cols-1 overflow-hidden md:grid-cols-2"
        style={{ minHeight: 580, borderRadius: 22, boxShadow: '0 30px 80px rgba(15,23,42,0.18), 0 8px 24px rgba(15,23,42,0.06)', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)' }}
      >
        {/* ── Left brand panel — solid black so the logo blends ─────────────── */}
        <div className="relative hidden flex-col justify-between overflow-hidden md:flex" style={{ background: '#000', padding: 48 }}>
          {/* blue ambient glow */}
          <div style={{ position: 'absolute', top: '18%', left: '50%', width: 460, height: 460, transform: 'translateX(-50%)', borderRadius: '50%', background: 'radial-gradient(circle, rgba(30,168,243,0.32) 0%, rgba(30,168,243,0) 65%)', pointerEvents: 'none' }} />
          {/* faint road-grid */}
          <div style={{ position: 'absolute', inset: 0, opacity: 0.06, pointerEvents: 'none', backgroundImage: 'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)', backgroundSize: '34px 34px' }} />

          {/* spacer top */}
          <div />

          {/* centered logo + copy */}
          <div className="relative flex flex-col items-center text-center">
            <img src={bcatLogo} alt="BCAT Logistics" style={{ width: '78%', maxWidth: 320, height: 'auto', display: 'block' }} />
            <div style={{ marginTop: 22, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
              Operations Command Center
            </div>
            <p style={{ marginTop: 14, maxWidth: 320, fontSize: 13.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.6)' }}>
              Dispatch, intake, fleet compliance and financials — every load, driver and dollar in one place.
            </p>
          </div>

          {/* footer stats split by hairlines */}
          <div className="relative flex items-stretch" style={{ borderTop: '1px solid rgba(255,255,255,0.10)', paddingTop: 20 }}>
            {BRAND_STATS.map((s, i) => (
              <div key={s.l} style={{ flex: 1, textAlign: 'center', borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.10)' }}>
                <div style={{ fontSize: 20, fontWeight: 600, color: '#60c5ff', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{s.v}</div>
                <div style={{ marginTop: 2, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right form panel ────────────────────────────────────────────── */}
        <div className="flex flex-col justify-center" style={{ padding: '52px 48px' }}>
          <h1 style={{ fontSize: 23, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 6 }}>
            {needsNewPassword ? 'Set new password' : 'Welcome back'}
          </h1>
          <p style={{ fontSize: 13.5, color: 'var(--ds-t3)', marginBottom: 28 }}>
            {needsNewPassword ? 'Choose a password to finish your setup' : 'Sign in to your BCAT Ops account'}
          </p>

          {!needsNewPassword ? (
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Email Address</Label>
                <div className="relative">
                  <Mail size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@bcatcorp.com" required autoFocus className="h-11 pl-10" />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Password</Label>
                  <a href="mailto:ryne@bcatcorp.com?subject=BCAT%20Ops%20password%20help" style={{ fontSize: 11.5, color: 'var(--ds-blue)' }}>Forgot?</a>
                </div>
                <div className="relative">
                  <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required className="h-11 pl-10 pr-11" />
                  <button type="button" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer', padding: 4, display: 'flex' }}>
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2" style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>
                <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} style={{ accentColor: 'var(--ds-blue)' }} />
                Keep me signed in on this device
              </label>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button type="submit" className="mt-2 w-full gap-2 text-sm font-semibold" style={{ height: 46 }} disabled={loading}>
                {loading ? 'Signing in…' : <>Sign in <ArrowRight size={16} /></>}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleNewPassword} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">New Password</Label>
                <div className="relative">
                  <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type={showPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 chars, upper, lower, number, symbol" required autoFocus className="h-11 pl-10 pr-11" />
                  <button type="button" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer', padding: 4, display: 'flex' }}>
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Confirm Password</Label>
                <div className="relative">
                  <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type={showPw ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat new password" required className="h-11 pl-10" />
                </div>
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button type="submit" className="mt-2 w-full gap-2 text-sm font-semibold" style={{ height: 46 }} disabled={loading}>
                {loading ? 'Saving…' : <>Set password &amp; sign in <ArrowRight size={16} /></>}
              </Button>
            </form>
          )}

          <div className="mt-8 border-t pt-5 text-center" style={{ borderColor: 'var(--ds-border)', fontSize: 11.5, color: 'var(--ds-t3)' }}>
            Need access? Contact <a href="mailto:ryne@bcatcorp.com" style={{ color: 'var(--ds-blue)' }}>ryne@bcatcorp.com</a>
          </div>
        </div>
      </div>
    </div>
  )
}
