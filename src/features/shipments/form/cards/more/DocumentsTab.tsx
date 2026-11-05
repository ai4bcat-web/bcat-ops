/** More ▸ Documents: Public / Private tabs, the upload row and (create mode) the upload queue. */
import { memo } from 'react'
import { FormDocumentsSection } from '../../sections/FormDocumentsSection'
import { sliceOf, type CardProps } from '../cardRegistry'

function DocumentsTabImpl({ values, update, ctx, form }: CardProps) {
  return <FormDocumentsSection value={values.docs} onChange={sliceOf(update, 'docs')} ctx={ctx} form={form} />
}

export const DocumentsTab = memo(DocumentsTabImpl)
