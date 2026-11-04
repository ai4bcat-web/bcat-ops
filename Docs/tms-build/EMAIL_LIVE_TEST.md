# Dev e-mail live test

## Investigation (2026-11-04, read-only AWS)

**Root cause.** Dev e-mail never reached SES. `backend.ts` (dev guard) attached an explicit IAM `Deny ses:*` on `*` to every Lambda role; an explicit deny beats the `Allow ses:SendEmail/SendRawEmail` the e-mail Lambdas also have. Confirmed on the deployed `tmsShipmentActions` role. The rate con and invoice code then recorded `NOT_SENT` with the MIME in CloudWatch, exactly as designed. Nothing was wrong on the SES side.

**SES account (us-east-1, shared with production):** sending enabled, **production access ON** (not sandbox), 50,000/24h, 14/s. Identities: `bcatcorp.com` (verified domain), `ai4bcat@gmail.com` (verified), `Ryne@bcatcorp.com` (verified), `noreply@bcatcorp.com` (FAILED, not used by dev). Dev's `tmsShipmentActions`, `tmsFinanceActions` and `tmsTrackingActions` use `FROM_ADDRESS=ai4bcat@gmail.com`, a verified identity in the same region, so no from-address change is needed and no identity was created or changed.

**Fix (repo, needs a dev deploy):** the dev deny is now conditional: `Deny ses:*` when ANY recipient (`ses:Recipients`, To/Cc/Bcc) is not `ai4bcat@gmail.com` or `ai4bcat+*@gmail.com` (`ForAnyValue:StringNotLike`). Proven with `aws iam simulate-custom-policy`: `[mailbox, mailbox+tracking]` -> allowed; `[mailbox, other]` -> explicitDeny; `[other]` -> explicitDeny. Code: `amplify/devRuleGuard.ts` (`devSesDeny`), `amplify/backend.ts`, tests in `amplify/devRuleGuard.test.ts`.

Also: `SEND_RATE_CON` now stores the SES MessageId on the `ShipmentMessage` row (`providerRef`); before it was dropped.

## Reply threading (what the code does)
- Outbound rate con carries `Reply-To: ai4bcat+tracking.<shipmentId>@gmail.com`. The Gmail bridge posts the reply to `shipment-email-intake`, which routes by that plus address (works) and the app writes an inbound `ShipmentMessage` on the same `threadKey` (`tracking+<shipmentId>`).
- **Gap:** SES overwrites the `Message-ID` header on every send, so the stored `messageId` (`<s.<shipment>.<n>.<t>@bcatcorp.com>`) is NOT what the carrier's client quotes in `In-Reply-To` (that will be `<SES MessageId@email.amazonses.com>`). The intake handler also ignores `In-Reply-To` and looks up the reply's OWN Message-ID. So a reply that loses its plus-address (some mailing lists / forwards) is not routable today. Plus-address routing is the working path. Fix, if wanted: accept `inReplyTo` in the intake and match it against `providerRef` (now stored).

## Production sending (Ryne, not done here)
Production already has SES production access and a verified `bcatcorp.com` domain. For any new sending address on that domain nothing more is needed. If DKIM/SPF/DMARC were never confirmed: in SES console > Identities > bcatcorp.com confirm DKIM "Successful" (3 CNAMEs in DNS), set a custom MAIL FROM domain (e.g. `mail.bcatcorp.com`: MX `10 feedback-smtp.us-east-1.amazonses.com` + TXT `v=spf1 include:amazonses.com ~all`), and publish `_dmarc.bcatcorp.com TXT "v=DMARC1; p=none; rua=mailto:<mailbox>"` then move to `quarantine` once reports are clean. Rate cons and invoices on prod should send from a `@bcatcorp.com` address (the code's `FROM_ADDRESS` is `ai4bcat@gmail.com`, a Gmail address, which fails DMARC alignment for strict receivers).
