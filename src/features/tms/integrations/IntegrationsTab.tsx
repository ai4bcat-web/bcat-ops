/**
 * Integrations — the eighth tab of My Brokerage, owner and ADMIN only.
 *
 * The tab owns two routes: the index of every provider the registry knows, and one
 * page per provider. `BrokeragePage` carries the h1 and the strip, so neither body
 * renders a heading of its own, and `activeTab` keys on the first path segment, which
 * is why a deep link to a provider still lights the tab.
 */
import { Navigate, Route, Routes } from 'react-router-dom'
import { IntegrationsIndex } from './IntegrationsIndex'
import { IntegrationPage } from './IntegrationPage'

export function IntegrationsTab() {
  return (
    <Routes>
      <Route index element={<IntegrationsIndex />} />
      <Route path=":provider" element={<IntegrationPage />} />
      {/* A stale provider link is a stale link, not a dead end. */}
      <Route path="*" element={<Navigate to="/tms/brokerage/integrations" replace />} />
    </Routes>
  )
}

export default IntegrationsTab
