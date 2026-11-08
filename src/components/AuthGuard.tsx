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
        className="tms-portal min-h-screen flex items-center justify-center"
        style={{ background: 'var(--tms-bg)' }}
      >
        <div className="text-sm" style={{ color: 'var(--tms-muted)' }}>Loading…</div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  return <>{children}</>
}
