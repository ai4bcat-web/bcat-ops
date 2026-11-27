import { Link, useSearchParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'

/** Shown on Payments Received and Accounts Payable when Auto Shipper Loads sent you there (`?from=auto-shipper-loads`). */
export function BackToAutoShipperLoads() {
  const [params] = useSearchParams()
  if (params.get('from') !== 'auto-shipper-loads') return null
  return (
    <p className="text-sm" data-testid="back-to-auto-shipper-loads" style={{ margin: '0 0 8px' }}>
      <Link to="/auto-shipper-loads"><ChevronLeft size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Back to Auto Shipper Loads</Link>
    </p>
  )
}
