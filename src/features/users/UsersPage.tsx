import { useState, useEffect, useCallback } from 'react'
import { Users, Plus, UserCheck, UserX, RefreshCw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useAuth } from '@/hooks/useAuth'
import {
  listCognitoUsers, createCognitoUser,
  disableCognitoUser, enableCognitoUser,
  type CognitoUser,
} from '@/lib/apiClient'
import { toast } from 'sonner'

export function UsersPage() {
  const { isAdmin } = useAuth()
  const [users, setUsers] = useState<CognitoUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listCognitoUsers()
      // Guard: ensure we got an array
      setUsers(Array.isArray(list) ? list : [])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) loadUsers()
  }, [isAdmin, loadUsers])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newEmail.trim()) return
    setCreating(true)
    try {
      await createCognitoUser(newEmail.trim())
      toast.success(`Invite sent to ${newEmail}`)
      setNewEmail('')
      await loadUsers()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to send invite')
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (user: CognitoUser) => {
    setTogglingId(user.username)
    try {
      if (user.enabled) {
        await disableCognitoUser(user.username)
        toast.success(`${user.email} disabled`)
      } else {
        await enableCognitoUser(user.username)
        toast.success(`${user.email} enabled`)
      }
      await loadUsers()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update user')
    } finally {
      setTogglingId(null)
    }
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <Users className="size-10 opacity-20" />
        <p className="text-sm">Admin access required</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-4 min-h-[52px] border-b border-border shrink-0"
        style={{ background: 'linear-gradient(180deg,#0e2454 0%,#07122b 100%)' }}
      >
        <Users className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold text-foreground">User Management</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={loadUsers}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-2xl mx-auto w-full">

        {/* Invite form */}
        <div
          className="rounded-lg border border-border p-4 space-y-3"
          style={{ background: '#0d1d3d' }}
        >
          <div>
            <h2 className="text-sm font-semibold text-foreground">Invite New User</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              They'll receive an email with a temporary password to log in.
            </p>
          </div>
          <form onSubmit={handleCreate} className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Email Address
              </Label>
              <Input
                type="email"
                placeholder="driver@bcatcorp.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="h-9"
                required
                disabled={creating}
              />
            </div>
            <Button type="submit" size="sm" className="h-9 gap-1.5" disabled={creating || !newEmail.trim()}>
              <Plus className="size-4" />
              {creating ? 'Sending…' : 'Send Invite'}
            </Button>
          </form>
        </div>

        <Separator />

        {/* User list */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            All Users {!loading && `(${users.length})`}
          </h2>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
              <AlertTriangle className="size-4 text-destructive shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-destructive font-medium">Failed to load users</p>
                <p className="text-xs text-muted-foreground truncate">{error}</p>
              </div>
              <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={loadUsers}>
                Retry
              </Button>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : !error && users.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No users found.</p>
          ) : !error ? (
            <div className="rounded-lg border border-border overflow-hidden" style={{ background: '#0d1d3d' }}>
              {users.map((u, i) => {
                const statusLabel =
                  u.status === 'FORCE_CHANGE_PASSWORD' ? 'Pending first login'
                  : u.enabled ? 'Active'
                  : 'Disabled'

                return (
                  <div
                    key={u.username ?? i}
                    className={`flex items-center justify-between gap-3 px-4 py-3 ${i !== 0 ? 'border-t border-border' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {u.email ?? u.username ?? '—'}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span
                          className="text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: u.enabled ? '#4ade80' : '#94a3b8' }}
                        >
                          {statusLabel}
                        </span>
                        {u.createdAt && (
                          <span className="text-[10px] text-muted-foreground">
                            · Joined {new Date(u.createdAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-7 px-3 text-xs shrink-0 gap-1.5 ${
                        u.enabled
                          ? 'text-destructive border-destructive/30 hover:bg-destructive/5'
                          : 'text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/5'
                      }`}
                      onClick={() => handleToggle(u)}
                      disabled={togglingId === u.username}
                    >
                      {u.enabled ? (
                        <><UserX className="size-3" /> {togglingId === u.username ? '…' : 'Disable'}</>
                      ) : (
                        <><UserCheck className="size-3" /> {togglingId === u.username ? '…' : 'Enable'}</>
                      )}
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
