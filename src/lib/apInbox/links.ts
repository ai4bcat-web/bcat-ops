/**
 * Step AG — the Gmail deep link stored on an item and shown as "Open in Gmail". Only opens when the
 * browser is signed into the mailbox. [INFERENCE] URL form; verify in a browser at the first live run.
 */
export function gmailMessageUrl(mailbox: string, messageId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#all/${encodeURIComponent(messageId)}`
}
