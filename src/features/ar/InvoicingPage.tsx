/**
 * `/tms/invoicing` — one page, two sides of the same money: Receivable (what customers
 * owe us) and Payable (what we owe carriers). MVMNT keeps them under one nav item, and
 * so does this: the view tabs are the only thing that changes, each list keeps its own
 * ladder as the status quick-tabs.
 *
 * `/tms/invoicing/payable` lands on the second tab; the route guards still decide who may
 * open which side, and a caller who may only see one side is only offered that one.
 */
import { useLocation, useNavigate } from 'react-router-dom'
import type { TmsTab } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { ApPage } from '@/features/ap/ApPage'
import { FactoringPage } from '@/features/factoring/FactoringPage'
import { ArPage } from './ArPage'

export function InvoicingPage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { hasPageAccess } = useAuth()

  const payable = pathname.startsWith('/tms/invoicing/payable')
  // Factored invoices (sent to OTR) live in their own view; Receivable is what we invoice by hand.
  const factored = pathname.startsWith('/tms/invoicing/factored')
  // The routes accept the original page key or `tms`, so the tabs do too — a `page-tms`
  // user sees both sides, exactly as the guards let them.
  const tms = hasPageAccess('tms')
  const tabs: TmsTab[] = [
    ...(tms || hasPageAccess('invoicing') ? [{ key: 'receivable', label: 'Receivable' }] : []),
    ...(tms || hasPageAccess('factoring') ? [{ key: 'factored', label: 'Factored' }] : []),
    ...(tms || hasPageAccess('carrierPay') ? [{ key: 'payable', label: 'Payable' }] : []),
  ]

  const viewTabs = {
    tabs,
    active: payable ? 'payable' : factored ? 'factored' : 'receivable',
    onSelect: (key: string) => navigate(key === 'payable' ? '/tms/invoicing/payable' : key === 'factored' ? '/tms/invoicing/factored' : '/tms/invoicing'),
  }

  if (payable) return <ApPage viewTabs={viewTabs} />
  if (factored) return <FactoringPage viewTabs={viewTabs} />
  return <ArPage viewTabs={viewTabs} />
}

export default InvoicingPage
