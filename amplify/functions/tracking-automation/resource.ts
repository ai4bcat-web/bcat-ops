import { defineFunction } from '@aws-amplify/backend'

/**
 * Every five minutes: run the tracking automation (automatic check calls and automatic
 * POD requests) by invoking tmsTrackingActions as the `tracking-automation` system caller.
 * Every master switch is OFF until someone turns it on in Settings, so a deploy sends
 * nothing by itself.
 *
 * `schedule:` creates an EventBridge rule inside the data stack; the dev guard in
 * backend.ts disables every rule there, so on dev nothing runs on a timer — dev proves the
 * engine through RUN_TRACKING_AUTOMATION (Settings → "Run automation now").
 */
export const trackingAutomation = defineFunction({
  name: 'tracking-automation',
  entry: './handler.ts',
  resourceGroupName: 'data',
  schedule: 'every 5m',
  timeoutSeconds: 60,
  memoryMB: 256,
})
