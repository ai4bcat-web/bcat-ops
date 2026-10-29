import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type TmsButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'

export interface TmsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: TmsButtonVariant
  size?: 'md' | 'sm'
  children?: ReactNode
}

export function TmsButton({ variant = 'secondary', size = 'md', className, type, ...rest }: TmsButtonProps) {
  const classes = ['tms-btn', `tms-btn-${variant}`, size === 'sm' ? 'tms-btn-sm' : '', className ?? '']
  return <button type={type ?? 'button'} className={classes.filter(Boolean).join(' ')} {...rest} />
}

/** The dark round icon buttons in the title row and the square ones in the top bar. */
export function TmsIconButton({
  shape = 'round',
  className,
  type,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { shape?: 'round' | 'square' | 'plain' }) {
  const modifier = shape === 'square' ? ' tms-icon-btn-sq' : shape === 'plain' ? ' tms-icon-btn-plain' : ''
  return <button type={type ?? 'button'} className={`tms-icon-btn${modifier}${className ? ` ${className}` : ''}`} {...rest} />
}

export default TmsButton
