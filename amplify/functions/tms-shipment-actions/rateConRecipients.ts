import { dedupeEmails, emailKey, isEmailAddress } from '../../../src/lib/emailAddress'

/**
 * Final recipient lists for a rate-con email. Cc order: tracking mailbox, typed cc
 * (in order), then the sender (only when its address is valid). Case-insensitive,
 * first spelling wins; anything in `to` is dropped from `cc` so nobody is mailed twice.
 */
export function composeRateConCc(args: {
  to: string[]
  extraCc: string[]
  tracking: string
  sender: string | null
}): { to: string[]; cc: string[]; senderCopied: boolean } {
  const to = dedupeEmails(args.to)
  const inTo = new Set(to.map(emailKey))
  const sender = args.sender !== null && isEmailAddress(args.sender) ? args.sender : null
  const cc = dedupeEmails([args.tracking, ...args.extraCc, ...(sender ? [sender] : [])]).filter(
    (e) => !inTo.has(emailKey(e)),
  )
  const senderCopied = sender !== null && cc.some((e) => emailKey(e) === emailKey(sender))
  return { to, cc, senderCopied }
}
