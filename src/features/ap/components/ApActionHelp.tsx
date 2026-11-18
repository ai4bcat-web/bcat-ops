/**
 * "What do these do?": the Payable buttons in plain words, one short line each. A native disclosure, so it needs
 * no popover library and works from the keyboard. The words live in `apActionCopy.ts`.
 */
import { apActionHelpRows } from '../apActionCopy'

export function ApActionHelp({ mode }: { mode: 'aging' | 'selected' }) {
  const rows = apActionHelpRows(mode)
  return (
    <details className="relative text-sm" data-testid="ap-action-help">
      <summary className="cursor-pointer tms-muted" style={{ listStyle: 'none' }}>What do these do?</summary>
      <div
        className="absolute right-0 z-20 mt-1 flex w-80 flex-col gap-2 p-3 text-left text-xs"
        style={{
          background: 'var(--tms-surface)',
          border: '1px solid var(--tms-border)',
          borderRadius: 'var(--tms-radius-card)',
          boxShadow: 'var(--tms-shadow-pop)',
        }}
      >
        {rows.map((row) => (
          <p key={row.label} className="m-0">
            <strong>{row.label}.</strong> {row.text}
          </p>
        ))}
      </div>
    </details>
  )
}
