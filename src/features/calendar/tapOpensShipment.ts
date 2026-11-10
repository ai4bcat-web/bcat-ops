/**
 * Whether a tap on a row opens its shipment: on a touch screen (or a narrow one), and only when the tap did not land on something
 * that does its own thing (a button, link, field, the colour swatch, or an open picker).
 */
export function tapOpensShipment(target: EventTarget | null): boolean {
  const touch = typeof window !== 'undefined'
    && (window.matchMedia?.('(pointer: coarse)')?.matches === true || window.innerWidth <= 900)
  if (!touch) return false
  const el = target instanceof Element ? target : null
  return !!el && !el.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [tabindex], .absolute')
}
