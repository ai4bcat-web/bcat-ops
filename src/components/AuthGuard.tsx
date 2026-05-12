import { useAuth } from '@/hooks/useAuth'
import { LoginPage } from '@/pages/LoginPage'

interface AuthGuardProps {
  children: React.ReactNode
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: '#07122b' }}
      >
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  return <>{children}</>
}
