/**
 * The MVMNT component kit. Every TMS page builds from these; the look lives in
 * `src/features/tms/theme.css` (tokens, base) and `./kit.css` (kit-only rules), which
 * `TmsShell` and this barrel import.
 */
import './kit.css'

export { TmsShell, SHIPMENTS_PATH } from '../TmsShell'
export { isPathActive } from '../navActive'
export type { TmsShellProps, TmsNavSection, TmsNavItem, TmsNavChild, TmsNavChildGroup } from '../TmsShell'

// Page-family stylesheets (moved out of theme.css). Imported after TmsShell so they load
// after theme.css and keep their original cascade position.
import '../styles/board.css'
import '../styles/tracking.css'
import '../styles/detail.css'
import '../styles/money.css'
import '../styles/admin.css'

export { TmsPage } from './TmsPage'
export type { TmsPageProps } from './TmsPage'

export { TmsListPage } from './TmsListPage'
export type { TmsListPageProps, TmsTabGroup } from './TmsListPage'

export { TmsTable } from './TmsTable'
export type { TmsTableProps, ColumnDef, TmsSort } from './TmsTable'

export { TmsCard } from './TmsCard'
export type { TmsCardProps } from './TmsCard'

export { TmsTabs } from './TmsTabs'
export type { TmsTabsProps, TmsTab } from './TmsTabs'

export { TmsBadge } from './TmsBadge'
export { statusTone } from './statusTone'
export type { TmsTone } from './statusTone'

export { TmsButton, TmsIconButton } from './TmsButton'
export type { TmsButtonProps, TmsButtonVariant } from './TmsButton'

export { TmsInput, TmsTextarea } from './TmsInput'

export { TmsSelect } from './TmsSelect'
export type { TmsSelectProps, TmsSelectOption } from './TmsSelect'

export { TmsField } from './TmsField'
export type { TmsFieldProps } from './TmsField'

export { TmsKpiCard } from './TmsKpiCard'
export type { TmsKpiCardProps } from './TmsKpiCard'

export { TmsCountBadge } from './TmsCountBadge'
export type { TmsCountBadgeProps } from './TmsCountBadge'

export { TmsChartCard } from './TmsChartCard'
export type { TmsChartCardProps } from './TmsChartCard'

export { TmsEmptyState } from './TmsEmptyState'
export type { TmsEmptyStateProps } from './TmsEmptyState'

export { TmsFilterChip } from './TmsFilterChip'
export type { TmsFilterChipProps } from './TmsFilterChip'

export { TmsDialog } from './TmsDialog'
export { Trigger as TmsDialogTrigger, Close as TmsDialogClose } from '@radix-ui/react-dialog'
export type { TmsDialogProps } from './TmsDialog'

export { TmsKeyHint } from './TmsKeyHint'

export { TmsStatRow } from './TmsStatRow'
export type { TmsStat, TmsStatRowProps } from './TmsStatRow'

export { TmsSegmentedTabs } from './TmsSegmentedTabs'
export type { TmsSegmentedTabsProps } from './TmsSegmentedTabs'

export { TmsMetaList } from './TmsMetaList'
export type { TmsMetaItem, TmsMetaListProps } from './TmsMetaList'

export { TmsDetailSplit } from './TmsDetailSplit'
export type { TmsDetailSplitProps } from './TmsDetailSplit'

export { TmsProfileHeader, TmsAvatar } from './TmsProfileHeader'
export { initialsOf } from './initialsOf'
export type { TmsProfileHeaderProps, TmsProfileColumn } from './TmsProfileHeader'

export { TmsTimeline } from './TmsTimeline'
export type { TmsTimelineItem, TmsTimelineProps } from './TmsTimeline'

export { TmsApprovalCard } from './TmsApprovalCard'
export type { TmsApprovalCardProps } from './TmsApprovalCard'

export { TmsAlert } from './TmsAlert'
export type { TmsAlertProps } from './TmsAlert'

export { TmsSegmentedBar } from './TmsSegmentedBar'
export type { TmsSegment, TmsSegmentedBarProps } from './TmsSegmentedBar'

export { TmsDrawer } from './TmsDrawer'
export type { TmsDrawerProps } from './TmsDrawer'

export { TmsToaster } from './TmsToaster'

export { TmsPublicFrame } from './TmsPublicFrame'
export type { TmsPublicFrameProps } from './TmsPublicFrame'
