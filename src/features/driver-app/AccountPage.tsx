import { useEffect, useState } from 'react'
import { LogOut, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchMe, type DriverProfile } from './driverApi'
import { useDriverAuth } from './useDriverAuth'
import { TruckLine } from './TruckPicker'

export function AccountPage() {
  const { signOut } = useDriverAuth()
  const [profile, setProfile] = useState<DriverProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    let stale = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const p = await fetchMe()
        if (!stale) setProfile(p)
      } catch (err) {
        if (!stale) setError(err instanceof Error ? err.message : 'Could not load your profile.')
      } finally {
        if (!stale) setLoading(false)
      }
    }
    void load()
    return () => {
      stale = true
    }
  }, [])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="mb-5 text-xl font-bold text-foreground">Account</h1>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true" />
          <p>Loading profile…</p>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-center text-destructive">
          {error}
        </div>
      )}

      {!loading && profile && (
        <div className="flex flex-col gap-4">
          <TruckLine />
          <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <User className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-card-foreground">{profile.name}</p>
              <p className="truncate text-sm text-muted-foreground">{profile.email}</p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dl className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Pay group</dt>
                <dd className="text-sm font-semibold text-card-foreground">{profile.payGroup}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Status</dt>
                <dd className="text-sm font-semibold text-[var(--ds-green)]">
                  {profile.active ? 'Active' : 'Inactive'}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-secondary/50 p-4">
            <p className="text-sm leading-relaxed text-secondary-foreground">
              Questions about your pay or hours? Contact dispatch — do not reply to automated
              statements.
            </p>
          </div>

          <Button
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            variant="outline"
            className="mt-2 h-12 w-full gap-2 text-base"
          >
            <LogOut className="h-5 w-5" aria-hidden="true" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      )}
    </div>
  )
}
