import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * tms-directory-actions Lambda — custom AppSync mutation `tmsDirectoryActions(action, input)`.
 *
 * Centralized writer for Phase 1 directory, config, and load merge actions.
 * Writes to Customer/Location/Division/TmsSettings/DirectoryMergeJob via DynamoDB SDK;
 * Load repoints during merge use the generated AppSync mutation so subscriptions fire.
 *
 * Step J adds the integration framework (see `integrations.ts`). The eight stack
 * secrets below are here so `VALIDATE_INTEGRATION` can prove a STACK credential
 * with the provider's own read call rather than by invoking the Lambda that owns
 * it. They are never written from the app: rotation stays `npx ampx secret set`,
 * and on the dev stack the Aspect in backend.ts pins the side-effecting ones to
 * the literal `disabled-on-dev` — which is what makes the dev badge truthful.
 */
export const tmsDirectoryActions = defineFunction({
  name: 'tms-directory-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    GEOCODE_TOKEN_SECRET: secret('GEOCODE_TOKEN_SECRET'),
    OTR_USERNAME: secret('OTR_USERNAME'),
    OTR_PASSWORD: secret('OTR_PASSWORD'),
    OTR_SUBSCRIPTION_KEY: secret('OTR_SUBSCRIPTION_KEY'),
    MOTIVE_API_KEY: secret('MOTIVE_API_KEY'),
    BLUE_INK_TECH_API_KEY: secret('BLUE_INK_TECH_API_KEY'),
    GOOGLE_MAPS_API_KEY: secret('GOOGLE_MAPS_API_KEY'),
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
    // Named by the registry, so without them `missingCredentials` would tell Ryne
    // to set secrets the stack already holds, and Slack could never reach LIVE.
    SLACK_SIGNING_SECRET: secret('SLACK_SIGNING_SECRET'),
    SLACK_CHANNEL_MAPPING: secret('SLACK_CHANNEL_MAPPING'),
    PAYCHEX_CLIENT_ID: secret('PAYCHEX_CLIENT_ID'),
    PAYCHEX_CLIENT_SECRET: secret('PAYCHEX_CLIENT_SECRET'),
  },
})
