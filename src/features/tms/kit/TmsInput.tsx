import { forwardRef } from 'react'
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

export const TmsInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => <input ref={ref} className={`tms-input${className ? ` ${className}` : ''}`} {...rest} />
)
TmsInput.displayName = 'TmsInput'

export const TmsTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => (
    <textarea ref={ref} className={`tms-textarea${className ? ` ${className}` : ''}`} {...rest} />
  )
)
TmsTextarea.displayName = 'TmsTextarea'
