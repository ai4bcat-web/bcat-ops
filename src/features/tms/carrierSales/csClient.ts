/**
 * Step AL: typed helpers over the untyped `csAction` door (tmsSpotActions, `CS_*`).
 * The response shapes are the contract with the listener (`tms-spot-quoter/carrierInbox/actions.ts`).
 */
import { csAction } from '@/lib/apiClient'
import type { CarrierInboxConfig, CarrierInboxState } from '@/lib/carrierInbox/types'

/** `CS_STATUS` config: the voice secret hash never leaves the server; only whether one exists. */
export type CarrierInboxConfigView = Omit<CarrierInboxConfig, 'voice'> & {
  voice: Omit<CarrierInboxConfig['voice'], 'secretHash'> & { hasSecret: boolean }
}

export interface CarrierInboxStatus {
  config: CarrierInboxConfigView
  state: CarrierInboxState
  devStack: boolean
  gmailProvider: { mode: 'LIVE' | 'STUB' }
}

export const csStatus = () => csAction<CarrierInboxStatus>('CS_STATUS')
export const csPollNow = (mailboxId?: string) =>
  csAction<{ done: boolean; remaining: number }>('CS_POLL_NOW', mailboxId ? { mailboxId } : {})
export const csSaveSettings = (config: unknown, expectedVersion: number) =>
  csAction<{ config: CarrierInboxConfigView }>('CS_SAVE_SETTINGS', { config, expectedVersion })
export const csOauthStart = (mailboxId: string, redirectUri: string) =>
  csAction<{ url: string }>('CS_OAUTH_START', { mailboxId, redirectUri })
export const csOauthFinish = (code: string, state: string, redirectUri: string) =>
  csAction<{ mailboxId: string }>('CS_OAUTH_FINISH', { code, state, redirectUri })
export const csDisconnect = (mailboxId: string) => csAction<unknown>('CS_DISCONNECT', { mailboxId })
export const csSetPaused = (mailboxId: string, paused: boolean) => csAction<unknown>('CS_SET_PAUSED', { mailboxId, paused })
export const csRotateVoiceSecret = () => csAction<{ secret: string }>('CS_VOICE_ROTATE_SECRET')
export const csConnectSimulated = (mailboxId: string) => csAction<unknown>('CS_CONNECT_SIMULATED', { mailboxId })
export const csSimInjectMail = (mailboxId: string, fixtureId: string) =>
  csAction<unknown>('CS_SIM_INJECT_MAIL', { mailboxId, fixtureId })
export const csSimInjectCall = (fixtureId: string) => csAction<unknown>('CS_SIM_INJECT_CALL', { fixtureId })
export const csSimReset = (mailboxId?: string) => csAction<unknown>('CS_SIM_RESET', mailboxId ? { mailboxId } : {})

/** The one OAuth return path (shared with the spot inbox); the `cs.` state prefix routes it here. */
export const CS_SETTINGS_PATH = '/tms/brokerage/carrier-sales'
export const CS_STATE_PREFIX = 'cs.'
