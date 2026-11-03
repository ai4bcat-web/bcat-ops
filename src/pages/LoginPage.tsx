import { useEffect, useMemo, useState } from 'react'
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import bcatLogo from '@/assets/bcat-logo.png'
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsInput } from '@/features/tms/kit/TmsInput'
import { useTmsTheme } from '@/features/tms/tmsTheme'

/**
 * LoginPage — "Control Tower"
 *
 * The fleet plotted across the country — city hubs, route arcs, live GPS pings and a unit
 * tracing a lane — quietly behind a single card you sign in through. Light canvas, brand
 * tokens only; a dark-preference user gets the dark card (theme applied, no toggle here).
 */

// Hubs positioned roughly like US geography on a 1000×560 canvas (slice-cropped).
type Hub = { code: string; x: number; y: number; ping?: boolean }
const HUBS: Hub[] = [
  { code: 'SEA', x: 132, y: 86 },
  { code: 'LAX', x: 118, y: 360, ping: true },
  { code: 'DEN', x: 372, y: 250 },
  { code: 'DAL', x: 486, y: 404 },
  { code: 'CHI', x: 626, y: 176, ping: true },
  { code: 'ATL', x: 736, y: 360, ping: true },
  { code: 'NYC', x: 872, y: 150 },
  { code: 'MIA', x: 832, y: 486 },
]

// Lanes between hubs (by index). The first two carry a moving unit.
const LANES: [number, number][] = [
  [4, 5], // CHI → ATL
  [1, 3], // LAX → DAL
  [2, 4], // DEN → CHI
  [4, 6], // CHI → NYC
  [3, 5], // DAL → ATL
  [0, 2], // SEA → DEN
]

// Quadratic arc between two hubs, lifted toward the top for a great-circle feel.
function arc(a: Hub, b: Hub): string {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  return `M ${a.x} ${a.y} Q ${mx} ${my - dist * 0.22} ${b.x} ${b.y}`
}

const usCT = () =>
  new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false })

export function LoginPage() {
  const { login, completeNewPassword, needsNewPassword } = useAuth()
  useTmsTheme()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [keepSignedIn, setKeepSignedIn] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [clock, setClock] = useState(usCT)

  // Honor reduced-motion for the moving unit (SMIL can't be media-gated in CSS).
  const reduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  useEffect(() => {
    const t = setInterval(() => setClock(usCT()), 20_000)
    return () => clearInterval(t)
  }, [])

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
    <div style={S.canvas} className="tms-portal">
      <style>{CSS}</style>

      {/* ── Signature: live fleet map ─────────────────────────────────────── */}
      <svg style={S.map} viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid slice" aria-hidden>
        {/* graticule */}
        <g style={{ stroke: PRIMARY_08 }} strokeWidth={1}>
          {[80, 160, 240, 320, 400, 480].map((y) => (
            <line key={`h${y}`} x1={0} y1={y} x2={1000} y2={y} />
          ))}
          {[140, 280, 420, 560, 700, 840].map((x) => (
            <line key={`v${x}`} x1={x} y1={0} x2={x} y2={560} />
          ))}
        </g>

        {/* lanes */}
        {LANES.map(([i, j], k) => (
          <path
            key={`lane${k}`}
            id={`lane-${k}`}
            d={arc(HUBS[i], HUBS[j])}
            fill="none"
            strokeWidth={1.25}
            className={k < 3 ? 'lg-dash' : undefined}
            style={k < 3 ? { stroke: PRIMARY_22, animationDelay: `${k * 1.1}s` } : { stroke: PRIMARY_22 }}
          />
        ))}

        {/* moving units on the first two lanes */}
        {!reduced &&
          [0, 1].map((k) => (
            <circle key={`unit${k}`} r={3.4} style={{ fill: PRIMARY }}>
              <animateMotion dur={`${7 + k * 2}s`} repeatCount="indefinite" rotate="auto" begin={`${k * 2}s`}>
                <mpath href={`#lane-${k}`} />
              </animateMotion>
            </circle>
          ))}

        {/* hubs + pings */}
        {HUBS.map((h) => (
          <g key={h.code} transform={`translate(${h.x} ${h.y})`}>
            {h.ping && (
              <>
                <circle r={6} fill="none" style={{ stroke: PRIMARY }} strokeWidth={1.5} className="lg-ping" />
                <circle r={6} fill="none" strokeWidth={1.5} className="lg-ping" style={{ stroke: PRIMARY, animationDelay: '1.4s' }} />
              </>
            )}
            <circle r={h.ping ? 3 : 2} style={{ fill: h.ping ? PRIMARY : PRIMARY_55 }} />
            <text x={8} y={4} fontSize={11} style={{ fill: 'var(--tms-muted)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.08em' }}>
              {h.code}
            </text>
          </g>
        ))}
      </svg>

      {/* ── The glass ─────────────────────────────────────────────────────── */}
      <div style={S.card} className="lg-card">
        {/* status rail */}
        <div style={S.statusRow}>
          <span style={S.live}>
            <span style={S.liveDot} className={reduced ? undefined : 'lg-pulse'} /> LIVE
          </span>
          <span style={S.statusMeta}>{clock} CT · 16 UNITS ROLLING</span>
        </div>

        <div style={S.body}>
          <div data-tms-paper style={S.logoPlate}>
            <img src={bcatLogo} alt="BCAT Logistics" style={S.logo} />
          </div>
          <div style={S.eyebrow}>Operations Command Center</div>

          <h1 style={S.h1}>{needsNewPassword ? 'Set new password' : 'Welcome back'}</h1>
          <p style={S.sub}>
            {needsNewPassword ? 'Choose a password to finish your setup' : 'Sign in to the command center'}
          </p>

          {!needsNewPassword ? (
            <form onSubmit={handleLogin} style={S.form}>
              <Fieldset label="Email address">
                <div style={S.inputWrap}>
                  <Mail size={15} style={S.inputIcon} />
                  <TmsInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@bcatcorp.com" required autoFocus style={S.input} />
                </div>
              </Fieldset>

              <Fieldset label="Password" aside={<a href="mailto:ryne@bcatcorp.com?subject=BCAT%20Ops%20password%20help" className="lg-link">Forgot?</a>}>
                <div style={S.inputWrap}>
                  <Lock size={15} style={S.inputIcon} />
                  <TmsInput type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required style={{ ...S.input, paddingRight: 42 }} />
                  <PwToggle on={showPw} toggle={() => setShowPw((s) => !s)} />
                </div>
              </Fieldset>

              <label style={S.check}>
                <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} style={{ accentColor: 'var(--tms-primary)' }} />
                Keep me signed in on this device
              </label>

              {error && <TmsAlert tone="red">{error}</TmsAlert>}

              <TmsButton type="submit" variant="primary" disabled={loading} style={S.submit}>
                {loading ? 'Signing in…' : <>Sign in <ArrowRight size={16} /></>}
              </TmsButton>
            </form>
          ) : (
            <form onSubmit={handleNewPassword} style={S.form}>
              <Fieldset label="New password">
                <div style={S.inputWrap}>
                  <Lock size={15} style={S.inputIcon} />
                  <TmsInput type={showPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 chars · upper, lower, number, symbol" required autoFocus style={{ ...S.input, paddingRight: 42 }} />
                  <PwToggle on={showPw} toggle={() => setShowPw((s) => !s)} />
                </div>
              </Fieldset>

              <Fieldset label="Confirm password">
                <div style={S.inputWrap}>
                  <Lock size={15} style={S.inputIcon} />
                  <TmsInput type={showPw ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat new password" required style={S.input} />
                </div>
              </Fieldset>

              {error && <TmsAlert tone="red">{error}</TmsAlert>}

              <TmsButton type="submit" variant="primary" disabled={loading} style={S.submit}>
                {loading ? 'Saving…' : <>Set password &amp; sign in <ArrowRight size={16} /></>}
              </TmsButton>
            </form>
          )}

          <div style={S.footer}>
            Need access? Contact{' '}
            <a href="mailto:ryne@bcatcorp.com" className="lg-link">ryne@bcatcorp.com</a>
          </div>
        </div>

        {/* instrument footer — a real coordinate, quietly */}
        <div style={S.coords}>41.8781° N · 87.6298° W — CHI HUB</div>
      </div>
    </div>
  )
}

function Fieldset({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={S.label}>{label}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

function PwToggle({ on, toggle }: { on: boolean; toggle: () => void }) {
  return (
    <button type="button" onClick={toggle} aria-label={on ? 'Hide password' : 'Show password'} style={S.pwToggle}>
      {on ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  )
}

const PRIMARY = 'var(--tms-primary)'
const PRIMARY_08 = 'color-mix(in srgb, var(--tms-primary) 8%, transparent)'
const PRIMARY_22 = 'color-mix(in srgb, var(--tms-primary) 22%, transparent)'
const PRIMARY_55 = 'color-mix(in srgb, var(--tms-primary) 55%, transparent)'
const T1 = 'var(--tms-text)'
const T2 = 'var(--tms-text-2)'
const T3 = 'var(--tms-muted)'
const HAIR = 'var(--tms-border)'

const S: Record<string, React.CSSProperties> = {
  canvas: {
    position: 'relative', minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, overflow: 'hidden', background: 'var(--tms-bg)', color: T1,
  },
  map: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
  card: {
    position: 'relative', zIndex: 10, width: '100%', maxWidth: 420,
    borderRadius: 'var(--tms-radius-card)', overflow: 'hidden',
    background: 'var(--tms-card)', border: `1px solid ${HAIR}`, boxShadow: 'var(--tms-shadow-pop)',
  },
  statusRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 20px', borderBottom: `1px solid ${HAIR}`,
    background: 'var(--tms-primary-tint)',
  },
  live: { display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5, letterSpacing: '0.18em', color: 'var(--tms-primary-ink)', fontWeight: 600 },
  liveDot: { width: 6, height: 6, borderRadius: '50%', background: PRIMARY },
  statusMeta: { fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5, letterSpacing: '0.1em', color: T3 },
  body: { padding: '30px 34px 26px' },
  logoPlate: { display: 'inline-block', background: 'var(--tms-paper)', borderRadius: 10, padding: '8px 12px', marginBottom: 18, border: `1px solid ${HAIR}` },
  logo: { width: 150, height: 'auto', display: 'block' },
  eyebrow: { fontSize: 10.5, letterSpacing: '0.2em', textTransform: 'uppercase', color: T3, marginBottom: 14 },
  h1: { fontSize: 25, fontWeight: 600, letterSpacing: '-0.02em', margin: 0, color: T1 },
  sub: { fontSize: 13.5, color: T2, margin: '6px 0 24px' },
  form: { display: 'flex', flexDirection: 'column', gap: 17 },
  label: { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: T2 },
  inputWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  inputIcon: { position: 'absolute', left: 13, color: T3, pointerEvents: 'none' },
  input: { width: '100%', height: 46, paddingLeft: 38, paddingRight: 14, boxSizing: 'border-box' },
  pwToggle: { position: 'absolute', right: 10, background: 'none', border: 'none', color: T3, cursor: 'pointer', padding: 5, display: 'flex' },
  check: { display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: T2, marginTop: -2 },
  submit: { width: '100%', height: 48, marginTop: 6, justifyContent: 'center' },
  footer: { marginTop: 24, paddingTop: 18, borderTop: `1px solid ${HAIR}`, textAlign: 'center', fontSize: 12, color: T3 },
  coords: { padding: '10px 20px', borderTop: `1px solid ${HAIR}`, fontFamily: 'var(--font-mono, monospace)', fontSize: 10, letterSpacing: '0.08em', color: T3, textAlign: 'center' },
}

const CSS = `
.lg-card { animation: lg-fadeup .6s cubic-bezier(.2,.7,.2,1) both; }
.lg-link { font-size: 11.5px; color: var(--tms-primary-ink); text-decoration: none; }
.lg-link:hover { text-decoration: underline; }
.lg-link:focus-visible, .lg-card a:focus-visible { outline: 2px solid var(--tms-primary); outline-offset: 2px; }
.lg-ping { transform-origin: center; animation: lg-ping 3s ease-out infinite; }
.lg-dash { stroke-dasharray: 5 9; animation: lg-dash 2.4s linear infinite; }
.lg-pulse { animation: lg-pulse 1.8s ease-in-out infinite; }
@keyframes lg-ping { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(3.6); opacity: 0; } }
@keyframes lg-dash { to { stroke-dashoffset: -28; } }
@keyframes lg-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes lg-fadeup { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .lg-card, .lg-ping, .lg-dash, .lg-pulse { animation: none !important; }
}
`
