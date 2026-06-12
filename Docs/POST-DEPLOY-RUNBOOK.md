# Post-deploy runbook — DOT compliance & onboarding

Everything in code is live after the `main` Amplify build. These are the operator
steps (AWS Console / DNS / in-app) to finish turning the system on. Do them in order;
steps 1–2 share one redeploy.

---

## 0. Find your deploy outputs

The portal URL and SES DKIM records are emitted as **CloudFormation stack outputs**
(not in `amplify_outputs.json`).

1. AWS Console → **CloudFormation** → same region as the app.
2. Find the stacks for this Amplify app/branch (names contain `amplify-` and your app id / `main`).
3. Open each stack → **Outputs** tab. Look for:
   - `OnboardingPortalApiFunctionUrl`
   - `SesDkimRecord1`, `SesDkimRecord2`, `SesDkimRecord3`, `SesMailFromNote`

Keep these values handy.

---

## 1. Point the portal at the real API (`VITE_ONBOARDING_API_URL`)

Until this is set, the driver portal runs on **mock data**.

1. Copy the value of `OnboardingPortalApiFunctionUrl`
   (looks like `https://abc123....lambda-url.us-east-1.on.aws/`).
2. Amplify Console → your app → **Hosting → Environment variables** (App settings).
3. Add: **`VITE_ONBOARDING_API_URL`** = that URL. Apply to the `main` branch.
4. Leave it — you'll redeploy once after step 2.

> It's a Vite build-time var (must be `VITE_`-prefixed); it's inlined at build, so a
> redeploy is required for it to take effect.

---

## 2. Lock CORS to your real domain (`PORTAL_PROD_ORIGIN`)

The backend defaults this to `https://ops.bcatcorp.com`. Set it to wherever the app is
actually served (the origin where drivers open `/onboard/:token`) — e.g. your Amplify
domain `https://main.<appid>.amplifyapp.com` or your custom domain.

1. Amplify Console → **Environment variables** → add
   **`PORTAL_PROD_ORIGIN`** = `https://your-real-prod-domain`.
2. **Redeploy `main`** (Amplify Console → branch → **Redeploy this version**, or push a
   commit). This single redeploy applies both step 1 and step 2:
   - frontend picks up `VITE_ONBOARDING_API_URL`
   - backend resynths the Function URL CORS + Lambda `ALLOWED_ORIGINS` + scanner
     `PORTAL_BASE_URL` from `PORTAL_PROD_ORIGIN`.

> The Function URL value is stable across redeploys, so the value you set in step 1
> won't change.

---

## 3. Verify the SES sending domain (bcatcorp.com)

Emails won't send until the domain is verified. (Both kill switches are PAUSED, so
nothing tries to send before you're ready.)

1. **Add DNS records** to `bcatcorp.com` (your DNS host / registrar). From the
   CloudFormation outputs:
   - `SesDkimRecord1`, `2`, `3` → each is a line `<name> CNAME <value>`. Add **3 CNAME**
     records:
     | Type  | Name (host)                        | Value                          |
     |-------|------------------------------------|--------------------------------|
     | CNAME | `<token1>._domainkey.bcatcorp.com` | `<token1>.dkim.amazonses.com`  |
     | CNAME | `<token2>._domainkey.bcatcorp.com` | `<token2>.dkim.amazonses.com`  |
     | CNAME | `<token3>._domainkey.bcatcorp.com` | `<token3>.dkim.amazonses.com`  |
   - **SPF (TXT)** on `bcatcorp.com`: `v=spf1 include:amazonses.com ~all`
   - *(recommended)* **DMARC (TXT)** on `_dmarc.bcatcorp.com`:
     `v=DMARC1; p=none; rua=mailto:dmarc@bcatcorp.com`
2. Wait for propagation. SES → **Verified identities → bcatcorp.com** flips to
   **Verified** automatically (usually < 1–72h).
3. **Leave the SES sandbox**: SES → **Account dashboard → Request production access**.
   In sandbox you can only email **verified** addresses — verify your own inbox first
   for testing (SES → Verified identities → Create identity → email).

(Reference: `Docs/SES-ONBOARDING-DNS.md`.)

---

## 4. Turn email on (the two kill switches)

Both default **PAUSED** so you can verify templates first.

1. In the app: **/compliance → Email settings** card.
2. Verify a template safely while still paused/sandboxed:
   - Create a test driver whose email is a **verified** SES identity, run **Start
     onboarding**, and confirm the link/copy looks right (the "send" no-ops while paused,
     but you can copy the link).
3. Flip **Driver portal emails** to **LIVE** when ready (invites/rejections/completions).
4. Flip **Expiration escalation emails** to **LIVE** separately when ready.
5. Set **Manager recipients** (same card) for escalation emails (e.g. `ops@bcatcorp.com`).

> They're independent — you can go live on portal emails while keeping escalation paused,
> or vice-versa.

---

## 5. Sanity-check the scanner before trusting the daily cron

The `compliance-scanner` runs daily ~6:00 AM America/Chicago. To preview with no writes:

1. AWS Console → **Lambda** → find the function (name contains `compliance-scanner`).
2. **Test** tab → new event:
   ```json
   { "asOf": "2026-06-12", "dryRun": true }
   ```
3. Run it. The response/`logs` show the planned alert creates/updates/resolves, doc
   status transitions, and entity-status recomputes — **without writing anything**.
4. When it looks right, drop `dryRun` (or just let the daily schedule run).

> `dryRun` also skips escalation sends, so it's always safe.

---

## 6. Classify the existing fleet, then backfill checklists

New drivers/trucks get a checklist at onboarding. For your **current** fleet:

1. **Classify drivers** (one-time): `/drivers` → edit each → **Driver Type** =
   Company Driver / Owner-Operator. (Unclassified drivers are skipped by the backfill.)
   Trucks are auto-classified from `Equipment.ownership`.
2. **Run the backfill** (owner only): **/compliance → Backfill onboarding checklists →
   Generate checklists**. It creates **internal-only** checklists (no invites), is
   idempotent, and reports how many drivers/trucks were processed and how many were
   skipped as unclassified.
3. To invite a driver to the portal afterward, use **/drivers → (shield icon) →
   Start onboarding** and choose *Create invite* instead of *Internal only*.

> The backfill card ships in commit `c64e2d7`, which is **not yet pushed** — it deploys
> on your next `main` push.

---

## Dependency order (quick view)

```
deploy main ─► get CFN outputs (0)
                 ├─► set VITE_ONBOARDING_API_URL (1) ┐
                 ├─► set PORTAL_PROD_ORIGIN (2)       ├─► one redeploy
                 └─► add SES DNS + verify (3) ───────► request prod access
                                                         └─► flip kill switches (4)
classify drivers (6a) ─► run backfill (6b)
scanner dry-run (5) ─► trust daily cron
```
