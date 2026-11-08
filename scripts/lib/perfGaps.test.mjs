import { describe, it, expect } from 'vitest'
import { scanR1, scanDirectory, scanPolls, payHookViolations, scanAF } from './perfGaps.mjs'

describe('scanR1', () => {
  it('flags a page calling a full-table list but not the allowlisted client, tests, or similarly named indexed reads', () => {
    const hits = scanR1({
      'src/lib/apiClient.ts': 'export async function listShipments() {}\nawait listShipments()',
      'src/features/x/Page.tsx': 'const rows = await listShipments()\nawait listShipmentsByMonth(m)\nawait listLoadByStatus(s)',
      'src/features/x/Page.test.tsx': 'vi.mocked(listOrders)\nawait listOrders()',
      'src/features/y/Other.tsx': '// listLoads() in a comment\nimport { listLoads } from "@/lib/apiClient"',
    })
    expect(hits).toEqual([{ path: 'src/features/x/Page.tsx', line: 1, symbol: 'listShipments' }])
  })

  it('flags the unfiltered audit-log scan only', () => {
    const hits = scanR1({ 'src/features/c/P.tsx': 'await listAuditLogs()\nawait listAuditLogs(ids)\nawait listAuditLogsFor(e)' })
    expect(hits).toEqual([{ path: 'src/features/c/P.tsx', line: 1, symbol: 'listAuditLogs()' }])
  })
})

describe('scanDirectory', () => {
  it('requires locations:false except on the needs-locations allowance', () => {
    const hits = scanDirectory({
      'src/features/a/A.tsx': 'const d = useDirectory({ includeArchived: true, locations: false })',
      'src/features/b/B.tsx': 'const d = useDirectory()',
      'src/features/directory/DirectoryPages.tsx': 'useDirectory({ includeArchived: true, locations: false })\nuseDirectory({ includeArchived: true, locations: id != null })\nuseDirectory()\nuseDirectory({ locations: true })',
    })
    expect(hits).toEqual([
      { path: 'src/features/b/B.tsx', line: 1 },
      { path: 'src/features/directory/DirectoryPages.tsx', line: 4 },
    ])
  })
})

describe('scanPolls', () => {
  it('flags an interval hook with no visibility gate', () => {
    expect(scanPolls({
      'src/hooks/useReviewQueue.ts': 'setInterval(tick, 60000)',
      'src/hooks/useIntakeItems.ts': "setInterval(() => { if (document.visibilityState === 'hidden') return; tick() }, 30000)",
    })).toEqual([{ path: 'src/hooks/useReviewQueue.ts' }])
  })
})

describe('payHookViolations', () => {
  it('accepts the windowing import and call and nothing else', () => {
    const ok = [
      "-import { useLoads } from '@/hooks/useLoads'",
      "+import { useLoads, useEnsureLoadRange } from '@/hooks/useLoads'",
      '+  useEnsureLoadRange(from, to)',
    ].join('\n')
    expect(payHookViolations(ok)).toEqual([])
  })

  it('rejects a math change slipped in beside the window call', () => {
    const bad = ['+  useEnsureLoadRange(from, to)', '-  const pay = miles * rate', '+  const pay = miles * rate * 1.01'].join('\n')
    expect(payHookViolations(bad)).toEqual(['+  const pay = miles * rate * 1.01', '-  const pay = miles * rate'])
  })

  it('rejects a deleted line when there is no windowing change to explain it', () => {
    expect(payHookViolations('-  const total = sum(rows)')).toEqual(['-  const total = sum(rows)'])
  })

  it('accepts the loading flag and the listLoads() fetch swap, but not math beside them', () => {
    const swap = [
      "-import { listLoads, listDriverPaySettings } from '@/lib/apiClient'",
      "+import { listDriverPaySettings } from '@/lib/apiClient'",
      "+import { useLoads, useEnsureLoadRange } from './useLoads'",
      '-  const [loads, setLoads] = useState<Load[]>([])',
      '+  const { loads } = useLoads()',
      '+  const ready = useEnsureLoadRange(start, end)',
      '-    Promise.all([listLoads(), listDriverPaySettings()])',
      '+    Promise.all([listDriverPaySettings()])',
      '-  return { loading, error, rows }',
      '+  return { loading: loading || !ready, error, rows }',
    ].join('\n')
    expect(payHookViolations(swap)).toEqual([])
    expect(payHookViolations(`${swap}\n+  const net = gross * 0.9`)).toEqual(['+  const net = gross * 0.9'])
  })

  it('accepts the exact backlog merge in useDashboardMetrics and nothing else in that file', () => {
    const ok = [
      "+import { useNeedsInvoiceBacklog } from './useNeedsInvoiceBacklog'",
      '+  const backlog = useNeedsInvoiceBacklog()',
      '-    const needsInvoice = loads.filter(',
      '+    const held = new Set(allLoads.map((l) => l.id))',
      '+    const needsInvoice = (backlog.length > 0 ? [...loads, ...backlog.filter((l) => !held.has(l.id))] : loads).filter(',
      '-  }, [loads, drivers, rangeKey])',
      '+  }, [loads, allLoads, backlog, drivers, rangeKey])',
    ].join('\n')
    expect(payHookViolations(ok, 'src/hooks/useDashboardMetrics.ts')).toEqual([])
    expect(payHookViolations(ok, 'src/hooks/useBoxTruckPay.ts').length).toBeGreaterThan(0)
    expect(payHookViolations(`${ok}\n-      (l) => l.readyToInvoiceAt == null`, 'src/hooks/useDashboardMetrics.ts')).toEqual(['-      (l) => l.readyToInvoiceAt == null'])
  })
})

describe('scanAF (G11)', () => {
  it('flags the working-set read and a loadFinancials import in the company dashboard, not in tests or elsewhere', () => {
    const hits = scanAF({
      'src/features/tms/dashboard/useBrokerageDashboard.ts': "import { getLoadFinancials } from '@/lib/apiClient'\nconst b = load({ kind: 'working' })",
      'src/features/tms/dashboard/useBrokerageDashboard.test.ts': "load({ kind: 'working' })",
      'src/features/tms/shipments/Board.tsx': "load({ kind: 'working' })",
      'src/features/tms/dashboard/Other.ts': "// kind: 'working' in a comment\nconst loadFinancials = []",
    })
    expect(hits.workingSet).toEqual([{ path: 'src/features/tms/dashboard/useBrokerageDashboard.ts', line: 2 }])
    expect(hits.financials).toEqual([{ path: 'src/features/tms/dashboard/useBrokerageDashboard.ts', line: 1, symbol: 'getLoadFinancials' }])
  })

  it('accepts widgets inside LazyWidget and flags a bare mount', () => {
    const page = [
      '<LazyWidget height={300}>',
      '  <YearProfitWidget />',
      '</LazyWidget>',
      '<LazyWidget height={200}><DieselPriceWidget /></LazyWidget>',
      '<DriverLeaderboardWidget />',
    ].join('\n')
    expect(scanAF({ 'src/features/dashboard/DashboardPage.tsx': page }).widgets).toEqual([{ path: 'src/features/dashboard/DashboardPage.tsx', line: 5, widget: 'DriverLeaderboardWidget' }])
  })

  it('flags any remaining useDashboardMetrics reference under src', () => {
    expect(scanAF({ 'src/features/dashboard/DashboardPage.tsx': "import { useDashboardMetrics } from '@/hooks/useDashboardMetrics'" }).metricsHook).toHaveLength(1)
    expect(scanAF({ 'src/features/dashboard/DashboardPage.tsx': 'useLegacyDashboardKpis()' }).metricsHook).toEqual([])
  })
})
