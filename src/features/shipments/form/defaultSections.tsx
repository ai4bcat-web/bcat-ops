/**
 * The twelve section components, looked up by key. The page imports this and nothing else from
 * `sections/`, so a test can replace the whole registry with one `vi.mock('./defaultSections')`.
 */
import { CarrierInformationSection } from './sections/CarrierInformationSection'
import { CheckCallsSection } from './sections/CheckCallsSection'
import { CustomerSection } from './sections/CustomerSection'
import { FormDocumentsSection } from './sections/FormDocumentsSection'
import { HistoricalRatesSection } from './sections/HistoricalRatesSection'
import { MoreInformationSection } from './sections/MoreInformationSection'
import { PicksAndStopsSection } from './sections/PicksAndStopsSection'
import { RatesSection } from './sections/RatesSection'
import { RolesSection } from './sections/RolesSection'
import { ShippingRequirementsSection } from './sections/ShippingRequirementsSection'
import { StopSection } from './sections/StopSection'
import type { SectionComponents } from './sectionRegistry'

export const SECTION_COMPONENTS: SectionComponents = {
  shipping: ShippingRequirementsSection,
  customer: CustomerSection,
  pickup: StopSection,
  consignee: StopSection,
  history: HistoricalRatesSection,
  roles: RolesSection,
  more: MoreInformationSection,
  rates: RatesSection,
  carrier: CarrierInformationSection,
  picks: PicksAndStopsSection,
  documents: FormDocumentsSection,
  checkCalls: CheckCallsSection,
}
