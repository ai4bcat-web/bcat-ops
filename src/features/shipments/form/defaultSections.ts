/**
 * The six main-column cards, the header's Customer / Bill To parts and the "More" tabs, looked up by key. The page imports this and nothing else from
 * `cards/`, so a test can replace the whole registry with one `vi.mock('./defaultSections')`.
 * (The Aljex section components stay the building blocks; the cards import them directly.)
 */
import { BillToStrip } from './cards/BillToStrip'
import { CarrierTrackingCard } from './cards/CarrierTrackingCard'
import type { CardComponents, MoreTabComponents } from './cards/cardRegistry'
import { CustomerPicker, CustomerRef } from './cards/CustomerCard'
import { DocumentsCard } from './cards/DocumentsCard'
import { FreightCard } from './cards/FreightCard'
import { RateHistoryCard } from './cards/RateHistoryCard'
import { RatesCard } from './cards/RatesCard'
import { RouteCard } from './cards/RouteCard'
import { InstructionsTab } from './cards/more/InstructionsTab'
import { ItemsTab } from './cards/more/ItemsTab'
import { NotesTab } from './cards/more/NotesTab'
import { ReferencesTab } from './cards/more/ReferencesTab'
import { RolesSection } from './sections/RolesSection'

export const CARD_COMPONENTS: CardComponents = {
  freight: FreightCard,
  route: RouteCard,
  rates: RatesCard,
  rateHistory: RateHistoryCard,
  carrier: CarrierTrackingCard,
  documents: DocumentsCard,
}

/** The header strip's Customer type-ahead and Bill To chip + dropdown panel (feedback 7). */
export const HEADER_PARTS = { CustomerPicker, CustomerRef, BillToStrip }

export const MORE_TAB_COMPONENTS: MoreTabComponents = {
  instructions: InstructionsTab,
  references: ReferencesTab,
  items: ItemsTab,
  notes: NotesTab,
}

/** The Roles section, mounted in the summary rail (sales rep, service rep, dispatcher, tariff, quote link). */
export const RAIL_ROLES = RolesSection
