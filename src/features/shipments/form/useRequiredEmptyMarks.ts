import { useEffect } from 'react'

/**
 * Marks every control in the shipment form with data-empty="true|false" from its live value, so required fields are
 * green only while they are empty (form.css). Runs after every render of the form: cheap, and no field needs to know.
 */
export function markEmptyControls(root: ParentNode): void {
  const controls = root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')
  controls.forEach((el) => {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return
    el.setAttribute('data-empty', el.value.trim() === '' ? 'true' : 'false')
  })
}

export function useRequiredEmptyMarks(deps: unknown): void {
  useEffect(() => {
    const root = document.querySelector('.tms-ship-form')
    if (root) markEmptyControls(root)
  }, [deps])
}
