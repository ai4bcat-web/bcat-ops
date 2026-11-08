/**
 * What this bundle was built from. `vite.config.ts` stamps `__BCAT_BUILD__` at build
 * time; this is the only reader (nobody else touches the global), and it never throws:
 * under vitest or any context where the define is absent every field is null.
 */
export interface BuildInfo {
  commit: string | null
  jobId: string | null
  branch: string | null
  builtAt: string | null
  /** The dev stack: branch `dev`, or a host that starts `dev.` when the branch is unknown. */
  isDev: boolean
}

interface RawBuild {
  commit?: string | null
  jobId?: string | null
  branch?: string | null
  builtAt?: string | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Pure on purpose: the define and the hostname are parameters so tests can pin both. */
export function readBuildInfo(raw?: RawBuild | null, hostname?: string): BuildInfo {
  const branch = text(raw?.branch)
  const host = (hostname ?? '').toLowerCase()
  return {
    commit: text(raw?.commit),
    jobId: text(raw?.jobId),
    branch,
    builtAt: text(raw?.builtAt),
    isDev: branch === 'dev' || (branch === null && host.startsWith('dev.')),
  }
}

export const BUILD: BuildInfo = readBuildInfo(
  typeof __BCAT_BUILD__ === 'undefined' ? null : __BCAT_BUILD__,
  typeof window === 'undefined' ? '' : window.location.hostname,
)
