import type { ReactNode } from 'react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'

export interface BoardToneKey {
  key: string
  label: string
  statuses: string[]
}

export interface BoardExceptionKey {
  icon: ReactNode
  meaning: string
}

export interface IconKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tones: BoardToneKey[]
  exceptions: BoardExceptionKey[]
}

/** Legend dialog: row tones and exception icons are both supplied by the page. */
export function IconKeyDialog({ open, onOpenChange, tones, exceptions }: IconKeyDialogProps) {
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Icon key"
      className="tms-dialog-wide"
      footer={
        <TmsButton variant="secondary" onClick={() => onOpenChange(false)}>
          Done
        </TmsButton>
      }
    >
      <div className="tms-board-key-grid">
        <div className="tms-board-key-section">
          <h3 className="tms-board-key-heading">Row tones</h3>
          <div className="tms-board-key-list">
            {tones.map((tone) => (
              <div key={tone.key} className="tms-board-key-row">
                <span className={`tms-board-key-swatch tms-board-key-swatch-${tone.key}`} />
                <span className="tms-board-key-name">{tone.label}</span>
                <span className="tms-board-key-statuses">{tone.statuses.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>

        {exceptions.length > 0 ? (
          <div className="tms-board-key-section">
            <h3 className="tms-board-key-heading">Exception icons</h3>
            <div className="tms-board-key-list">
              {exceptions.map((ex, i) => (
                <div key={i} className="tms-board-key-row">
                  <span className="tms-board-key-icon">{ex.icon}</span>
                  <span className="tms-board-key-name">{ex.meaning}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </TmsDialog>
  )
}

export default IconKeyDialog
