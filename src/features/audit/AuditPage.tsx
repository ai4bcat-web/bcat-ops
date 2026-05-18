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
    <div className="h-full overflow-auto">
      <div className="px-8 py-5 border-b border-border sticky top-0 z-10 bg-white">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Audit Log</h1>
        <p className="text-xs text-muted-foreground mt-0.5">{entries.length} entries · most recent first</p>
      </div>

      <div className="p-8">
        {entries.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            No audit entries yet. Make a change to see it here.
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200/60 overflow-hidden bg-white shadow-sm">
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
                        <pre className="mt-1.5 text-[10px] text-muted-foreground rounded-md p-2 max-w-xs overflow-auto border border-border bg-slate-100">
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
