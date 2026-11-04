/** Stateful host for the AH4 section tests: owns the values object the way `useShipmentForm` does. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormApi } from '../sectionRegistry'

export interface Host {
  getValues: () => ShipmentFormValues
  form: FormApi
}

/** Children receive the live values, a whole-values updater and the stable `form` handle. */
export function ValuesHost({ initial, onHost, children }: {
  initial?: ShipmentFormValues
  onHost?: (host: Host) => void
  children: (values: ShipmentFormValues, update: (fn: (prev: ShipmentFormValues) => ShipmentFormValues) => void, form: FormApi) => ReactNode
}) {
  const [values, setValues] = useState(initial ?? emptyValues())
  const latestRef = useRef(values)
  useEffect(() => { latestRef.current = values }, [values])
  const [form] = useState<FormApi>(() => ({
    getValues: () => latestRef.current,
    update: (fn) => setValues((prev) => fn(prev)),
    focusField: vi.fn(),
  }))
  useEffect(() => { onHost?.({ getValues: () => latestRef.current, form }) }, [onHost, form])
  return <MemoryRouter>{children(values, form.update, form)}</MemoryRouter>
}
