import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw, Inbox, Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import {
  TEAM_MEMBERS, ACTIVE_STATUSES, assigneeLabel,
  ProNumberModal, QueueCard,
} from '@/features/intake/IntakePage'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import type { IntakeItem, IntakeStatus } from '@/types'

export function TasksPage() {
  const { items, loading, refresh, updateItem } = useIntakeItems()
  const { user } = useAuth()
  const setSelectedLoad      = useAppStore((s) => s.setSelectedLoad)
  const setPendingIntakeItem = useAppStore((s) => s.setPendingIntakeItem)

  const [searchParams] = useSearchParams()
  const filterAssignee = searchParams.get('assignee') ?? 'ALL'

  const [proModalItem, setProModalItem] = useState<IntakeItem | null>(null)

  const actorEmail = user?.email ?? 'dispatch'

  // All open tasks (NEW / IN_PROGRESS), optionally filtered by assignee
  const openTasks = useMemo(() => {
    let list = items.filter((i) => ACTIVE_STATUSES.has(i.status))
    if (filterAssignee !== 'ALL') list = list.filter((i) => i.assignedTo === filterAssignee)
    return list.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
  }, [items, filterAssignee])

  // Group by assignee
  const grouped = useMemo(() => {
    const byAssignee: Record<string, IntakeItem[]> = {}
    for (const item of openTasks) {
      const key = item.assignedTo ?? '__unassigned__'
      ;(byAssignee[key] ??= []).push(item)
    }

    // Order: TEAM_MEMBERS first (in order), then Unassigned
    const groups: { key: string; label: string; items: IntakeItem[] }[] = []
    for (const member of TEAM_MEMBERS) {
      if (byAssignee[member.email]?.length) {
        groups.push({ key: member.email, label: member.name, items: byAssignee[member.email] })
      }
    }
    if (byAssignee['__unassigned__']?.length) {
      groups.push({ key: '__unassigned__', label: 'Unassigned', items: byAssignee['__unassigned__'] })
    }
    return groups
  }, [openTasks])

  const handleStatusChange = async (id: string, status: IntakeStatus) => {
    await updateItem(id, { status }, { actorName: actorEmail })
  }

  const handleBuildLoad = (item: IntakeItem) => {
    if (item.status === 'NEW') {
      updateItem(item.id, { status: 'IN_PROGRESS' }, { actorName: actorEmail }).catch(() => {})
    }
    setPendingIntakeItem(item.id)
    setSelectedLoad(null, 'create')
  }

  const handleMarkDone = (item: IntakeItem) => {
    setProModalItem(item)
  }

  const handleProConfirm = async (proNumber: string) => {
    if (!proModalItem) return
    await updateItem(
      proModalItem.id,
      { status: 'DONE', proNumber },
      { actorName: actorEmail, proNumber },
    )
    setProModalItem(null)
  }

  const handleAssigneeChange = async (id: string, email: string) => {
    const displayName = assigneeLabel(email)
    await updateItem(
      id,
      { assignedTo: email },
      { actorName: actorEmail, reassignedTo: displayName },
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 32px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ds-t1)', letterSpacing: '-0.01em', margin: 0 }}>Tasks</h1>
          <p style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            Open intake items requiring action · grouped by assignee
          </p>
        </div>
        <div className="flex items-center gap-3">
          {filterAssignee !== 'ALL' && (
            <a
              href="/tasks"
              className="text-xs text-primary hover:underline font-medium"
            >
              Show all
            </a>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="space-y-8" style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading tasks…
          </div>
        ) : openTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
            <Inbox className="size-10 opacity-20" />
            <p className="text-sm font-medium">
              {filterAssignee !== 'ALL'
                ? `No open tasks for ${assigneeLabel(filterAssignee)}`
                : 'No open tasks — all clear!'}
            </p>
          </div>
        ) : (
          grouped.map(({ key, label, items: groupItems }) => (
            <section key={key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Users style={{ width: 14, height: 14, color: 'var(--ds-t3)' }} />
                </div>
                <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>{label}</h2>
                <span style={{ fontSize: 11, fontWeight: 700, background: 'var(--ds-border)', color: 'var(--ds-t2)', borderRadius: 999, padding: '2px 6px', minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {groupItems.length}
                </span>
                <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {groupItems.map((item) => (
                  <QueueCard
                    key={item.id}
                    item={item}
                    onBuildLoad={handleBuildLoad}
                    onMarkDone={handleMarkDone}
                    onStatusChange={handleStatusChange}
                    onAssigneeChange={handleAssigneeChange}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Pro# modal */}
      {proModalItem && (
        <ProNumberModal
          item={proModalItem}
          onConfirm={handleProConfirm}
          onClose={() => setProModalItem(null)}
        />
      )}

      <LoadDrawer />
    </div>
  )
}
