import { useState } from 'react'
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'

const BRAND_STATS = [
  { v: '44', l: 'loads moved this month' },
  { v: '16', l: 'trucks & trailers tracked' },
  { v: '92%', l: 'on-time performance' },
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
      style={{ background: 'linear-gradient(135deg, #f4f7fb 0%, #e6f4fd 100%)' }}
    >
      {/* decorative blurred blobs */}
      <div style={{ position: 'absolute', top: -120, left: -120, width: 400, height: 400, borderRadius: '50%', background: 'rgba(30,168,243,0.18)', filter: 'blur(100px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -160, right: -160, width: 460, height: 460, borderRadius: '50%', background: 'rgba(124,58,237,0.15)', filter: 'blur(120px)', pointerEvents: 'none' }} />

      <div
        className="relative z-10 grid w-full max-w-[980px] grid-cols-1 overflow-hidden md:grid-cols-2"
        style={{ borderRadius: 24, boxShadow: '0 20px 60px rgba(15,23,42,0.12), 0 6px 16px rgba(15,23,42,0.05)', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)' }}
      >
        {/* ── Left brand panel (desktop only) ─────────────────────────────── */}
        <div
          className="relative hidden flex-col overflow-hidden p-11 text-white md:flex"
          style={{ background: 'linear-gradient(160deg, #0a1422 0%, #0f1e33 40%, #0b8fd9 110%)' }}
        >
          <div
            style={{
              position: 'absolute', inset: 0, opacity: 0.05, pointerEvents: 'none',
              backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
              backgroundSize: '32px 32px',
            }}
          />
          <div className="relative mb-8 flex items-center gap-3">
            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" />
                <path d="M16 4 Q21 8 21 14 T17 22" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" fill="none" strokeDasharray="2 2" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>BCAT <span style={{ color: '#60c5ff' }}>OPS</span></div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 1 }}>Command Center</div>
            </div>
          </div>

          <div className="relative flex flex-1 flex-col justify-center">
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 14 }}>
              Every load.<br />Every driver.<br />Every dollar.
            </div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6, maxWidth: 360 }}>
              The command center for BCAT Logistics — dispatch, intake, fleet compliance, and financials in one place.
            </div>

            <div className="mt-9 flex flex-col gap-3.5">
              {BRAND_STATS.map((s) => (
                <div key={s.l} className="flex items-center gap-3.5">
                  <div style={{ fontSize: 24, fontWeight: 600, color: '#60c5ff', letterSpacing: '-0.02em', minWidth: 60, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{s.v}</div>
                  <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.65)' }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative" style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>© 2026 BCAT Logistics</div>
        </div>

        {/* ── Right form panel ────────────────────────────────────────────── */}
        <div className="flex flex-col justify-center p-8 sm:p-11">
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 6 }}>
            {needsNewPassword ? 'Set new password' : 'Welcome back'}
          </h1>
          <p style={{ fontSize: 13.5, color: 'var(--ds-t3)', marginBottom: 28 }}>
            {needsNewPassword ? 'Choose a password to finish your setup' : 'Sign in to your BCAT Ops account'}
          </p>

          {!needsNewPassword ? (
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email Address</Label>
                <div className="relative">
                  <Mail size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@bcatcorp.com" required autoFocus className="h-10 pl-9" />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Password</Label>
                  <a href="mailto:ryne@bcatcorp.com?subject=BCAT%20Ops%20password%20help" style={{ fontSize: 11.5, color: 'var(--ds-blue)' }}>Forgot?</a>
                </div>
                <div className="relative">
                  <Lock size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required className="h-10 pl-9 pr-10" />
                  <button type="button" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer', padding: 4, display: 'flex' }}>
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2" style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>
                <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} style={{ accentColor: 'var(--ds-blue)' }} />
                Keep me signed in on this device
              </label>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button type="submit" className="mt-2 h-11 w-full gap-2 text-sm font-semibold" disabled={loading}>
                {loading ? 'Signing in…' : <>Sign in <ArrowRight size={15} /></>}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleNewPassword} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">New Password</Label>
                <div className="relative">
                  <Lock size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type={showPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 chars, upper, lower, number, symbol" required autoFocus className="h-10 pl-9 pr-10" />
                  <button type="button" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer', padding: 4, display: 'flex' }}>
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Confirm Password</Label>
                <div className="relative">
                  <Lock size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted-soft)', pointerEvents: 'none' }} />
                  <Input type={showPw ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat new password" required className="h-10 pl-9" />
                </div>
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button type="submit" className="mt-2 h-11 w-full gap-2 text-sm font-semibold" disabled={loading}>
                {loading ? 'Saving…' : <>Set password &amp; sign in <ArrowRight size={15} /></>}
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
