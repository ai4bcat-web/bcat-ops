/**
 * Guard for a page whose tables ship in a later schema stage (see `lib/dormantPages.ts`).
 *
 * While any listed model is missing from the deployed schema the page is never mounted, so none of
 * its queries run; the person sees a calm empty state instead of a GraphQL error. Once the stage
 * deploys and `amplify_outputs.json` lists the models, the children render with no other change.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
import { DORMANT_PAGES, type DormantPageKey } from '@/lib/dormantPages'
import { modelsAvailable } from '@/lib/modelAvailability'

const HOME = { to: '/tms/dashboard', label: 'Back to Company Dashboard' }

export interface RequireModelsProps {
  /** Every model the page needs; one missing is enough to switch the page off. */
  models: readonly string[]
  /** "<Area> turns on during the merge". */
  area: string
  /** The way out; default is the Company Dashboard. */
  back?: { to: string; label: string }
  children: ReactNode
}

export function RequireModels({ models, area, back = HOME, children }: RequireModelsProps) {
  if (modelsAvailable(models)) return <>{children}</>
  return (
    <div className="tms-page">
      <div className="tms-empty" role="status" data-testid="dormant-page">
        <Info className="tms-empty-icon" size={20} aria-hidden="true" />
        <h1 className="tms-empty-title">{area} turns on during the merge</h1>
        <div className="tms-empty-sub">
          This area switches on when the merge finishes. Nothing is wrong and no data is lost. Existing pages keep working.
        </div>
        <Link className="tms-empty-action" to={back.to}>{back.label}</Link>
      </div>
    </div>
  )
}

/** A route body guarded by its row in the page -> models table. */
export function DormantPage({ page, children }: { page: DormantPageKey; children: ReactNode }) {
  const def: { area: string; models: readonly string[]; back?: { to: string; label: string } } = DORMANT_PAGES[page]
  return <RequireModels area={def.area} models={def.models} back={def.back}>{children}</RequireModels>
}

export default RequireModels
