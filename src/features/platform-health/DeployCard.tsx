/**
 * Section 4: what this tab is running. The backend Lambda version is not visible to the
 * browser and is not shown.
 */
import { TmsAlert, TmsButton, TmsCard, TmsMetaList } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import type { BuildInfo } from '@/lib/buildInfo'

export interface DeployCardProps {
  build: BuildInfo
  updateAvailable: boolean
  onReload: () => void
}

const NONE = 'Not recorded'

/** The hashed entry script this tab loaded; it changes on every deploy. */
function runningBundle(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src')
  return src ? src.split('/').pop() ?? null : null
}

export function DeployCard({ build, updateAvailable, onReload }: DeployCardProps) {
  return (
    <TmsCard title="Deploy & version">
      <TmsMetaList
        items={[
          { label: 'Commit', value: build.commit ? build.commit.slice(0, 7) : NONE },
          { label: 'Amplify job', value: build.jobId ?? NONE },
          { label: 'Branch', value: build.branch ?? NONE },
          { label: 'Built at', value: build.builtAt ? formatDateTime(build.builtAt) : NONE },
          { label: 'Running bundle', value: runningBundle() },
        ]}
      />
      {updateAvailable ? (
        <TmsAlert tone="blue" title="A newer build is available">
          This tab is still running the build above.{' '}
          <TmsButton size="sm" onClick={onReload}>Reload</TmsButton>
        </TmsAlert>
      ) : null}
    </TmsCard>
  )
}

export default DeployCard
