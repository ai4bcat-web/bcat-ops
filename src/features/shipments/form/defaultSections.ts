/**
 * The five cards and the "More" tabs, looked up by key. The page imports this and nothing else from
 * `cards/`, so a test can replace the whole registry with one `vi.mock('./defaultSections')`.
 * (The twelve Aljex section components stay the building blocks; the cards import them directly.)
 */
import { RolesSection } from './sections/RolesSection'
import { CarrierCard } from './cards/CarrierCard'
import type { CardComponents, MoreTabComponents } from './cards/cardRegistry'
import { CustomerCard } from './cards/CustomerCard'
import { FreightCard } from './cards/FreightCard'
import { RatesCard } from './cards/RatesCard'
import { RouteCard } from './cards/RouteCard'
import { CheckCallsTab } from './cards/more/CheckCallsTab'
import { DocumentsTab } from './cards/more/DocumentsTab'
import { InstructionsTab } from './cards/more/InstructionsTab'
import { ItemsTab } from './cards/more/ItemsTab'
import { NotesTab } from './cards/more/NotesTab'
import { RateHistoryTab } from './cards/more/RateHistoryTab'
import { ReferencesTab } from './cards/more/ReferencesTab'
import { UpdatesTab } from './cards/more/UpdatesTab'

export const CARD_COMPONENTS: CardComponents = {
  customer: CustomerCard,
  route: RouteCard,
  freight: FreightCard,
  rates: RatesCard,
  carrier: CarrierCard,
}

export const MORE_TAB_COMPONENTS: MoreTabComponents = {
  instructions: InstructionsTab,
  references: ReferencesTab,
  items: ItemsTab,
  notes: NotesTab,
  documents: DocumentsTab,
  rateHistory: RateHistoryTab,
  checkCalls: CheckCallsTab,
  updates: UpdatesTab,
}

/** The Roles section, mounted in the summary rail (sales rep, service rep, dispatcher, tariff, quote link). */
export const RAIL_ROLES = RolesSection
