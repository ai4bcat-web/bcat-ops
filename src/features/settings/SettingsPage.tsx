/**
 * The Settings tab of My Brokerage: every house rule, one card each.
 *
 * This is a *body*, not a page — `BrokeragePage` owns the title row and the tab strip,
 * and mounts this under the Settings tab. Everything above `EscalationRulesCard` is
 * admin-only, exactly as before; the two compliance cards below it stay visible to
 * anyone who can open Settings.
 */
import { useState } from 'react'
import { EyeOff } from 'lucide-react'
import { EmailSettingsCard } from '@/features/compliance/EmailSettingsCard'
import { EscalationRulesCard } from '@/features/compliance/EscalationRulesCard'
import { PrivateDocsModal } from '@/features/files/PrivateDocsModal'
import { TmsButton } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { TmsSettingsCard } from './TmsSettingsCard'
import { CarrierBookingSettingsCard } from './CarrierBookingSettingsCard'
import { TrackingSettingsCard } from './TrackingSettingsCard'
import { PostalCodeAliasesCard } from './PostalCodeAliasesCard'
import { DocumentSettingsCard } from './DocumentSettingsCard'
import { ArSettingsCard } from './ArSettingsCard'
import { ApSettingsCard } from './ApSettingsCard'
import { QuoteSettingsCard } from './QuoteSettingsCard'
import { ShipmentSettingsCard } from './ShipmentSettingsCard'
import { ChargeCodesCard } from './ChargeCodesCard'
import { CustomerSettingsCard } from './CustomerSettingsCard'
import { CarrierDocumentsCard } from './CarrierDocumentsCard'
import { ConsolidationCard } from './ConsolidationCard'
import { TeamsCard } from './TeamsCard'
import { UsersRolesCard } from './UsersRolesCard'
import { CommissionSettingsCard } from './CommissionSettingsCard'
import { SettingsCard, Stack } from './settingsKit'

export function SettingsPage() {
  const { isAdmin } = useAuth()
  const [docsOpen, setDocsOpen] = useState(false)

  return (
    <Stack gap={16}>
      {isAdmin && (
        <>
          <SettingsCard
            icon={EyeOff}
            title="Documents"
            description="Which documents are hidden from non-admins, and who maintains each one."
            actions={<TmsButton size="sm" onClick={() => setDocsOpen(true)}>Configure</TmsButton>}
          />

          <ShipmentSettingsCard />
          <ConsolidationCard />
          <TmsSettingsCard />
          <CustomerSettingsCard />
          <CarrierBookingSettingsCard />
          <CarrierDocumentsCard />
          <TrackingSettingsCard />
          <PostalCodeAliasesCard />
          <DocumentSettingsCard />
          <ArSettingsCard />
          <ApSettingsCard />
          <QuoteSettingsCard />
          <TeamsCard />
          <CommissionSettingsCard />
          <ChargeCodesCard />
          <UsersRolesCard />
        </>
      )}

      <EscalationRulesCard />
      <EmailSettingsCard />

      {docsOpen && <PrivateDocsModal onClose={() => setDocsOpen(false)} />}
    </Stack>
  )
}
