/**
 * The "More" strip under the ninth card: Instructions, References, Items, Notes. Every panel stays
 * mounted (hidden when not active) so required fields inside (references) are still in the DOM and
 * keep their values.
 */
import { memo, useRef, type KeyboardEvent } from 'react'
import { MORE_TAB_ORDER, MORE_TAB_TITLE, type CardProps, type MoreTabComponents, type MoreTabKey } from './cards/cardRegistry'

export interface MoreTabsProps {
  common: CardProps
  components: MoreTabComponents
  active: MoreTabKey
  onActive: (key: MoreTabKey) => void
  /** Blocking issues per tab, for the badge. */
  errors: Partial<Record<MoreTabKey, number>>
}

function MoreTabsImpl({ common, components, active, onActive, errors }: MoreTabsProps) {
  const keys = MORE_TAB_ORDER
  const listRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length]
    onActive(next)
    listRef.current?.querySelector<HTMLElement>(`[data-more-tab-btn="${next}"]`)?.focus()
  }
  return (
    <section className="tms-ship-more" data-testid="ship-form-more">
      <div className="tms-ship-more-tabs" role="tablist" aria-label="More" ref={listRef}>
        {keys.map((k, i) => (
          <button
            key={k} type="button" role="tab" id={`more-tab-${k}`} aria-controls={`more-panel-${k}`}
            aria-selected={active === k} tabIndex={active === k ? 0 : -1}
            className="tms-ship-more-tab" data-testid={`more-tab-${k}`} data-more-tab-btn={k}
            onClick={() => onActive(k)} onKeyDown={(e) => onKeyDown(e, i)}
          >
            {MORE_TAB_TITLE[k]}
            {(errors[k] ?? 0) > 0 ? <span className="tms-ship-card-badge" aria-label={`${errors[k]} problems`}>{errors[k]}</span> : null}
          </button>
        ))}
      </div>
      {keys.map((k) => {
        const Panel = components[k]
        return (
          <div
            key={k} id={`more-panel-${k}`} role="tabpanel" aria-labelledby={`more-tab-${k}`}
            className="tms-ship-more-panel" data-more-tab={k} hidden={active !== k} inert={active !== k}
          >
            <Panel {...common} />
          </div>
        )
      })}
    </section>
  )
}

export const MoreTabs = memo(MoreTabsImpl)
