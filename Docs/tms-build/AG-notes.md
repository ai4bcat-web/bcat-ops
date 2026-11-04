# Step AG — Accounting > AP inbox sync: runbook

Plan: `AG-plan.md`. Dev branch only; nothing here is deployed by the builders. Harness: `scripts/devVerifyAG.mjs`.

## 1. What it does (one paragraph)

A read-only mailbox (`ai4bcat@gmail.com`, consumer Gmail, scope `gmail.readonly`) is read once a day (Chicago run hour, default 6, with catch-up) and on **Review now** (Accounting > Accounts Payable). New mail since the cursor is funnelled (headers, then body, then one model call); only mail the model calls an invoice or credit memo is stored. A strong match (PRO or invoice # **and** carrier corroborated, score at least 0.90, high model confidence, unambiguous, no veto) fills the invoice number, dates and (placeholder bills only) the amount on the open bill and logs it with the Gmail link. Everything else lands in the **AP inbox** tab (link to a bill / create a bill / dismiss). The app never approves, pays, records or changes the status of a bill, and `Undo` (`AP_INBOX_REVERT`) restores the exact previous values while the bill is unchanged.

## 2. Connect the real mailbox (Google credential set-up)

The AP inbox reuses the one Google OAuth client. No new secret is created and nobody writes SSM by hand.

1. **Settings > Integrations > Google**: enter the Google Client ID and Client Secret (Google Cloud console, OAuth client of type *Web application*). The authorised redirect URI is the single one shown on that card: `<portal origin>/tms/rates/spot/callback`. The AP inbox uses the same URI (the callback page routes on the `ap.` prefix of the OAuth `state`).
2. In the Google Cloud console enable the **Gmail API** and add the scope `https://www.googleapis.com/auth/gmail.readonly` to the consent screen.
3. `ai4bcat@gmail.com` is a consumer account, so the consent screen is **External**. While the app is in **Testing** the account must be listed under *Test users*.
4. **Settings > General & automation > Accounting · AP inbox**: confirm the mailbox address, press **Connect Google account**, sign in as `ai4bcat@gmail.com` and accept the read-only scope. The Lambda refuses any other account, an unverified address, a missing refresh token and any scope beyond `gmail.readonly`, and writes nothing in that case.
5. Switch the card on (auto-apply is ON by default; turn it off for a queue-everything first week), then press **Review now**. The first run looks back `lookbackHours` (default 24; up to 7 days is allowed).

The refresh token lives only in SSM `/bcat/gmail/<pool>/users/ap-inbox`, written by the connect flow. No config or item row holds a token.

## 3. The 7-day Testing-mode expiry (risk K1)

A Google app in **Testing** issues refresh tokens that stop working after **7 days**. The AP inbox then shows an amber "Google no longer accepts the AP inbox connection" line on the AP page and a *Needs reconnect* pill on the settings card; runs stop without advancing the cursor, so nothing is skipped. Reconnecting (one click) resumes from the cursor, and the catch-up looks back at most 7 days.

Options for Ryne: (a) reconnect weekly (no cost); (b) publish the Google app **In production** unverified for this single user (a warning screen appears at consent; whether tokens then stop expiring is **[INFERENCE]**, confirm in the Google console); (c) switch the transport to SES inbound (not built; plan D1 escape hatch).

## 4. Dev: the simulated mailbox

On the dev stack only, the settings card has **Use simulated mailbox** (`AP_INBOX_CONNECT_SIMULATED`). Mail is injected with `AP_INBOX_SIM_INJECT` (synthetic invoices and PDFs; a `devExtraction` stored beside the message replaces the model call, only on the dev stack in simulated mode). All EventBridge rules are disabled on dev, so the hourly schedule is proven by the Lambda unit tests; the **Review now** door runs the same pipeline.

## 5. Harness

```
node --check scripts/devVerifyAG.mjs
node scripts/devVerifyAG.mjs --inventory        # no network
node scripts/devVerifyAG.mjs                    # full run, after the dev deploy
node scripts/devVerifyAG.mjs --only=AG04 --no-ui
```

Steps AG00-AG13 are listed in the file header and in plan §10. It mints three temporary identities (admin, AP-only, no AP group), builds a ZZ carrier with seven booked legs and their bills, injects 15 mail entries (14 distinct ids) and checks every outcome; AG11 (real model) skips without a usable Anthropic key. Everything it makes is `zz-ag-` / `ZZ AG`, removed in the cleanup step, which prints "NOT confirmed restored" for anything it cannot verify. Screenshots go to `Docs/tms-build/ag-proof/`.

## 6. Privacy and retention

Non-invoice mail: counters only, no row and no object. Invoice mail: one `ApInboxItem` row, at most three attachment objects and one e-mail text object under `intake-pdfs/ap-inbox/`. TTL: dismissed 30 days (objects deleted at dismiss), applied/linked/created 180 days; open items never expire. The `AuditLog` keeps ids, field names, before/after and the message link (never body text).

## 7. Merge-to-main notes

New table `ApInboxItem` (+ TTL on `ttlEpoch`), additive fields on `CarrierBill`/`VendorPayable` (`apInboxItemId`, `apInboxSourceUrl`, `apInboxAppliedAt`) and `TmsSettings` (`apInbox`, `apInboxState`), new Lambda `tms-ap-inbox` with an hourly rule and the `ANTHROPIC_API_KEY` secret, one new SSM parameter name (`…/users/ap-inbox`, created only by the connect flow). Re-run `scripts/measureDataTemplate.mjs` before merging.
