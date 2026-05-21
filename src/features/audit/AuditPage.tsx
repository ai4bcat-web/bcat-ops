import { useAuditLog } from '@/hooks/useAuditLog'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { formatDateTime } from '@/lib/date'

const ACTION_VARIANTS = {
  create: 'green' as const,
  update: 'orange' as const,
  delete: 'destructive' as const,
}

export function AuditPage() {
  const { entries } = useAuditLog()

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ padding: '20px 32px', borderBottom: '1px solid var(--ds-border)', position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--ds-t1)', letterSpacing: '-0.01em', margin: 0 }}>Audit Log</h1>
        <p style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{entries.length} entries · most recent first</p>
      </div>

      <div style={{ padding: 32 }}>
        {entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--ds-t3)', fontSize: 14 }}>
            No audit entries yet. Make a change to see it here.
          </div>
        ) : (
          <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ACTION_VARIANTS[entry.action]} className="capitalize text-xs">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{entry.entityType}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.entityId.slice(0, 8)}…
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{entry.user}</TableCell>
                    <TableCell>
                      <details className="cursor-pointer">
                        <summary className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                          {Object.keys(entry.changes).length} field(s)
                        </summary>
                        <pre className="mt-1.5 text-[10px] text-muted-foreground rounded-md p-2 max-w-xs overflow-auto border border-border" style={{ background: 'var(--ds-bg)' }}>
                          {JSON.stringify(entry.changes, null, 2)}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
