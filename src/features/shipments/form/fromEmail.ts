/**
 * Fields that were pre-filled from an intake load (the e-mail thread / rate confirmation): the set of
 * control `data-testid`s, shared with `LField` so each marked field shows a "from e-mail" chip.
 */
import { createContext } from 'react'

export const FromEmailContext = createContext<ReadonlySet<string>>(new Set())
