import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Loader2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDriverAuth } from './useDriverAuth'
import { InstallHintSection } from './InstallHintSection'
import {
  isAlreadyRegistered,
  needsSignupConfirmInstead,
  codeSentMessage,
  codeNotArrivedHint,
  type SignupStep,
} from './signupOutcome'

type Step = 'form' | 'confirm' | 'done'

export default function DriverSignupPage() {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const {
    signUp, confirmSignUp, resendConfirmationCode, signIn,
    forgotPassword, confirmForgotPassword,
  } = useDriverAuth()

  // The invite email links here with ?email= already filled in. A driver typing a
  // different address than the one on their roster row would be rejected by the
  // PreSignUp gate with no clue why, so prefill rather than ask them to remember.
  const [email, setEmail] = useState(() => (search.get('email') ?? '').trim().toLowerCase())
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [code, setCode] = useState('')
  const [step, setStep] = useState<Step>('form')
  /**
   * Which kind of code is in the driver's inbox. A brand-new account confirms its
   * sign-up; an address that already has an account sets its password through a reset.
   * The driver sees the same screen either way.
   */
  const [codeKind, setCodeKind] = useState<SignupStep>('CONFIRM_SIGNUP')
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
      setCodeKind('CONFIRM_SIGNUP')
      setStep('confirm')
    } catch (err) {
      if (!isAlreadyRegistered(err)) {
        setError(err instanceof Error ? err.message : 'Sign up failed.')
        return
      }

      /*
       * The address already has an account — usually an earlier attempt that got part
       * way through. "User already exists" is a dead end for someone who was invited and
       * has done nothing wrong, so set the password on the account they already have
       * instead.
       *
       * NOT directly: knowing an email address must never be enough to take over its
       * account. A reset code goes to that address first, which proves the person asking
       * owns the mailbox. They are already expecting an email, and the next screen is the
       * same one a new driver sees.
       */
      try {
        await forgotPassword(cleanEmail)
        setCodeKind('CONFIRM_RESET')
        setStep('confirm')
      } catch (resetErr) {
        if (needsSignupConfirmInstead(resetErr)) {
          // Signed up before but never confirmed: the sign-up code is what they need.
          try {
            await resendConfirmationCode(cleanEmail)
            setCodeKind('CONFIRM_SIGNUP')
            setStep('confirm')
          } catch (resendErr) {
            setError(resendErr instanceof Error ? resendErr.message : 'Could not send a code.')
          }
          return
        }
        setError(resetErr instanceof Error ? resetErr.message : 'Could not send a code.')
      }
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
      if (codeKind === 'CONFIRM_RESET') {
        // Same password they typed on the first screen; the code proves it is them.
        await confirmForgotPassword(email, code.trim(), password)
      } else {
        await confirmSignUp(email, code.trim())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm the code.')
      setLoading(false)
      return
    }

    /*
     * Signing in is reported separately from confirming.
     *
     * Rolled together, a correct code followed by a failed sign-in read as "the code did
     * not work" and sent the driver back to re-enter a code that was already spent. The
     * password is set either way at this point, so the message has to say so and point at
     * the login screen rather than imply they have to start over.
     */
    try {
      await signIn(email, password)
      setStep('done')
    } catch (err) {
      setError(
        `Your password is set, but signing in failed: ${
          err instanceof Error ? err.message : 'unknown error'
        } — try signing in from the login screen.`,
      )
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setError(null)
    setLoading(true)
    try {
      // Resending the wrong kind of code would send one that cannot work.
      if (codeKind === 'CONFIRM_RESET') await forgotPassword(email)
      else await resendConfirmationCode(email)
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
            {step === 'confirm' && (codeKind === 'CONFIRM_RESET' ? 'Confirm it is you' : 'Verify your email')}
            {step === 'done' && "You're signed in"}
          </h1>
          {step === 'confirm' && (
            <>
              <p className="mt-2 text-sm text-slate-400">{codeSentMessage(codeKind, email)}</p>
              <p className="mt-2 text-xs text-slate-500">{codeNotArrivedHint()}</p>
            </>
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

        {step === 'done' && (
          <div className="space-y-5">
            <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
              <div className="text-sm text-emerald-100">
                <p className="font-semibold">Password set and signed in as {email}.</p>
                <p className="mt-1 text-emerald-200/90">
                  Your scans, loads and settlement history are all here.
                </p>
              </div>
            </div>

            {/* The one thing left that the driver has to do on their own device. Shown
                here because this is the moment they are holding the phone. */}
            <InstallHintSection />

            <Button
              type="button"
              onClick={() => navigate('/driver/scan')}
              className="h-14 w-full rounded-xl text-base font-semibold"
            >
              Open the driver app
            </Button>
          </div>
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
              {codeKind === 'CONFIRM_RESET' ? 'Set my password' : 'Verify email'}
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

        {/* Only on the first screen. Once a code is in flight, "already have an account?"
            is both answered and the wrong thing to act on. */}
        {step === 'form' && (
          <div className="mt-8 text-center text-sm text-slate-400">
            <p>
              Already have an account?{' '}
              <Link to="/driver/login" className="font-semibold text-[#1ea8f3] hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
