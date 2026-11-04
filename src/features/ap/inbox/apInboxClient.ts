/**
 * Step AG: typed helpers over the untyped `apInboxAction` door (`tmsApInboxActions`, `AP_INBOX_*`).
 * The response shapes are the contract with `amplify/functions/tms-ap-inbox/actions.ts`.
 */
import { apInboxAction } from '@/lib/apiClient'
import type { BillPlan, VendorPlan } from '@/lib/apInbox/applyPlan'
import type {
  ApConnectionStatus, ApInboxConfig, ApInboxItemRecord, ApRunDigest,
} from '@/lib/apInbox/types'

export type ApTargetKind = 'CARRIER_BILL' | 'LOAD_CARRIER' | 'VENDOR_PAYABLE'

export interface ApInboxStatusView {
  config: ApInboxConfig
  connection: { status: ApConnectionStatus; googleEmail: string | null; connectedAt: string | null; lastError: string | null }
  /** Newest first. */
  runs: ApRunDigest[]
  openCount: number
  devStack: boolean
  /** True when the Google OAuth client has been entered under Settings > Integrations > Google. */
  providerReady: boolean
  gapNote?: string
}

export interface ApLinkPreview {
  plan: BillPlan | VendorPlan
  target: { kind: ApTargetKind; id: string; label: string }
  /** The bill/payable version the plan was built on; LINK sends it back as a compare-and-set token. */
  version?: number
  /** Why nothing can be written (e.g. a paid bill); the dialog shows it and disables Apply. */
  blocked?: string
}

export interface ApSyncProgress { done: boolean; reviewed: number; remaining: number }

export const apInboxStatus = () => apInboxAction<ApInboxStatusView>('AP_INBOX_STATUS')
export const apInboxPreviewLink = (itemId: string, target: { kind: ApTargetKind; id: string }) =>
  apInboxAction<ApLinkPreview>('AP_INBOX_PREVIEW_LINK', { itemId, target })
export const apInboxSyncNow = () => apInboxAction<ApSyncProgress>('AP_INBOX_SYNC_NOW')
export const apInboxLink = (
  itemId: string, target: { kind: ApTargetKind; id: string }, picks: Record<string, boolean>, expectedVersion?: number,
) => apInboxAction<{ item: ApInboxItemRecord; fields: string[] }>('AP_INBOX_LINK', { itemId, target, picks, expectedVersion })
export const apInboxMarkCreated = (itemId: string, billId: string) =>
  apInboxAction<{ item: ApInboxItemRecord }>('AP_INBOX_MARK_CREATED', { itemId, billId })

export interface VendorBillInput {
  itemId: string
  vendor: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  amountCents: number | null
  description: string
}
export const apInboxCreateVendorBill = (input: VendorBillInput) =>
  apInboxAction<{ item: ApInboxItemRecord; vendorPayableId: string }>('AP_INBOX_CREATE_VENDOR_BILL', input)

export const DISMISS_REASONS = [
  { code: 'NOT_INVOICE', label: 'Not an invoice' },
  { code: 'DUPLICATE', label: 'Duplicate' },
  { code: 'ALREADY_HANDLED', label: 'Already handled' },
  { code: 'OTHER', label: 'Other' },
] as const
export const apInboxDismiss = (itemId: string, reason: string, note?: string) =>
  apInboxAction<{ item: ApInboxItemRecord }>('AP_INBOX_DISMISS', { itemId, reason, note })
export const apInboxRevert = (itemId: string) => apInboxAction<{ item: ApInboxItemRecord }>('AP_INBOX_REVERT', { itemId })

export const apInboxSaveSettings = (config: Partial<ApInboxConfig>, expectedVersion: number) =>
  apInboxAction<{ config: ApInboxConfig }>('AP_INBOX_SAVE_SETTINGS', { config, expectedVersion })
export const apInboxOauthStart = (redirectUri: string) => apInboxAction<{ url: string }>('AP_INBOX_OAUTH_START', { redirectUri })
export const apInboxOauthFinish = (code: string, state: string, redirectUri: string) =>
  apInboxAction<{ connected: boolean }>('AP_INBOX_OAUTH_FINISH', { code, state, redirectUri })
export const apInboxDisconnect = () => apInboxAction<unknown>('AP_INBOX_OAUTH_DISCONNECT')
export const apInboxConnectSimulated = () => apInboxAction<unknown>('AP_INBOX_CONNECT_SIMULATED')

/** The one OAuth return path (shared with the spot inbox); the `ap.` state prefix routes it here. */
export const AP_STATE_PREFIX = 'ap.'
export const AP_SETTINGS_PATH = '/tms/brokerage'
