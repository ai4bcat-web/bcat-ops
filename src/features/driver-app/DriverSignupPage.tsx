import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDriverAuth } from './useDriverAuth'

type Step = 'form' | 'confirm' | 'done'

export default function DriverSignupPage() {
  const navigate = useNavigate()
  const { signUp, confirmSignUp, resendConfirmationCode, signIn } = useDriverAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [code, setCode] = useState('')
  const [step, setStep] = useState<Step>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmitForm(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail || !password) {
      setError('Enter an email and password.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      // The PreSignUp trigger is the only roster gate; its rejection surfaces here.
      await signUp(cleanEmail, password)
      setStep('confirm')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!code.trim()) {
      setError('Enter the verification code from your email.')
      return
    }
    setLoading(true)
    try {
      await confirmSignUp(email, code.trim())
      await signIn(email, password)
      navigate('/driver/scan')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm account.')
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setError(null)
    setLoading(true)
    try {
      await resendConfirmationCode(email)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend code.')
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
            {step === 'form' && 'Driver sign up'}
            {step === 'confirm' && 'Verify your email'}
            {step === 'done' && 'Welcome aboard'}
          </h1>
          {step === 'confirm' && (
            <p className="mt-2 text-sm text-slate-400">
              We sent a code to <span className="text-slate-200">{email}</span>.
            </p>
          )}
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {step === 'form' && (
          <form onSubmit={handleSubmitForm} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="driver-signup-email" className="text-sm font-medium text-slate-300">
                Email
              </Label>
              <Input
                id="driver-signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={loading}
                className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 text-base text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="driver-signup-password" className="text-sm font-medium text-slate-300">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="driver-signup-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
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

            <div className="space-y-2">
              <Label htmlFor="driver-signup-confirm" className="text-sm font-medium text-slate-300">
                Confirm password
              </Label>
              <Input
                id="driver-signup-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                disabled={loading}
                className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 text-base text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
              />
            </div>

            <Button type="submit" disabled={loading} className="h-14 w-full rounded-xl text-base font-semibold">
              {loading && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
              Check eligibility & sign up
            </Button>
          </form>
        )}

        {step === 'confirm' && (
          <form onSubmit={handleConfirm} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="driver-signup-code" className="text-sm font-medium text-slate-300">
                Verification code
              </Label>
              <Input
                id="driver-signup-code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                disabled={loading}
                className="h-14 rounded-xl border-slate-700 bg-slate-900/60 px-4 text-center text-lg tracking-[0.5em] text-white placeholder:text-slate-500 focus-visible:ring-[#1ea8f3]"
              />
            </div>

            <Button type="submit" disabled={loading} className="h-14 w-full rounded-xl text-base font-semibold">
              {loading && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
              Verify email
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={handleResend}
              className="h-14 w-full rounded-xl border-slate-700 bg-transparent text-base font-semibold text-slate-200 hover:bg-slate-800 hover:text-white"
            >
              Resend code
            </Button>
          </form>
        )}

        <div className="mt-8 text-center text-sm text-slate-400">
          <p>
            Already have an account?{' '}
            <Link to="/driver/login" className="font-semibold text-[#1ea8f3] hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
