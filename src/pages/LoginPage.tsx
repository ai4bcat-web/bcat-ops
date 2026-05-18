import { useState } from 'react'
import { Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'

export function LoginPage() {
  const { login, completeNewPassword, needsNewPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
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
      className="min-h-screen flex items-center justify-center"
      style={{ background: '#f7f7f5' }}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border p-8 space-y-6"
        style={{ background: '#ffffff' }}
      >
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="ds-logo-pill">
            <Truck className="size-3.5 text-white" />
            <span className="text-xs font-bold text-white tracking-tight">BCAT OPS</span>
          </div>
          <span className="text-sm text-muted-foreground">Dispatch Portal</span>
        </div>

        {!needsNewPassword ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Sign in</h1>
              <p className="text-sm text-muted-foreground">
                Enter your credentials to access dispatch
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Email
                </Label>
                <Input
                  type="email"
                  placeholder="you@bcatcorp.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Password
                </Label>
                <Input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-9"
                />
              </div>

              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full h-9 font-semibold"
                disabled={loading}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Set new password</h1>
              <p className="text-sm text-muted-foreground">
                Your temporary password has expired. Create a permanent password to continue.
              </p>
            </div>

            <form onSubmit={handleNewPassword} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  New Password
                </Label>
                <Input
                  type="password"
                  placeholder="Min 8 chars, upper, lower, number, symbol"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoFocus
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Confirm Password
                </Label>
                <Input
                  type="password"
                  placeholder="Repeat new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="h-9"
                />
              </div>

              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full h-9 font-semibold"
                disabled={loading}
              >
                {loading ? 'Saving…' : 'Set Password & Sign in'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
