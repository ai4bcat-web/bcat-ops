import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDriverAuth } from './useDriverAuth'
import { InstallHintSection } from './InstallHintSection'

type Mode = 'signin' | 'forgot' | 'reset'

function humanizeLoginError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('user does not exist') || lower.includes('not authorized')) {
    return "We don't recognize that email or password. Use the email dispatch has on file, or tap Forgot password."
  }
  if (lower.includes('incorrect username or password')) {
    return "Email or password didn't match. Try again, or tap Forgot password."
  }
  if (lower.includes('user is not confirmed') || lower.includes('not confirmed')) {
    return "This email isn't verified yet. Check your inbox or sign up again."
  }
  if (lower.includes('limit exceeded')) {
    return "Too many tries. Wait a few minutes and try again."
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('failed to fetch')) {
    return "Could not connect. Check your signal and try again."
  }
  return "Something went wrong. Text dispatch for help."
}

function humanizeForgotError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('user does not exist')) {
    return "We don't recognize that email. Use the email dispatch has on file."
  }
  if (lower.includes('limit exceeded')) {
    return "Too many tries. Wait a few minutes and try again."
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('failed to fetch')) {
    return "Could not connect. Check your signal and try again."
  }
  return "Could not send reset code. Text dispatch for help."
}

function humanizeResetError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('code mismatch') || lower.includes('invalid code')) {
    return "That code didn't match. Check your email and try again."
  }
  if (lower.includes('limit exceeded')) {
    return "Too many tries. Wait a few minutes and try again."
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('failed to fetch')) {
    return "Could not connect. Check your signal and try again."
  }
  return "Could not reset password. Text dispatch for help."
}

export default function DriverLoginPage() {
  const navigate = useNavigate()
  const { signIn, forgotPassword, confirmForgotPassword } = useDriverAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [mode, setMode] = useState<Mode>('signin')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function handleSignIn(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setLoading(true)
    try {
      await signIn(email.trim(), password)
      // /driver, not /driver/settlement: the landing route sends each program to its own
      // home. An Ivan driver sent straight to the settlement got a 409 and a Retry button.
      navigate('/driver')
    } catch (err) {
      setError(humanizeLoginError(err instanceof Error ? err.message : 'Sign in failed.'))
    } finally {
      setLoading(false)
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    if (!email.trim()) {
      setError('Enter your email.')
      return
    }
    setLoading(true)
    try {
      await forgotPassword(email.trim())
      setMessage('A verification code was sent to your email.')
      setMode('reset')
    } catch (err) {
      setError(humanizeForgotError(err instanceof Error ? err.message : 'Could not send reset code.'))
    } finally {
      setLoading(false)
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!code.trim() || !newPassword) {
      setError('Enter the code and a new password.')
      return
    }
    setLoading(true)
    try {
      await confirmForgotPassword(email.trim(), code.trim(), newPassword)
      setMessage('Password reset. Sign in with your new password.')
      setMode('signin')
      setCode('')
      setNewPassword('')
      setPassword('')
    } catch (err) {
      setError(humanizeResetError(err instanceof Error ? err.message : 'Could not reset password.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0b1220] text-white flex flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-[#1ea8f3]">
            <span className="text-2xl font-bold text-white">BCAT</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === 'signin' && 'Driver sign in'}
            {mode === 'forgot' && 'Reset password'}
            {mode === 'reset' && 'Choose a new password'}
          </h1>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {message}
          </div>
        )}

        <form onSubmit={mode === 'signin' ? handleSignIn : mode === 'forgot' ? handleForgot : handleReset} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="driver-email" className="text-sm font-medium text-slate-300">
              Email
            </Label>
            <Input
              id="driver-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loading}
              className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 text-base text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
            />
            <p className="text-xs text-slate-400">Use the same email dispatch has on file.</p>
          </div>

          {mode === 'signin' && (
            <div className="space-y-2">
              <Label htmlFor="driver-password" className="text-sm font-medium text-slate-300">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="driver-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={loading}
                  className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 pr-12 text-base text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-slate-400"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>
          )}

          {mode === 'reset' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="driver-code" className="text-sm font-medium text-slate-300">
                  Verification code
                </Label>
                <Input
                  id="driver-code"
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  disabled={loading}
                  className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 text-center text-lg tracking-[0.5em] text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="driver-new-password" className="text-sm font-medium text-slate-300">
                  New password
                </Label>
                <Input
                  id="driver-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={loading}
                  className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 text-base text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
                />
              </div>
            </>
          )}

          <Button
            type="submit"
            disabled={loading}
            className="h-14 w-full rounded-xl text-base font-semibold"
          >
            {loading && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
            {mode === 'signin' && 'Sign in'}
            {mode === 'forgot' && 'Send reset code'}
            {mode === 'reset' && 'Reset password'}
          </Button>
        </form>

        {mode === 'signin' && <InstallHintSection />}

        {mode === 'signin' && (
          <div className="mt-6 flex flex-col gap-4 text-center text-sm text-slate-400">
            <button
              type="button"
              onClick={() => { setMode('forgot'); setError(null); setMessage(null) }}
              className="mx-auto font-medium text-[#1ea8f3] hover:underline"
            >
              Forgot password?
            </button>
            <p>
              Need an account?{' '}
              <Link to="/driver/signup" className="font-semibold text-[#1ea8f3] hover:underline">
                Sign up
              </Link>
            </p>
          </div>
        )}

        {mode !== 'signin' && (
          <div className="mt-8 text-center text-sm text-slate-400">
            <button
              type="button"
              onClick={() => { setMode('signin'); setError(null); setMessage(null) }}
              className="font-medium text-[#1ea8f3] hover:underline"
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
