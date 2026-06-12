# SES sending-domain DNS records (bcatcorp.com)

The onboarding emails (driver invites, rejections, completion, and the Phase 4
escalation reminders) send from **onboarding@bcatcorp.com** via Amazon SES.

The backend (`amplify/backend.ts`) creates an SES **domain identity** for
`bcatcorp.com` with Easy DKIM. SES generates the exact record **values** at deploy
time, so they cannot be hard-coded here — add them after `ampx`/Amplify deploys.

## Where to get the values

After deploying, the CloudFormation/Amplify outputs include:

- `SesDkimRecord1`, `SesDkimRecord2`, `SesDkimRecord3` — each is a line of the form
  `<name> CNAME <value>` (the three Easy-DKIM CNAMEs).
- `SesMailFromNote` — reminder about the SPF record.

You can also read them in the **SES console → Verified identities → bcatcorp.com →
Authentication**.

## Records to add to bcatcorp.com DNS

1. **3 × DKIM CNAME** (from `SesDkimRecord1..3`):

   | Type  | Name (host)                          | Value                                  |
   |-------|--------------------------------------|----------------------------------------|
   | CNAME | `<token1>._domainkey.bcatcorp.com`   | `<token1>.dkim.amazonses.com`          |
   | CNAME | `<token2>._domainkey.bcatcorp.com`   | `<token2>.dkim.amazonses.com`          |
   | CNAME | `<token3>._domainkey.bcatcorp.com`   | `<token3>.dkim.amazonses.com`          |

2. **SPF (TXT)** on the MAIL FROM / domain:

   | Type | Name           | Value                              |
   |------|----------------|------------------------------------|
   | TXT  | `bcatcorp.com` | `v=spf1 include:amazonses.com ~all` |

3. *(Recommended)* **DMARC (TXT)**:

   | Type | Name                  | Value                                          |
   |------|-----------------------|------------------------------------------------|
   | TXT  | `_dmarc.bcatcorp.com` | `v=DMARC1; p=none; rua=mailto:dmarc@bcatcorp.com` |

## Verification

Once the DKIM CNAMEs propagate, SES flips the identity to **Verified** automatically
(usually < 72h). Until then, sends will fail — which is fine because **both email
kill switches default to PAUSED** (`ComplianceSettings.portalEmailsPaused` and
`escalationEmailsPaused`). Verify the domain, send yourself test emails, then flip
the switches on `/compliance` → **Email settings**.

> Until the SES account is out of the sandbox, you can only send to verified
> recipient addresses. Request production access in the SES console when ready.
