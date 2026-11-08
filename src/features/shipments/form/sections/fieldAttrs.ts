import { labelFor, type LabelDef } from '../labels'

/** The accessible name + harness id every labelled control carries (AH-plan §6). */
export function fieldAttrs(def: LabelDef) {
  return { 'aria-label': labelFor(def), 'data-testid': def.testId }
}
