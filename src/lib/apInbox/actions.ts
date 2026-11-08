/**
 * Step AG §4 — the router actions of `tmsApInboxActions`, name → { who, read }. The browser and the
 * Lambda share this list; input/output shapes are typed in `tmsApInboxActions` consumers (S4/S5).
 * `read: true` actions are classified as reads by `apiClient.ts` (the `AP_INBOX_` prefix + verb regex).
 */
export type ApInboxWho = 'AP_USER' | 'ADMIN' | 'ADMIN_DEV'

export const AP_INBOX_ACTIONS = {
  AP_INBOX_STATUS: { who: 'AP_USER', read: true },
  AP_INBOX_PREVIEW_LINK: { who: 'AP_USER', read: true },
  AP_INBOX_SYNC_NOW: { who: 'AP_USER', read: false },
  AP_INBOX_LINK: { who: 'AP_USER', read: false },
  AP_INBOX_MARK_CREATED: { who: 'AP_USER', read: false },
  AP_INBOX_CREATE_VENDOR_BILL: { who: 'AP_USER', read: false },
  AP_INBOX_DISMISS: { who: 'AP_USER', read: false },
  AP_INBOX_REVERT: { who: 'AP_USER', read: false },
  AP_INBOX_SAVE_SETTINGS: { who: 'ADMIN', read: false },
  AP_INBOX_OAUTH_START: { who: 'ADMIN', read: false },
  AP_INBOX_OAUTH_FINISH: { who: 'ADMIN', read: false },
  AP_INBOX_OAUTH_DISCONNECT: { who: 'ADMIN', read: false },
  AP_INBOX_CONNECT_SIMULATED: { who: 'ADMIN_DEV', read: false },
  AP_INBOX_SIM_INJECT: { who: 'ADMIN_DEV', read: false },
  AP_INBOX_SIM_RESET: { who: 'ADMIN_DEV', read: false },
  AP_INBOX_SIM_PURGE_TEST: { who: 'ADMIN_DEV', read: false },
} as const satisfies Record<string, { who: ApInboxWho; read: boolean }>

export type ApInboxAction = keyof typeof AP_INBOX_ACTIONS

export const AP_INBOX_ACTION_NAMES = Object.keys(AP_INBOX_ACTIONS) as ApInboxAction[]
